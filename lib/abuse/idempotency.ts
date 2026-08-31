import { createHash, randomUUID } from "node:crypto";
import {
  type IdempotencyResponseStorage,
  type JsonValue,
  plaintextIdempotencyResponseStorage,
  type StoredIdempotencyResponseEnvelope,
} from "./idempotency-response";

export const IDEMPOTENCY_CLAIM_TTL_MS = 5 * 60_000;
const CLEANUP_LIMIT = 100;
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{16,128}$/;
const IDEMPOTENCY_CLAIM_RENEWAL_MS = IDEMPOTENCY_CLAIM_TTL_MS / 2;

export type { JsonValue } from "./idempotency-response";

export type IdempotencyResponse = {
  body: JsonValue;
  status: number;
};

export type StoredIdempotencyResponse = {
  envelope: StoredIdempotencyResponseEnvelope;
  status: number;
};

export type IdempotencyClaimInput = {
  claimExpiresAt: Date;
  keyHash: string;
  now: Date;
  operation: string;
  ownerToken?: string;
  ownerId: string;
  reclaimCompleted?: boolean;
  requestHash: string;
};

export type IdempotencyClaimHandle = Omit<
  IdempotencyClaimInput,
  "now" | "reclaimCompleted"
> & {
  recordId?: string;
};

export type IdempotencyClaimResult =
  | { claim: IdempotencyClaimHandle; kind: "claimed" }
  | { kind: "completed"; response: StoredIdempotencyResponse }
  | { kind: "conflict" }
  | { kind: "in_progress" };

export type IdempotencyCompleteInput = {
  claim: IdempotencyClaimHandle;
  completedAt: Date;
  expiresAt: Date;
  response: StoredIdempotencyResponse;
};

export type IdempotencyReleaseInput = {
  claim: IdempotencyClaimHandle;
};

export type IdempotencyRenewInput = {
  claim: IdempotencyClaimHandle;
  claimExpiresAt: Date;
  now: Date;
};

export type IdempotencyRenewResult =
  | { kind: "lost" }
  | { claim: IdempotencyClaimHandle; kind: "renewed" };

export type IdempotencyCompletionResult =
  | "completed"
  | "lost"
  | { kind: "replayed"; response: StoredIdempotencyResponse };

export interface IdempotencyStore {
  claim: (input: IdempotencyClaimInput) => Promise<IdempotencyClaimResult>;
  cleanupExpired: (input: { before: Date; limit: number }) => Promise<void>;
  complete: (input: IdempotencyCompleteInput) => Promise<"completed" | "lost">;
  release: (input: IdempotencyReleaseInput) => Promise<"lost" | "released">;
  renew?: (input: IdempotencyRenewInput) => Promise<IdempotencyRenewResult>;
}

export type IdempotencyTimers = {
  clearTimeout: (timer: unknown) => void;
  setTimeout: (callback: () => Promise<void>, delayMs: number) => unknown;
};

export type IdempotencyResult =
  | { kind: "conflict" }
  | { kind: "in_progress" }
  | { kind: "invalid_key" }
  | { kind: "missing_key" }
  | {
      kind: "response";
      replayed: boolean;
      response: IdempotencyResponse;
    };

const SYSTEM_TIMERS: IdempotencyTimers = {
  clearTimeout: (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  setTimeout(callback, delayMs) {
    const timer = globalThis.setTimeout(() => {
      callback().catch(() => undefined);
    }, delayMs);
    timer.unref();
    return timer;
  },
};

export async function runIdempotentOperation(options: {
  cacheSuccessfulResponse?: boolean;
  claimLease?: {
    createOwnerToken?: () => string;
    timers?: IdempotencyTimers;
  };
  completeSuccessfulResponse?: (
    input: IdempotencyCompleteInput
  ) => Promise<IdempotencyCompletionResult>;
  idempotencyKey: string | null;
  now?: () => Date;
  operation: string;
  ownerId: string;
  perform: (input: {
    providerIdempotencyKey: string;
  }) => Promise<IdempotencyResponse>;
  request: JsonValue;
  responseStorage?: IdempotencyResponseStorage;
  retentionMs: number;
  shouldCacheResponse?: (response: IdempotencyResponse) => boolean;
  store: IdempotencyStore;
}): Promise<IdempotencyResult> {
  if (options.idempotencyKey === null) {
    return { kind: "missing_key" };
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)) {
    return { kind: "invalid_key" };
  }
  if (!Number.isFinite(options.retentionMs) || options.retentionMs <= 0) {
    throw new RangeError("retentionMs must be finite and positive");
  }

  const now = options.now ?? (() => new Date());
  const claimedAt = now();
  assertValidDate(claimedAt);

  const keyHash = sha256(options.idempotencyKey);
  const requestHash = sha256(canonicalJson(options.request));
  const claimExpiresAt = claimExpiry(claimedAt);
  await options.store.cleanupExpired({
    before: claimedAt,
    limit: CLEANUP_LIMIT,
  });
  const claimResult = await options.store.claim({
    claimExpiresAt,
    keyHash,
    now: claimedAt,
    operation: options.operation,
    ...(options.claimLease
      ? {
          ownerToken: (options.claimLease.createOwnerToken ?? randomUUID)(),
        }
      : {}),
    ownerId: options.ownerId,
    ...(options.cacheSuccessfulResponse === false
      ? { reclaimCompleted: true }
      : {}),
    requestHash,
  });

  if (claimResult.kind === "completed") {
    const body = await (
      options.responseStorage ?? plaintextIdempotencyResponseStorage
    ).replay(claimResult.response.envelope, {
      keyHash,
      operation: options.operation,
      ownerId: options.ownerId,
    });
    return {
      kind: "response",
      replayed: true,
      response: { body, status: claimResult.response.status },
    };
  }
  if (claimResult.kind !== "claimed") {
    return claimResult;
  }

  let { claim } = claimResult;
  let claimLost = false;
  let renewalError: unknown;
  let renewalInFlight: Promise<void> | null = null;
  let stopped = false;
  let timer: unknown;
  const timers = options.claimLease?.timers ?? SYSTEM_TIMERS;
  const renew = async () => {
    if (!options.claimLease || !options.store.renew) {
      return;
    }
    try {
      const renewedAt = now();
      assertValidDate(renewedAt);
      const result = await options.store.renew({
        claim,
        claimExpiresAt: claimExpiry(renewedAt),
        now: renewedAt,
      });
      if (result.kind === "lost") {
        claimLost = true;
        return;
      }
      ({ claim } = result);
    } catch (error) {
      renewalError = error;
    }
  };
  const scheduleRenewal = () => {
    if (
      !options.claimLease ||
      stopped ||
      claimLost ||
      renewalError !== undefined
    ) {
      return;
    }
    timer = timers.setTimeout(async () => {
      if (stopped) {
        return;
      }
      renewalInFlight = renew();
      await renewalInFlight;
      renewalInFlight = null;
      scheduleRenewal();
    }, IDEMPOTENCY_CLAIM_RENEWAL_MS);
  };
  const stopRenewal = async () => {
    stopped = true;
    if (timer !== undefined) {
      timers.clearTimeout(timer);
    }
    await renewalInFlight;
  };

  if (options.claimLease && !options.store.renew) {
    await options.store.release({ claim });
    throw new Error("Renewable idempotency claims require store.renew.");
  }
  scheduleRenewal();

  const providerIdempotencyKey = `coven_${sha256(
    ["provider", options.ownerId, options.operation, keyHash, requestHash].join(
      "\0"
    )
  )}`;

  let response: IdempotencyResponse;
  try {
    response = await options.perform({ providerIdempotencyKey });
  } catch (error) {
    await stopRenewal();
    await options.store.release({ claim });
    throw error;
  }

  await stopRenewal();
  if (renewalError !== undefined) {
    await options.store.release({ claim });
    throw renewalError;
  }
  if (options.claimLease && !claimLost) {
    await renew();
  }
  if (renewalError !== undefined) {
    await options.store.release({ claim });
    throw renewalError;
  }
  if (claimLost) {
    await options.store.release({ claim });
    return { kind: "in_progress" };
  }

  let shouldCacheResponse =
    response.status >= 200 &&
    response.status < 300 &&
    options.cacheSuccessfulResponse !== false;
  try {
    shouldCacheResponse =
      shouldCacheResponse && (options.shouldCacheResponse?.(response) ?? true);
  } catch (error) {
    await options.store.release({ claim });
    throw error;
  }

  if (!shouldCacheResponse) {
    const releaseResult = await options.store.release({ claim });
    if (releaseResult === "lost") {
      return { kind: "in_progress" };
    }
    return { kind: "response", replayed: false, response };
  }

  const completedAt = now();
  assertValidDate(completedAt);
  try {
    const envelope = await (
      options.responseStorage ?? plaintextIdempotencyResponseStorage
    ).store(response.body, {
      keyHash,
      operation: options.operation,
      ownerId: options.ownerId,
    });
    const completion = {
      claim,
      completedAt,
      expiresAt: new Date(completedAt.getTime() + options.retentionMs),
      response: { envelope, status: response.status },
    };
    const completeResult = options.completeSuccessfulResponse
      ? await options.completeSuccessfulResponse(completion)
      : await options.store.complete(completion);
    if (completeResult === "lost") {
      return { kind: "in_progress" };
    }
    if (typeof completeResult === "object") {
      const replayedBody = await (
        options.responseStorage ?? plaintextIdempotencyResponseStorage
      ).replay(completeResult.response.envelope, {
        keyHash,
        operation: options.operation,
        ownerId: options.ownerId,
      });
      return {
        kind: "response",
        replayed: true,
        response: {
          body: replayedBody,
          status: completeResult.response.status,
        },
      };
    }
  } catch (error) {
    await options.store.release({ claim });
    throw error;
  }

  return { kind: "response", replayed: false, response };
}

function claimExpiry(now: Date): Date {
  return new Date(now.getTime() + IDEMPOTENCY_CLAIM_TTL_MS);
}

export function idempotencyResultResponse(result: IdempotencyResult): Response {
  const headers = new Headers({ "cache-control": "no-store" });

  if (result.kind === "response") {
    if (result.replayed) {
      headers.set("idempotency-replayed", "true");
    }
    return Response.json(result.response.body, {
      headers,
      status: result.response.status,
    });
  }

  const errorByKind = {
    conflict: "idempotency_conflict",
    in_progress: "request_in_progress",
    invalid_key: "invalid_idempotency_key",
    missing_key: "idempotency_key_required",
  } as const;
  return Response.json(
    { error: errorByKind[result.kind] },
    {
      headers,
      status:
        result.kind === "conflict" || result.kind === "in_progress" ? 409 : 400,
    }
  );
}

function canonicalJson(value: JsonValue): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Idempotency requests must contain finite numbers.");
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(
            (value as Record<string, JsonValue>)[key]
          )}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertValidDate(value: Date): void {
  if (Number.isNaN(value.getTime())) {
    throw new RangeError("now must return a valid Date");
  }
}
