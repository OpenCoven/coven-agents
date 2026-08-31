import { createHash, randomUUID } from "node:crypto";

export const CHECKOUT_ATTEMPT_LEASE_TTL_MS = 5 * 60_000;
export const CHECKOUT_ATTEMPT_OPERATION = "checkout-attempt";
export const CHECKOUT_ATTEMPT_KEY_HASH = createHash("sha256")
  .update("checkout-attempt-lease", "utf8")
  .digest("hex");
export const CHECKOUT_ATTEMPT_STATE_MAX_BYTES = 8192;
export const CHECKOUT_CLEANUP_QUEUE_MAX_LENGTH = 16;
export const CHECKOUT_PROVIDER_IDENTIFIER_MAX_LENGTH = 128;
const CHECKOUT_ATTEMPT_RENEWAL_MS = CHECKOUT_ATTEMPT_LEASE_TTL_MS / 2;
const CHECKOUT_ATTEMPT_OWNER_MAX_BYTES =
  CHECKOUT_ATTEMPT_STATE_MAX_BYTES * 2 + 512;

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

export type CheckoutCleanupQueueItem =
  | { sessionId: string }
  | {
      sessionId: string;
      subscriptionId: string | null;
      terminalStatus: "complete" | "expired";
    };

export type CheckoutCleanupQueueState = {
  cleanupKind: CheckoutExpirationCleanupKind;
  currentIndex: number;
  customerId: string;
  expiration: {
    generation: number;
    idempotencyKey: string;
    status: "in_flight" | "rejected";
  } | null;
  items: CheckoutCleanupQueueItem[];
  kind: "cleanup_queue";
  resumeState: CheckoutAttemptStableState;
};

export type CheckoutAttemptState =
  | CheckoutAttemptStableState
  | CheckoutCleanupQueueState
  | { kind: "invalid" };

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
    expirationIdempotencyKey: (
      sessionId: string,
      generation?: number
    ) => string;
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
      expirationIdempotencyKey: (sessionId, generation = 0) =>
        checkoutExpirationIdempotencyKey(
          providerIdempotencyKey,
          sessionId,
          generation
        ),
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
    if (
      Buffer.byteLength(storedState, "utf8") > CHECKOUT_ATTEMPT_OWNER_MAX_BYTES
    ) {
      return { kind: "invalid" };
    }
    try {
      const parsed = JSON.parse(storedState.slice(ownedPrefix.length)) as {
        state?: unknown;
      };
      return typeof parsed.state === "string"
        ? parseCheckoutAttemptState(parsed.state)
        : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  }
  const cleanupPrefix = "checkout-attempt:v3:cleanup:";
  if (storedState.startsWith(cleanupPrefix)) {
    if (
      Buffer.byteLength(storedState, "utf8") > CHECKOUT_ATTEMPT_STATE_MAX_BYTES
    ) {
      return { kind: "invalid" };
    }
    try {
      const parsed = JSON.parse(storedState.slice(cleanupPrefix.length));
      return parseCheckoutCleanupQueueState(parsed) ?? { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
    }
  }
  if (storedState === "checkout-attempt:v3:invalid") {
    return { kind: "invalid" };
  }
  const expirationPrefix = "checkout-attempt:v2:expiration:";
  if (storedState.startsWith(expirationPrefix)) {
    try {
      const parsed = JSON.parse(
        storedState.slice(expirationPrefix.length)
      ) as unknown;
      const expirationState = parseCheckoutExpirationState(parsed);
      return expirationState
        ? upgradeCheckoutExpirationState(expirationState)
        : { kind: "invalid" };
    } catch {
      return { kind: "invalid" };
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
    if (isProviderIdentifier(sessionId)) {
      return { kind: "session_created", sessionId };
    }
  }
  const customerPrefix = "checkout-attempt:v1:customer_created:";
  if (storedState.startsWith(customerPrefix)) {
    const customerId = storedState.slice(customerPrefix.length);
    if (isProviderIdentifier(customerId)) {
      return { customerId, kind: "customer_created" };
    }
  }
  return { kind: "create_uncertain" };
}

export function serializeCheckoutAttemptState(
  state: CheckoutAttemptState
): string {
  if (state.kind === "cleanup_queue") {
    if (!isValidCheckoutCleanupQueueState(state)) {
      throw new RangeError("Checkout cleanup queue state is invalid.");
    }
    const serialized = `checkout-attempt:v3:cleanup:${JSON.stringify({
      cleanupKind: state.cleanupKind,
      currentIndex: state.currentIndex,
      customerId: state.customerId,
      expiration: state.expiration,
      items: state.items,
      kind: state.kind,
      resumeState: state.resumeState,
    })}`;
    if (
      Buffer.byteLength(serialized, "utf8") > CHECKOUT_ATTEMPT_STATE_MAX_BYTES
    ) {
      throw new RangeError("Checkout cleanup queue state is too large.");
    }
    return serialized;
  }
  if (state.kind === "invalid") {
    return "checkout-attempt:v3:invalid";
  }
  if (state.kind === "session_created") {
    if (!isProviderIdentifier(state.sessionId)) {
      throw new RangeError("Checkout Session id is invalid.");
    }
    return `checkout-attempt:v1:session_created:${state.sessionId}`;
  }
  if (state.kind === "customer_created") {
    if (!isProviderIdentifier(state.customerId)) {
      throw new RangeError("Stripe Customer id is invalid.");
    }
    return `checkout-attempt:v1:customer_created:${state.customerId}`;
  }
  return `checkout-attempt:v1:${state.kind}`;
}

export function checkoutAttemptResumeState(
  state: CheckoutAttemptState
): CheckoutAttemptStableState {
  if (state.kind === "cleanup_queue") {
    return state.resumeState;
  }
  return state.kind === "invalid" ? { kind: "create_uncertain" } : state;
}

export function isCheckoutAttemptCleanupQueueState(
  state: CheckoutAttemptState
): state is CheckoutCleanupQueueState {
  return state.kind === "cleanup_queue";
}

export function createCheckoutCleanupQueueState(input: {
  cleanupKind: CheckoutExpirationCleanupKind;
  customerId: string;
  resumeState: CheckoutAttemptStableState;
  sessionIds: readonly string[];
}): CheckoutCleanupQueueState {
  const sessionIds = [...new Set(input.sessionIds)].sort();
  const state: CheckoutCleanupQueueState = {
    cleanupKind: input.cleanupKind,
    currentIndex: 0,
    customerId: input.customerId,
    expiration: null,
    items: sessionIds.map((sessionId) => ({ sessionId })),
    kind: "cleanup_queue",
    resumeState: input.resumeState,
  };
  serializeCheckoutAttemptState(state);
  return state;
}

export function serializeCheckoutAttemptLeaseOwner(
  ownerToken: string,
  state: CheckoutAttemptState
): string {
  const serialized = `checkout-attempt-owner:v1:${JSON.stringify({
    ownerToken,
    state: serializeCheckoutAttemptState(state),
  })}`;
  if (
    Buffer.byteLength(serialized, "utf8") > CHECKOUT_ATTEMPT_OWNER_MAX_BYTES
  ) {
    throw new RangeError("Checkout attempt owner state is too large.");
  }
  return serialized;
}

export function checkoutProviderIdempotencyKey(
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
  sessionId: string,
  generation: number
): string {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("Expiration generation must be a safe integer.");
  }
  const identity =
    generation === 0
      ? ["checkout-expiration", providerIdempotencyKey, sessionId]
      : [
          "checkout-expiration",
          providerIdempotencyKey,
          sessionId,
          String(generation),
        ];
  const digest = createHash("sha256")
    .update(identity.join("\0"), "utf8")
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

function parseCheckoutExpirationState(value: unknown): {
  cleanupKind: CheckoutExpirationCleanupKind;
  customerId: string;
  expirationIdempotencyKey: string;
  kind: "expiration_confirmed" | "expiration_in_flight";
  resumeState: CheckoutAttemptStableState;
  sessionId: string;
  terminalStatus?: "complete" | "expired";
} | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const { cleanupKind } = candidate;
  if (
    (candidate.kind !== "expiration_in_flight" &&
      candidate.kind !== "expiration_confirmed") ||
    !isCheckoutCleanupKind(cleanupKind) ||
    !isProviderIdentifier(candidate.customerId) ||
    !isProviderIdentifier(candidate.expirationIdempotencyKey) ||
    !isProviderIdentifier(candidate.sessionId)
  ) {
    return null;
  }
  const resumeState = parseCheckoutStableState(candidate.resumeState);
  if (!resumeState) {
    return null;
  }
  const base = {
    cleanupKind,
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

function upgradeCheckoutExpirationState(
  state: NonNullable<ReturnType<typeof parseCheckoutExpirationState>>
): CheckoutCleanupQueueState {
  return {
    cleanupKind: state.cleanupKind,
    currentIndex: 0,
    customerId: state.customerId,
    expiration:
      state.kind === "expiration_in_flight"
        ? {
            generation: 0,
            idempotencyKey: state.expirationIdempotencyKey,
            status: "in_flight",
          }
        : null,
    items: [{ sessionId: state.sessionId }],
    kind: "cleanup_queue",
    resumeState: state.resumeState,
  };
}

function parseCheckoutCleanupQueueState(
  value: unknown
): CheckoutCleanupQueueState | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const { cleanupKind } = candidate;
  const resumeState = parseCheckoutStableState(candidate.resumeState);
  if (
    candidate.kind !== "cleanup_queue" ||
    !isCheckoutCleanupKind(cleanupKind) ||
    !isProviderIdentifier(candidate.customerId) ||
    !isNonNegativeInteger(candidate.currentIndex) ||
    !Array.isArray(candidate.items) ||
    !resumeState
  ) {
    return null;
  }
  const items: CheckoutCleanupQueueItem[] = [];
  for (const itemValue of candidate.items) {
    const item = parseCheckoutCleanupQueueItem(itemValue);
    if (!item) {
      return null;
    }
    items.push(item);
  }
  const expiration = parseCheckoutCleanupQueueExpiration(candidate.expiration);
  if (expiration === undefined) {
    return null;
  }
  const state: CheckoutCleanupQueueState = {
    cleanupKind,
    currentIndex: candidate.currentIndex,
    customerId: candidate.customerId,
    expiration,
    items,
    kind: candidate.kind,
    resumeState,
  };
  return isValidCheckoutCleanupQueueState(state) ? state : null;
}

function parseCheckoutCleanupQueueItem(
  value: unknown
): CheckoutCleanupQueueItem | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (!isProviderIdentifier(candidate.sessionId)) {
    return null;
  }
  if (
    candidate.terminalStatus === undefined &&
    candidate.subscriptionId === undefined
  ) {
    return { sessionId: candidate.sessionId };
  }
  if (
    (candidate.terminalStatus !== "complete" &&
      candidate.terminalStatus !== "expired") ||
    (candidate.subscriptionId !== null &&
      !isProviderIdentifier(candidate.subscriptionId))
  ) {
    return null;
  }
  return {
    sessionId: candidate.sessionId,
    subscriptionId: candidate.subscriptionId,
    terminalStatus: candidate.terminalStatus,
  };
}

function parseCheckoutCleanupQueueExpiration(
  value: unknown
): CheckoutCleanupQueueState["expiration"] | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !isNonNegativeSafeInteger(candidate.generation) ||
    !isProviderIdentifier(candidate.idempotencyKey) ||
    (candidate.status !== "in_flight" && candidate.status !== "rejected")
  ) {
    return undefined;
  }
  return {
    generation: candidate.generation,
    idempotencyKey: candidate.idempotencyKey,
    status: candidate.status,
  };
}

function isValidCheckoutCleanupQueueState(
  state: CheckoutCleanupQueueState
): boolean {
  if (
    !isProviderIdentifier(state.customerId) ||
    !isValidCheckoutStableState(state.resumeState) ||
    state.items.length === 0 ||
    state.items.length > CHECKOUT_CLEANUP_QUEUE_MAX_LENGTH ||
    !Number.isInteger(state.currentIndex) ||
    state.currentIndex < 0 ||
    state.currentIndex > state.items.length ||
    (state.currentIndex === state.items.length && state.expiration !== null)
  ) {
    return false;
  }
  const sessionIds = state.items.map(({ sessionId }) => sessionId);
  if (
    sessionIds.some((sessionId) => !isProviderIdentifier(sessionId)) ||
    new Set(sessionIds).size !== sessionIds.length ||
    sessionIds.some((sessionId, index) => {
      const previousSessionId = sessionIds[index - 1];
      return (
        index > 0 &&
        previousSessionId !== undefined &&
        previousSessionId >= sessionId
      );
    })
  ) {
    return false;
  }
  for (const [index, item] of state.items.entries()) {
    const terminal = "terminalStatus" in item;
    if (
      (index < state.currentIndex && !terminal) ||
      (index >= state.currentIndex && terminal) ||
      (terminal &&
        item.subscriptionId !== null &&
        !isProviderIdentifier(item.subscriptionId)) ||
      (terminal &&
        item.terminalStatus === "expired" &&
        item.subscriptionId !== null)
    ) {
      return false;
    }
  }
  if (!state.expiration) {
    return true;
  }
  return (
    state.currentIndex < state.items.length &&
    Number.isSafeInteger(state.expiration.generation) &&
    state.expiration.generation >= 0 &&
    isProviderIdentifier(state.expiration.idempotencyKey) &&
    (state.expiration.status === "in_flight" ||
      state.expiration.status === "rejected")
  );
}

function isProviderIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= CHECKOUT_PROVIDER_IDENTIFIER_MAX_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function isCheckoutCleanupKind(
  value: unknown
): value is CheckoutExpirationCleanupKind {
  return value === "blocking" || value === "obsolete";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isValidCheckoutStableState(
  state: CheckoutAttemptStableState
): boolean {
  if (state.kind === "fresh" || state.kind === "create_uncertain") {
    return true;
  }
  return isProviderIdentifier(
    state.kind === "customer_created" ? state.customerId : state.sessionId
  );
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
    isProviderIdentifier(candidate.customerId)
  ) {
    return { customerId: candidate.customerId, kind: candidate.kind };
  }
  if (
    candidate.kind === "session_created" &&
    isProviderIdentifier(candidate.sessionId)
  ) {
    return { kind: candidate.kind, sessionId: candidate.sessionId };
  }
  return null;
}

class CheckoutAttemptLeaseLostError extends Error {}
