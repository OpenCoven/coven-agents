import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECKOUT_ATTEMPT_LEASE_TTL_MS,
  CHECKOUT_ATTEMPT_STATE_MAX_BYTES,
  CHECKOUT_CLEANUP_QUEUE_MAX_LENGTH,
  CHECKOUT_PROVIDER_IDENTIFIER_MAX_LENGTH,
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

test("preserved attempt state and expiration identities survive reclaim", async () => {
  const clock = new ManualClock();
  const store = new MemoryCheckoutAttemptLeaseStore();
  let firstExpirationKey = "";
  let firstRotatedExpirationKey = "";
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
      firstRotatedExpirationKey = expirationIdempotencyKey("cs_obsolete", 1);
      assert.notEqual(firstRotatedExpirationKey, firstExpirationKey);
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
      assert.equal(expirationIdempotencyKey("cs_obsolete"), firstExpirationKey);
      assert.equal(
        expirationIdempotencyKey("cs_obsolete", 1),
        firstRotatedExpirationKey
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

test("checkpointed Customer identity survives a failed attachment", async () => {
  const clock = new ManualClock();
  const store = new MemoryCheckoutAttemptLeaseStore();
  let providerKey = "";

  await assert.rejects(
    runWithCheckoutAttemptLease({
      createOwnerToken: () => "owner-one",
      now: clock.now,
      ownerId: USER_ID,
      perform: async ({ checkpoint, providerIdempotencyKey }) => {
        providerKey = providerIdempotencyKey;
        await checkpoint({
          customerId: "cus_recoverable",
          kind: "customer_created",
        });
        throw new Error("attachment failed");
      },
      store,
    }),
    /attachment failed/
  );

  clock.advance(1);
  const recovered = await runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-two",
    now: clock.now,
    ownerId: USER_ID,
    perform: ({ attemptState, providerIdempotencyKey }) => {
      assert.deepEqual(attemptState, {
        customerId: "cus_recoverable",
        kind: "customer_created",
      });
      assert.equal(providerIdempotencyKey, providerKey);
      return Promise.resolve({
        disposition: "retire_attempt",
        value: "recovered",
      } as const);
    },
    store,
  });

  assert.deepEqual(recovered, { kind: "performed", value: "recovered" });
});

test("an expired holder cannot checkpoint or continue checkout work", async () => {
  const clock = new ManualClock();
  const store = new MemoryCheckoutAttemptLeaseStore();
  let continued = false;

  const result = await runWithCheckoutAttemptLease({
    createOwnerToken: () => "owner-one",
    now: clock.now,
    ownerId: USER_ID,
    perform: async ({ checkpoint }) => {
      clock.advance(CHECKOUT_ATTEMPT_LEASE_TTL_MS + 1);
      await checkpoint({
        customerId: "cus_too_late",
        kind: "customer_created",
      });
      continued = true;
      return { disposition: "retire_attempt", value: "unsafe" } as const;
    },
    store,
  });

  assert.deepEqual(result, { kind: "lease_lost" });
  assert.equal(continued, false);
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

test("bounded cleanup queue state round-trips with deterministic expiration generations", () => {
  const state = {
    cleanupKind: "blocking",
    currentIndex: 1,
    customerId: "cus_recoverable",
    expiration: {
      generation: 2,
      idempotencyKey: "coven_rotated_expiration_key",
      status: "in_flight",
    },
    items: [
      {
        sessionId: "cs_first",
        subscriptionId: null,
        terminalStatus: "expired",
      },
      { sessionId: "cs_second" },
    ],
    kind: "cleanup_queue",
    resumeState: { kind: "fresh" },
  } satisfies CheckoutAttemptLease["attemptState"];

  const serialized = serializeCheckoutAttemptState(state);

  assert.ok(
    Buffer.byteLength(serialized, "utf8") <= CHECKOUT_ATTEMPT_STATE_MAX_BYTES
  );
  assert.deepEqual(parseCheckoutAttemptState(serialized), state);
});

test("legacy v2 expiration state upgrades to a one-item cleanup queue without changing its key", () => {
  const legacyState = {
    cleanupKind: "obsolete",
    customerId: "cus_legacy",
    expirationIdempotencyKey: "coven_legacy_expiration_key",
    kind: "expiration_in_flight",
    resumeState: { kind: "session_created", sessionId: "cs_resume" },
    sessionId: "cs_legacy",
  };

  const storedState = `checkout-attempt:v2:expiration:${JSON.stringify(
    legacyState
  )}`;
  const expected = {
    cleanupKind: "obsolete",
    currentIndex: 0,
    customerId: "cus_legacy",
    expiration: {
      generation: 0,
      idempotencyKey: "coven_legacy_expiration_key",
      status: "in_flight",
    },
    items: [{ sessionId: "cs_legacy" }],
    kind: "cleanup_queue",
    resumeState: { kind: "session_created", sessionId: "cs_resume" },
  };

  assert.deepEqual(parseCheckoutAttemptState(storedState), expected);
  assert.deepEqual(
    parseCheckoutAttemptState(
      `checkout-attempt-owner:v1:${JSON.stringify({
        ownerToken: "legacy-owner",
        state: storedState,
      })}`
    ),
    expected
  );
  assert.deepEqual(parseCheckoutAttemptState("checkout-attempt-owner:v1:{"), {
    kind: "invalid",
  });
});

test("malformed, oversized, or unbounded cleanup queues decode to an invalid fail-closed state", () => {
  const base = {
    cleanupKind: "blocking",
    currentIndex: 0,
    customerId: "cus_bounded",
    expiration: null,
    kind: "cleanup_queue",
    resumeState: { kind: "fresh" },
  };
  const encoded = (value: unknown) =>
    `checkout-attempt:v3:cleanup:${JSON.stringify(value)}`;

  assert.deepEqual(
    parseCheckoutAttemptState(
      encoded({
        ...base,
        items: [{ sessionId: "cs_duplicate" }, { sessionId: "cs_duplicate" }],
      })
    ),
    { kind: "invalid" }
  );
  assert.deepEqual(
    parseCheckoutAttemptState(
      encoded({
        ...base,
        items: Array.from(
          { length: CHECKOUT_CLEANUP_QUEUE_MAX_LENGTH + 1 },
          (_, index) => ({ sessionId: `cs_${index}` })
        ),
      })
    ),
    { kind: "invalid" }
  );
  assert.deepEqual(
    parseCheckoutAttemptState(
      `checkout-attempt:v3:cleanup:${"x".repeat(
        CHECKOUT_ATTEMPT_STATE_MAX_BYTES
      )}`
    ),
    { kind: "invalid" }
  );
});

test("the largest accepted queue remains serializable after every item completes", () => {
  assert.equal(CHECKOUT_PROVIDER_IDENTIFIER_MAX_LENGTH, 128);
  const identifier = (prefix: string, index: number) =>
    `${prefix}_${String(index).padStart(2, "0")}_`.padEnd(
      CHECKOUT_PROVIDER_IDENTIFIER_MAX_LENGTH,
      "a"
    );
  const items = Array.from(
    { length: CHECKOUT_CLEANUP_QUEUE_MAX_LENGTH },
    (_, index) => ({
      sessionId: identifier("cs", index),
      subscriptionId: identifier("sub", index),
      terminalStatus: "complete" as const,
    })
  );

  const serialized = serializeCheckoutAttemptState({
    cleanupKind: "blocking",
    currentIndex: items.length,
    customerId: identifier("cus", 0),
    expiration: null,
    items,
    kind: "cleanup_queue",
    resumeState: {
      kind: "session_created",
      sessionId: identifier("cs_resume", 0),
    },
  });

  assert.ok(
    Buffer.byteLength(serialized, "utf8") <= CHECKOUT_ATTEMPT_STATE_MAX_BYTES
  );
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

  checkpoint(input: {
    lease: CheckoutAttemptLease;
    leaseExpiresAt: Date;
    state: CheckoutAttemptLease["attemptState"];
    updatedAt: Date;
  }) {
    const record = this.records.get(input.lease.ownerId);
    if (
      !record ||
      record.ownerToken !== input.lease.ownerToken ||
      record.expiresAt.getTime() <= input.updatedAt.getTime()
    ) {
      return Promise.resolve({ kind: "lost" } as const);
    }
    record.attemptState = input.state;
    record.expiresAt = input.leaseExpiresAt;
    return Promise.resolve({
      kind: "checkpointed",
      lease: lease(input.lease.ownerId, record),
    } as const);
  }

  release(
    input: CheckoutAttemptLeaseReleaseInput
  ): Promise<"lost" | "released"> {
    const record = this.records.get(input.lease.ownerId);
    if (
      !record ||
      record.ownerToken !== input.lease.ownerToken ||
      record.expiresAt.getTime() <= input.releasedAt.getTime()
    ) {
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
