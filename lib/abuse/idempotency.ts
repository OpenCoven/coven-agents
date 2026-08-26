import { createHash } from "node:crypto";
import {
  type IdempotencyResponseStorage,
  type JsonValue,
  plaintextIdempotencyResponseStorage,
  type StoredIdempotencyResponseEnvelope,
} from "./idempotency-response";

const CLAIM_TTL_MS = 5 * 60_000;
const CLEANUP_LIMIT = 100;
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{16,128}$/;

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
  ownerId: string;
  requestHash: string;
};

export type IdempotencyClaimHandle = Omit<IdempotencyClaimInput, "now">;

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

export interface IdempotencyStore {
  claim: (input: IdempotencyClaimInput) => Promise<IdempotencyClaimResult>;
  cleanupExpired: (input: { before: Date; limit: number }) => Promise<void>;
  complete: (input: IdempotencyCompleteInput) => Promise<void>;
  release: (input: IdempotencyReleaseInput) => Promise<void>;
}

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

export async function runIdempotentOperation(options: {
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
  const claimExpiresAt = new Date(claimedAt.getTime() + CLAIM_TTL_MS);
  await options.store.cleanupExpired({
    before: claimedAt,
    limit: CLEANUP_LIMIT,
  });
  const claimResult = await options.store.claim({
    claimExpiresAt,
    keyHash,
    now: claimedAt,
    operation: options.operation,
    ownerId: options.ownerId,
    requestHash,
  });

  if (claimResult.kind === "completed") {
    const body = await (
      options.responseStorage ?? plaintextIdempotencyResponseStorage
    ).replay(claimResult.response.envelope, {
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

  const providerIdempotencyKey = `coven_${sha256(
    ["provider", options.ownerId, options.operation, keyHash, requestHash].join(
      "\0"
    )
  )}`;

  let response: IdempotencyResponse;
  try {
    response = await options.perform({ providerIdempotencyKey });
  } catch (error) {
    await options.store.release({ claim: claimResult.claim });
    throw error;
  }

  if (response.status < 200 || response.status >= 300) {
    await options.store.release({ claim: claimResult.claim });
    return { kind: "response", replayed: false, response };
  }

  const completedAt = now();
  assertValidDate(completedAt);
  try {
    const envelope = await (
      options.responseStorage ?? plaintextIdempotencyResponseStorage
    ).store(response.body, {
      operation: options.operation,
      ownerId: options.ownerId,
    });
    await options.store.complete({
      claim: claimResult.claim,
      completedAt,
      expiresAt: new Date(completedAt.getTime() + options.retentionMs),
      response: { envelope, status: response.status },
    });
  } catch (error) {
    await options.store.release({ claim: claimResult.claim });
    throw error;
  }

  return { kind: "response", replayed: false, response };
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
