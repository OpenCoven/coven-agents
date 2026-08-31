import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECKOUT_ATTEMPT_LEASE_TTL_MS,
  type CheckoutAttemptLease,
  type CheckoutAttemptLeaseClaimInput,
  type CheckoutAttemptLeaseClaimResult,
  type CheckoutAttemptLeaseReleaseInput,
  type CheckoutAttemptLeaseRenewInput,
  type CheckoutAttemptLeaseStore,
  type CheckoutLeaseTimers,
  parseCheckoutAttemptState,
  runWithCheckoutAttemptLease,
  serializeCheckoutAttemptState,
} from "./checkout-lease";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

test("active checkout work renews before expiry and blocks a second owner", async () => {
  const clock = new ManualClock();
  const timers = new ManualTimers();
  const store = new MemoryCheckoutAttemptLeaseStore();
  let providerCalls = 0;
  let releaseProvider!: () => void;
  let signalProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    signalProviderStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });

  const first = runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-one",
    now: clock.now,
    ownerId: USER_ID,
    perform: async () => {
      providerCalls += 1;
      signalProviderStarted();
      await providerGate;
      return { disposition: "retire_attempt", value: "first" } as const;
    },
    store,
    timers,
  });
  await providerStarted;

  clock.advance(CHECKOUT_ATTEMPT_LEASE_TTL_MS / 2);
  await timers.runNext();
  clock.advance(CHECKOUT_ATTEMPT_LEASE_TTL_MS / 2 + 1);

  const concurrent = await runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-two",
    now: clock.now,
    ownerId: USER_ID,
    perform: () => {
      providerCalls += 1;
      return Promise.resolve({
        disposition: "retire_attempt",
        value: "impossible",
      } as const);
    },
    store,
    timers,
  });

  assert.deepEqual(concurrent, { kind: "in_progress" });
  assert.equal(providerCalls, 1);

  releaseProvider();
  assert.deepEqual(await first, { kind: "performed", value: "first" });
  assert.equal(timers.activeCount, 0);
});

test("a successor reuses the attempt key and a stale release cannot delete its lease", async () => {
  const clock = new ManualClock();
  const timers = new ManualTimers();
  const store = new MemoryCheckoutAttemptLeaseStore();
  let releaseFirst!: () => void;
  let releaseSuccessor!: () => void;
  let signalFirstStarted!: (key: string) => void;
  let signalSuccessorStarted!: (key: string) => void;
  const firstStarted = new Promise<string>((resolve) => {
    signalFirstStarted = resolve;
  });
  const successorStarted = new Promise<string>((resolve) => {
    signalSuccessorStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const successorGate = new Promise<void>((resolve) => {
    releaseSuccessor = resolve;
  });

  const first = runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-one",
    now: clock.now,
    ownerId: USER_ID,
    perform: async ({ providerIdempotencyKey }) => {
      signalFirstStarted(providerIdempotencyKey);
      await firstGate;
      return {
        disposition: "retire_attempt",
        value: "stale-success",
      } as const;
    },
    store,
    timers,
  });
  const firstKey = await firstStarted;

  clock.advance(CHECKOUT_ATTEMPT_LEASE_TTL_MS + 1);
  const successor = runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-two",
    now: clock.now,
    ownerId: USER_ID,
    perform: async ({ providerIdempotencyKey }) => {
      signalSuccessorStarted(providerIdempotencyKey);
      await successorGate;
      return { disposition: "retire_attempt", value: "successor" } as const;
    },
    store,
    timers,
  });
  const successorKey = await successorStarted;

  assert.equal(successorKey, firstKey);
  releaseFirst();
  assert.deepEqual(await first, { kind: "lease_lost" });
  assert.equal(store.staleReleaseCount, 1);

  const blocked = await runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-three",
    now: clock.now,
    ownerId: USER_ID,
    perform: () =>
      Promise.resolve({
        disposition: "retire_attempt",
        value: "impossible",
      } as const),
    store,
    timers,
  });
  assert.deepEqual(blocked, { kind: "in_progress" });

  releaseSuccessor();
  assert.deepEqual(await successor, {
    kind: "performed",
    value: "successor",
  });
  assert.equal(timers.activeCount, 0);
});

test("preserved attempt state survives reclaim while expiration identities rotate", async () => {
  const clock = new ManualClock();
  const store = new MemoryCheckoutAttemptLeaseStore();
  let firstExpirationKey = "";
  let firstProviderKey = "";

  const first = await runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-one",
    now: clock.now,
    ownerId: USER_ID,
    perform: ({
      attemptState,
      expirationIdempotencyKey,
      providerIdempotencyKey,
    }) => {
      assert.deepEqual(attemptState, { kind: "fresh" });
      firstExpirationKey = expirationIdempotencyKey("cs_obsolete");
      firstProviderKey = providerIdempotencyKey;
      return Promise.resolve({
        disposition: "preserve_attempt",
        state: { kind: "session_created", sessionId: "cs_created" },
        value: "preserved",
      } as const);
    },
    store,
  });
  assert.deepEqual(first, { kind: "performed", value: "preserved" });

  clock.advance(1);
  const second = await runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-two",
    now: clock.now,
    ownerId: USER_ID,
    perform: ({
      attemptState,
      expirationIdempotencyKey,
      providerIdempotencyKey,
    }) => {
      assert.deepEqual(attemptState, {
        kind: "session_created",
        sessionId: "cs_created",
      });
      assert.equal(providerIdempotencyKey, firstProviderKey);
      assert.notEqual(
        expirationIdempotencyKey("cs_obsolete"),
        firstExpirationKey
      );
      return Promise.resolve({
        disposition: "retire_attempt",
        value: "retired",
      } as const);
    },
    store,
  });

  assert.deepEqual(second, { kind: "performed", value: "retired" });
});

test("checkout attempt state encoding fails closed for legacy or malformed values", () => {
  assert.deepEqual(
    parseCheckoutAttemptState(
      serializeCheckoutAttemptState({
        kind: "session_created",
        sessionId: "cs_recoverable",
      })
    ),
    { kind: "session_created", sessionId: "cs_recoverable" }
  );
  assert.deepEqual(parseCheckoutAttemptState("legacy-owner-token"), {
    kind: "create_uncertain",
  });
});

class ManualClock {
  private timestamp = Date.parse("2026-08-31T00:00:00.000Z");
  readonly now = () => new Date(this.timestamp);

  advance(milliseconds: number) {
    this.timestamp += milliseconds;
  }
}

type ManualTimer = {
  callback: () => Promise<void>;
  cancelled: boolean;
};

class ManualTimers implements CheckoutLeaseTimers {
  private readonly timers: ManualTimer[] = [];

  get activeCount() {
    return this.timers.filter(({ cancelled }) => !cancelled).length;
  }

  clearTimeout(timer: unknown) {
    (timer as ManualTimer).cancelled = true;
  }

  async runNext() {
    const timer = this.timers.find(({ cancelled }) => !cancelled);
    assert.ok(timer);
    timer.cancelled = true;
    await timer.callback();
  }

  setTimeout(callback: () => Promise<void>, _delayMs: number) {
    const timer = { callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }
}

type LeaseRecord = {
  attemptId: string;
  attemptState: CheckoutAttemptLease["attemptState"];
  expiresAt: Date;
  ownerToken: string;
};

class MemoryCheckoutAttemptLeaseStore implements CheckoutAttemptLeaseStore {
  staleReleaseCount = 0;
  private nextAttempt = 1;
  private readonly records = new Map<string, LeaseRecord>();

  claim(
    input: CheckoutAttemptLeaseClaimInput
  ): Promise<CheckoutAttemptLeaseClaimResult> {
    const existing = this.records.get(input.ownerId);
    if (existing && existing.expiresAt.getTime() > input.now.getTime()) {
      return Promise.resolve({ kind: "in_progress" });
    }

    const record = existing ?? {
      attemptId: `attempt-${this.nextAttempt}`,
      attemptState: { kind: "fresh" } as const,
      expiresAt: input.leaseExpiresAt,
      ownerToken: input.ownerToken,
    };
    if (existing === undefined) {
      this.nextAttempt += 1;
    }
    record.expiresAt = input.leaseExpiresAt;
    record.ownerToken = input.ownerToken;
    this.records.set(input.ownerId, record);
    return Promise.resolve({
      kind: "claimed",
      lease: lease(input.ownerId, record),
    });
  }

  release(
    input: CheckoutAttemptLeaseReleaseInput
  ): Promise<"lost" | "released"> {
    const record = this.records.get(input.lease.ownerId);
    if (!record || record.ownerToken !== input.lease.ownerToken) {
      this.staleReleaseCount += 1;
      return Promise.resolve("lost");
    }

    if (input.disposition.kind === "retire_attempt") {
      this.records.delete(input.lease.ownerId);
    } else {
      record.attemptState = input.disposition.state;
      record.expiresAt = input.releasedAt;
    }
    return Promise.resolve("released");
  }

  renew(
    input: CheckoutAttemptLeaseRenewInput
  ): Promise<
    { kind: "lost" } | { kind: "renewed"; lease: CheckoutAttemptLease }
  > {
    const record = this.records.get(input.lease.ownerId);
    if (
      !record ||
      record.ownerToken !== input.lease.ownerToken ||
      record.expiresAt.getTime() <= input.now.getTime()
    ) {
      return Promise.resolve({ kind: "lost" });
    }

    record.expiresAt = input.leaseExpiresAt;
    return Promise.resolve({
      kind: "renewed",
      lease: lease(input.lease.ownerId, record),
    });
  }
}

function lease(ownerId: string, record: LeaseRecord): CheckoutAttemptLease {
  return {
    attemptId: record.attemptId,
    attemptState: record.attemptState,
    expiresAt: record.expiresAt,
    ownerId,
    ownerToken: record.ownerToken,
  };
}
