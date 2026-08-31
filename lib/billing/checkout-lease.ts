import { createHash, randomUUID } from "node:crypto";

export const CHECKOUT_ATTEMPT_LEASE_TTL_MS = 5 * 60_000;
export const CHECKOUT_ATTEMPT_OPERATION = "checkout-attempt";
export const CHECKOUT_ATTEMPT_KEY_HASH = createHash("sha256")
  .update("checkout-attempt-lease", "utf8")
  .digest("hex");
const CHECKOUT_ATTEMPT_RENEWAL_MS = CHECKOUT_ATTEMPT_LEASE_TTL_MS / 2;

export type CheckoutAttemptLease = {
  attemptId: string;
  attemptState: CheckoutAttemptState;
  expiresAt: Date;
  ownerId: string;
  ownerToken: string;
};

export type CheckoutAttemptStableState =
  | { kind: "create_uncertain" }
  | { customerId: string; kind: "customer_created" }
  | { kind: "fresh" }
  | { kind: "session_created"; sessionId: string };

export type CheckoutExpirationCleanupKind = "blocking" | "obsolete";

type CheckoutExpirationAttempt = {
  cleanupKind: CheckoutExpirationCleanupKind;
  customerId: string;
  expirationIdempotencyKey: string;
  resumeState: CheckoutAttemptStableState;
  sessionId: string;
};

export type CheckoutAttemptState =
  | CheckoutAttemptStableState
  | (CheckoutExpirationAttempt & { kind: "expiration_in_flight" })
  | (CheckoutExpirationAttempt & {
      kind: "expiration_confirmed";
      terminalStatus: "complete" | "expired";
    });

export type CheckoutAttemptLeaseClaimInput = {
  leaseExpiresAt: Date;
  now: Date;
  ownerId: string;
  ownerToken: string;
};

export type CheckoutAttemptLeaseClaimResult =
  | { kind: "claimed"; lease: CheckoutAttemptLease }
  | { kind: "in_progress" };

export type CheckoutAttemptLeaseRenewInput = {
  lease: CheckoutAttemptLease;
  leaseExpiresAt: Date;
  now: Date;
};

export type CheckoutAttemptLeaseRenewResult =
  | { kind: "lost" }
  | { kind: "renewed"; lease: CheckoutAttemptLease };

export type CheckoutAttemptLeaseReleaseInput = {
  disposition:
    | { kind: "preserve_attempt"; state: CheckoutAttemptState }
    | { kind: "retire_attempt" };
  lease: CheckoutAttemptLease;
  releasedAt: Date;
};

export type CheckoutAttemptLeaseReleaseResult = "lost" | "released";

export type CheckoutAttemptLeaseCheckpointInput = {
  lease: CheckoutAttemptLease;
  leaseExpiresAt: Date;
  state: CheckoutAttemptState;
  updatedAt: Date;
};

export type CheckoutAttemptLeaseCheckpointResult =
  | { kind: "lost" }
  | { kind: "checkpointed"; lease: CheckoutAttemptLease };

export interface CheckoutAttemptLeaseStore {
  checkpoint: (
    input: CheckoutAttemptLeaseCheckpointInput
  ) => Promise<CheckoutAttemptLeaseCheckpointResult>;
  claim: (
    input: CheckoutAttemptLeaseClaimInput
  ) => Promise<CheckoutAttemptLeaseClaimResult>;
  release: (
    input: CheckoutAttemptLeaseReleaseInput
  ) => Promise<CheckoutAttemptLeaseReleaseResult>;
  renew: (
    input: CheckoutAttemptLeaseRenewInput
  ) => Promise<CheckoutAttemptLeaseRenewResult>;
}

export type CheckoutLeaseTimers = {
  clearTimeout: (timer: unknown) => void;
  setTimeout: (callback: () => Promise<void>, delayMs: number) => unknown;
};

type CheckoutAttemptWork<T> =
  | {
      disposition: "preserve_attempt";
      state: CheckoutAttemptState;
      value: T;
    }
  | {
      disposition: "retire_attempt";
      value: T;
    };

export type CheckoutAttemptLeaseResult<T> =
  | { kind: "in_progress" }
  | { kind: "lease_lost" }
  | { kind: "performed"; value: T };

const SYSTEM_TIMERS: CheckoutLeaseTimers = {
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

export async function runWithCheckoutAttemptLease<T>(options: {
  createOwnerToken?: () => string;
  now?: () => Date;
  ownerId: string;
  perform: (input: {
    attemptId: string;
    attemptState: CheckoutAttemptState;
    checkpoint: (state: CheckoutAttemptState) => Promise<void>;
    expirationIdempotencyKey: (sessionId: string) => string;
    providerIdempotencyKey: string;
  }) => Promise<CheckoutAttemptWork<T>>;
  store: CheckoutAttemptLeaseStore;
  timers?: CheckoutLeaseTimers;
}): Promise<CheckoutAttemptLeaseResult<T>> {
  const now = options.now ?? (() => new Date());
  const claimedAt = validNow(now);
  const claimResult = await options.store.claim({
    leaseExpiresAt: leaseExpiry(claimedAt),
    now: claimedAt,
    ownerId: options.ownerId,
    ownerToken: (options.createOwnerToken ?? randomUUID)(),
  });
  if (claimResult.kind === "in_progress") {
    return claimResult;
  }

  let { lease } = claimResult;
  let leaseLost = false;
  let renewalError: unknown;
  let renewalInFlight: Promise<void> | null = null;
  let leaseMutation = Promise.resolve();
  let stopped = false;
  let timer: unknown;
  const timers = options.timers ?? SYSTEM_TIMERS;

  const withLeaseMutation = <Result>(
    operation: () => Promise<Result>
  ): Promise<Result> => {
    const result = leaseMutation.then(operation, operation);
    leaseMutation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const scheduleRenewal = () => {
    if (stopped || leaseLost || renewalError !== undefined) {
      return;
    }
    timer = timers.setTimeout(async () => {
      if (stopped) {
        return;
      }
      renewalInFlight = withLeaseMutation(renew);
      await renewalInFlight;
      renewalInFlight = null;
      scheduleRenewal();
    }, CHECKOUT_ATTEMPT_RENEWAL_MS);
  };

  const renew = async () => {
    try {
      const renewedAt = validNow(now);
      const result = await options.store.renew({
        lease,
        leaseExpiresAt: leaseExpiry(renewedAt),
        now: renewedAt,
      });
      if (result.kind === "lost") {
        leaseLost = true;
        return;
      }
      ({ lease } = result);
    } catch (error) {
      renewalError = error;
    }
  };

  const stopRenewal = async () => {
    stopped = true;
    if (timer !== undefined) {
      timers.clearTimeout(timer);
    }
    await renewalInFlight;
  };

  const checkpoint = (state: CheckoutAttemptState) =>
    withLeaseMutation(async () => {
      if (leaseLost) {
        throw new CheckoutAttemptLeaseLostError();
      }
      const updatedAt = validNow(now);
      const result = await options.store.checkpoint({
        lease,
        leaseExpiresAt: leaseExpiry(updatedAt),
        state,
        updatedAt,
      });
      if (result.kind === "lost") {
        leaseLost = true;
        throw new CheckoutAttemptLeaseLostError();
      }
      ({ lease } = result);
    });

  scheduleRenewal();

  let work: CheckoutAttemptWork<T>;
  try {
    const providerIdempotencyKey = checkoutProviderIdempotencyKey(
      options.ownerId,
      lease.attemptId
    );
    work = await options.perform({
      attemptId: lease.attemptId,
      attemptState: lease.attemptState,
      checkpoint,
      expirationIdempotencyKey: (sessionId) =>
        checkoutExpirationIdempotencyKey(providerIdempotencyKey, sessionId),
      providerIdempotencyKey,
    });
  } catch (error) {
    await stopRenewal();
    await options.store.release({
      disposition: {
        kind: "preserve_attempt",
        state: lease.attemptState,
      },
      lease,
      releasedAt: validNow(now),
    });
    if (error instanceof CheckoutAttemptLeaseLostError) {
      return { kind: "lease_lost" };
    }
    throw error;
  }

  await stopRenewal();
  if (renewalError !== undefined) {
    await options.store.release({
      disposition: {
        kind: "preserve_attempt",
        state: lease.attemptState,
      },
      lease,
      releasedAt: validNow(now),
    });
    throw renewalError;
  }
  if (!leaseLost) {
    await renew();
  }
  if (renewalError !== undefined) {
    await options.store.release({
      disposition: {
        kind: "preserve_attempt",
        state: lease.attemptState,
      },
      lease,
      releasedAt: validNow(now),
    });
    throw renewalError;
  }
  if (leaseLost) {
    await options.store.release({
      disposition: {
        kind: "preserve_attempt",
        state: lease.attemptState,
      },
      lease,
      releasedAt: validNow(now),
    });
    return { kind: "lease_lost" };
  }

  const releaseResult = await options.store.release({
    disposition:
      work.disposition === "preserve_attempt"
        ? { kind: "preserve_attempt", state: work.state }
        : { kind: "retire_attempt" },
    lease,
    releasedAt: validNow(now),
  });
  if (releaseResult === "lost") {
    return { kind: "lease_lost" };
  }
  return { kind: "performed", value: work.value };
}

export function parseCheckoutAttemptState(
  storedState: string
): CheckoutAttemptState {
  const ownedPrefix = "checkout-attempt-owner:v1:";
  if (storedState.startsWith(ownedPrefix)) {
    try {
      const parsed = JSON.parse(storedState.slice(ownedPrefix.length)) as {
        state?: unknown;
      };
      return typeof parsed.state === "string"
        ? parseCheckoutAttemptState(parsed.state)
        : { kind: "create_uncertain" };
    } catch {
      return { kind: "create_uncertain" };
    }
  }
  const expirationPrefix = "checkout-attempt:v2:expiration:";
  if (storedState.startsWith(expirationPrefix)) {
    try {
      const parsed = JSON.parse(
        storedState.slice(expirationPrefix.length)
      ) as unknown;
      const expirationState = parseCheckoutExpirationState(parsed);
      return expirationState ?? { kind: "create_uncertain" };
    } catch {
      return { kind: "create_uncertain" };
    }
  }
  if (storedState === "checkout-attempt:v1:fresh") {
    return { kind: "fresh" };
  }
  if (storedState === "checkout-attempt:v1:create_uncertain") {
    return { kind: "create_uncertain" };
  }
  const sessionPrefix = "checkout-attempt:v1:session_created:";
  if (storedState.startsWith(sessionPrefix)) {
    const sessionId = storedState.slice(sessionPrefix.length);
    if (sessionId.length > 0) {
      return { kind: "session_created", sessionId };
    }
  }
  const customerPrefix = "checkout-attempt:v1:customer_created:";
  if (storedState.startsWith(customerPrefix)) {
    const customerId = storedState.slice(customerPrefix.length);
    if (customerId.length > 0) {
      return { customerId, kind: "customer_created" };
    }
  }
  return { kind: "create_uncertain" };
}

export function serializeCheckoutAttemptState(
  state: CheckoutAttemptState
): string {
  if (
    state.kind === "expiration_in_flight" ||
    state.kind === "expiration_confirmed"
  ) {
    return `checkout-attempt:v2:expiration:${JSON.stringify({
      cleanupKind: state.cleanupKind,
      customerId: state.customerId,
      expirationIdempotencyKey: state.expirationIdempotencyKey,
      kind: state.kind,
      resumeState: state.resumeState,
      sessionId: state.sessionId,
      ...(state.kind === "expiration_confirmed"
        ? { terminalStatus: state.terminalStatus }
        : {}),
    })}`;
  }
  if (state.kind === "session_created") {
    return `checkout-attempt:v1:session_created:${state.sessionId}`;
  }
  if (state.kind === "customer_created") {
    return `checkout-attempt:v1:customer_created:${state.customerId}`;
  }
  return `checkout-attempt:v1:${state.kind}`;
}

export function checkoutAttemptResumeState(
  state: CheckoutAttemptState
): CheckoutAttemptStableState {
  return state.kind === "expiration_in_flight" ||
    state.kind === "expiration_confirmed"
    ? state.resumeState
    : state;
}

export function isCheckoutAttemptExpirationState(
  state: CheckoutAttemptState
): state is Exclude<CheckoutAttemptState, CheckoutAttemptStableState> {
  return (
    state.kind === "expiration_in_flight" ||
    state.kind === "expiration_confirmed"
  );
}

export function serializeCheckoutAttemptLeaseOwner(
  ownerToken: string,
  state: CheckoutAttemptState
): string {
  return `checkout-attempt-owner:v1:${JSON.stringify({
    ownerToken,
    state: serializeCheckoutAttemptState(state),
  })}`;
}

function checkoutProviderIdempotencyKey(
  ownerId: string,
  attemptId: string
): string {
  const digest = createHash("sha256")
    .update(["checkout-attempt", ownerId, attemptId].join("\0"), "utf8")
    .digest("hex");
  return `coven_${digest}`;
}

function checkoutExpirationIdempotencyKey(
  providerIdempotencyKey: string,
  sessionId: string
): string {
  const digest = createHash("sha256")
    .update(
      ["checkout-expiration", providerIdempotencyKey, sessionId].join("\0"),
      "utf8"
    )
    .digest("hex");
  return `coven_${digest}`;
}

function leaseExpiry(now: Date): Date {
  return new Date(now.getTime() + CHECKOUT_ATTEMPT_LEASE_TTL_MS);
}

function validNow(now: () => Date): Date {
  const value = now();
  if (Number.isNaN(value.getTime())) {
    throw new RangeError("now must return a valid Date");
  }
  return value;
}

function parseCheckoutExpirationState(
  value: unknown
): Exclude<CheckoutAttemptState, CheckoutAttemptStableState> | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    (candidate.kind !== "expiration_in_flight" &&
      candidate.kind !== "expiration_confirmed") ||
    (candidate.cleanupKind !== "blocking" &&
      candidate.cleanupKind !== "obsolete") ||
    typeof candidate.customerId !== "string" ||
    candidate.customerId.length === 0 ||
    typeof candidate.expirationIdempotencyKey !== "string" ||
    candidate.expirationIdempotencyKey.length === 0 ||
    typeof candidate.sessionId !== "string" ||
    candidate.sessionId.length === 0
  ) {
    return null;
  }
  const resumeState = parseCheckoutStableState(candidate.resumeState);
  if (!resumeState) {
    return null;
  }
  const base: CheckoutExpirationAttempt = {
    cleanupKind: candidate.cleanupKind as CheckoutExpirationCleanupKind,
    customerId: candidate.customerId,
    expirationIdempotencyKey: candidate.expirationIdempotencyKey,
    resumeState,
    sessionId: candidate.sessionId,
  };
  if (candidate.kind === "expiration_in_flight") {
    return { ...base, kind: candidate.kind };
  }
  if (
    candidate.terminalStatus !== "complete" &&
    candidate.terminalStatus !== "expired"
  ) {
    return null;
  }
  return {
    ...base,
    kind: candidate.kind,
    terminalStatus: candidate.terminalStatus,
  };
}

function parseCheckoutStableState(
  value: unknown
): CheckoutAttemptStableState | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "fresh" || candidate.kind === "create_uncertain") {
    return { kind: candidate.kind };
  }
  if (
    candidate.kind === "customer_created" &&
    typeof candidate.customerId === "string" &&
    candidate.customerId.length > 0
  ) {
    return { customerId: candidate.customerId, kind: candidate.kind };
  }
  if (
    candidate.kind === "session_created" &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0
  ) {
    return { kind: candidate.kind, sessionId: candidate.sessionId };
  }
  return null;
}

class CheckoutAttemptLeaseLostError extends Error {}
