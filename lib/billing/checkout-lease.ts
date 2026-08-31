import { createHash, randomUUID } from "node:crypto";

export const CHECKOUT_ATTEMPT_LEASE_TTL_MS = 5 * 60_000;
export const CHECKOUT_ATTEMPT_OPERATION = "checkout-attempt";
export const CHECKOUT_ATTEMPT_KEY_HASH = createHash("sha256")
  .update("checkout-attempt-lease", "utf8")
  .digest("hex");
const CHECKOUT_ATTEMPT_RENEWAL_MS = CHECKOUT_ATTEMPT_LEASE_TTL_MS / 2;

export type CheckoutAttemptLease = {
  attemptId: string;
  expiresAt: Date;
  ownerId: string;
  ownerToken: string;
};

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
  disposition: "preserve_attempt" | "retire_attempt";
  lease: CheckoutAttemptLease;
  releasedAt: Date;
};

export type CheckoutAttemptLeaseReleaseResult = "lost" | "released";

export interface CheckoutAttemptLeaseStore {
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

type CheckoutAttemptWork<T> = {
  disposition: "preserve_attempt" | "retire_attempt";
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
  let stopped = false;
  let timer: unknown;
  const timers = options.timers ?? SYSTEM_TIMERS;

  const scheduleRenewal = () => {
    if (stopped || leaseLost || renewalError !== undefined) {
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

  scheduleRenewal();

  let work: CheckoutAttemptWork<T>;
  try {
    work = await options.perform({
      providerIdempotencyKey: checkoutProviderIdempotencyKey(
        options.ownerId,
        lease.attemptId
      ),
    });
  } catch (error) {
    await stopRenewal();
    await options.store.release({
      disposition: "preserve_attempt",
      lease,
      releasedAt: validNow(now),
    });
    throw error;
  }

  await stopRenewal();
  if (renewalError !== undefined) {
    await options.store.release({
      disposition: "preserve_attempt",
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
      disposition: "preserve_attempt",
      lease,
      releasedAt: validNow(now),
    });
    throw renewalError;
  }
  if (leaseLost) {
    await options.store.release({
      disposition: "preserve_attempt",
      lease,
      releasedAt: validNow(now),
    });
    return { kind: "lease_lost" };
  }

  const releaseResult = await options.store.release({
    disposition: work.disposition,
    lease,
    releasedAt: validNow(now),
  });
  if (releaseResult === "lost") {
    return { kind: "lease_lost" };
  }
  return { kind: "performed", value: work.value };
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
