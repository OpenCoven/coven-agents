import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  type IdempotencyClaimInput,
  type IdempotencyClaimResult,
  type IdempotencyCompleteInput,
  type IdempotencyReleaseInput,
  type IdempotencyRenewInput,
  type IdempotencyResponse,
  type IdempotencyStore,
  idempotencyResultResponse,
  runIdempotentOperation,
} from "./idempotency";
import type {
  IdempotencyResponseStorage,
  StoredIdempotencyResponseEnvelope,
} from "./idempotency-response";

const KEY = "request-key-1234567890";
const OWNER = "00000000-0000-4000-8000-000000000001";
const OPERATION = "checkout";
const CLAIM_TTL_MS = 5 * 60_000;

test("same key and normalized request replay the exact completed response", async () => {
  const store = new MemoryIdempotencyStore();
  let calls = 0;

  const first = await run({
    perform: () => {
      calls += 1;
      return Promise.resolve({
        body: { url: "https://checkout.test/one" },
        status: 201,
      });
    },
    request: { a: 1, b: 2 },
    store,
  });
  const replay = await run({
    perform: () => {
      calls += 1;
      return Promise.resolve({ body: { url: "wrong" }, status: 200 });
    },
    request: reverseOrderedRequest(),
    store,
  });

  assert.deepEqual(first, {
    kind: "response",
    replayed: false,
    response: { body: { url: "https://checkout.test/one" }, status: 201 },
  });
  assert.deepEqual(replay, {
    kind: "response",
    replayed: true,
    response: { body: { url: "https://checkout.test/one" }, status: 201 },
  });
  assert.equal(calls, 1);
});

test("same key with a different request hash conflicts", async () => {
  const store = new MemoryIdempotencyStore();
  await run({
    perform: () => Promise.resolve({ body: { ok: true }, status: 200 }),
    request: { plan: "monthly" },
    store,
  });

  const result = await run({
    perform: () => Promise.resolve({ body: { ok: false }, status: 200 }),
    request: { plan: "annual" },
    store,
  });

  assert.deepEqual(result, { kind: "conflict" });
});

test("same key while the first request is in progress returns an explicit conflict", async () => {
  const store = new MemoryIdempotencyStore();
  let releaseProvider!: () => void;
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });

  const first = run({
    perform: async () => {
      providerStarted();
      await providerGate;
      return { body: { ok: true }, status: 200 };
    },
    request: {},
    store,
  });
  await started;

  assert.deepEqual(
    await run({
      perform: () =>
        Promise.resolve({ body: { impossible: true }, status: 200 }),
      request: {},
      store,
    }),
    { kind: "in_progress" }
  );

  releaseProvider();
  await first;
});

test("an expired record is atomically reclaimed for a new request", async () => {
  const store = new MemoryIdempotencyStore();
  let now = Date.parse("2026-08-25T20:00:00.000Z");
  await run({
    now: () => new Date(now),
    perform: () => Promise.resolve({ body: { version: 1 }, status: 200 }),
    request: { version: 1 },
    retentionMs: 1000,
    store,
  });

  now += 1001;
  const reclaimed = await run({
    now: () => new Date(now),
    perform: () => Promise.resolve({ body: { version: 2 }, status: 202 }),
    request: { version: 2 },
    retentionMs: 1000,
    store,
  });

  assert.deepEqual(reclaimed, {
    kind: "response",
    replayed: false,
    response: { body: { version: 2 }, status: 202 },
  });
  assert.deepEqual(store.cleanupDeletedStates, ["completed"]);
});

test("provider failure releases the claim so the same key can retry", async () => {
  const store = new MemoryIdempotencyStore();
  let attempts = 0;

  await assert.rejects(
    run({
      perform: () => {
        attempts += 1;
        return Promise.reject(new Error("provider failed"));
      },
      request: {},
      store,
    }),
    /provider failed/
  );

  const retry = await run({
    perform: () => {
      attempts += 1;
      return Promise.resolve({ body: { ok: true }, status: 200 });
    },
    request: {},
    store,
  });

  assert.equal(attempts, 2);
  assert.equal(retry.kind, "response");
  assert.equal(store.releaseCount, 1);
});

test("non-success provider results are retryable rather than permanently completed", async () => {
  const store = new MemoryIdempotencyStore();
  let attempts = 0;

  const failed = await run({
    perform: () => {
      attempts += 1;
      return Promise.resolve({
        body: { error: "provider_failed" },
        status: 502,
      });
    },
    request: {},
    store,
  });
  const retry = await run({
    perform: () => {
      attempts += 1;
      return Promise.resolve({ body: { ok: true }, status: 200 });
    },
    request: {},
    store,
  });

  assert.equal(failed.kind, "response");
  assert.equal(retry.kind, "response");
  assert.equal(attempts, 2);
});

test("successful responses can release their claim instead of being cached", async () => {
  const store = new MemoryIdempotencyStore();
  let attempts = 0;
  const perform = () => {
    attempts += 1;
    return Promise.resolve({
      body: { attempt: attempts },
      status: 200,
    });
  };

  const first = await runIdempotentOperation({
    cacheSuccessfulResponse: false,
    idempotencyKey: KEY,
    operation: OPERATION,
    ownerId: OWNER,
    perform,
    request: {},
    retentionMs: 60_000,
    store,
  });
  const retry = await runIdempotentOperation({
    cacheSuccessfulResponse: false,
    idempotencyKey: KEY,
    operation: OPERATION,
    ownerId: OWNER,
    perform,
    request: {},
    retentionMs: 60_000,
    store,
  });

  assert.deepEqual(first, {
    kind: "response",
    replayed: false,
    response: { body: { attempt: 1 }, status: 200 },
  });
  assert.deepEqual(retry, {
    kind: "response",
    replayed: false,
    response: { body: { attempt: 2 }, status: 200 },
  });
  assert.equal(store.releaseCount, 2);
  assert.equal(store.lastCompletedResponse, null);
});

test("non-caching callers reclaim a seeded completed response instead of replaying it", async () => {
  const store = new MemoryIdempotencyStore();
  store.seedCompleted({
    body: { url: "https://checkout.test/stale" },
    status: 200,
  });
  let providerCalls = 0;

  const result = await runIdempotentOperation({
    cacheSuccessfulResponse: false,
    idempotencyKey: KEY,
    operation: OPERATION,
    ownerId: OWNER,
    perform: () => {
      providerCalls += 1;
      return Promise.resolve({
        body: { url: "https://checkout.test/current" },
        status: 200,
      });
    },
    request: {},
    retentionMs: 60_000,
    store,
  });

  assert.deepEqual(result, {
    kind: "response",
    replayed: false,
    response: {
      body: { url: "https://checkout.test/current" },
      status: 200,
    },
  });
  assert.equal(providerCalls, 1);
});

test("non-caching callers reject a conflicting seeded completed response", async () => {
  const store = new MemoryIdempotencyStore();
  store.seedCompleted({
    body: { url: "https://checkout.test/stale" },
    status: 200,
  });
  let providerCalls = 0;

  const result = await runIdempotentOperation({
    cacheSuccessfulResponse: false,
    idempotencyKey: KEY,
    operation: OPERATION,
    ownerId: OWNER,
    perform: () => {
      providerCalls += 1;
      return Promise.resolve({
        body: { url: "https://checkout.test/current" },
        status: 200,
      });
    },
    request: { revision: 2 },
    retentionMs: 60_000,
    store,
  });

  assert.deepEqual(result, { kind: "conflict" });
  assert.equal(providerCalls, 0);
});

test("parallel non-caching claims safely reacquire one seeded completed record", async () => {
  const store = new MemoryIdempotencyStore();
  store.seedCompleted({
    body: { url: "https://checkout.test/stale" },
    status: 200,
  });
  let providerCalls = 0;
  let releaseProvider!: () => void;
  let signalProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    signalProviderStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const perform = async () => {
    providerCalls += 1;
    signalProviderStarted();
    await providerGate;
    return {
      body: { url: "https://checkout.test/current" },
      status: 200,
    };
  };

  const first = runIdempotentOperation({
    cacheSuccessfulResponse: false,
    idempotencyKey: KEY,
    operation: OPERATION,
    ownerId: OWNER,
    perform,
    request: {},
    retentionMs: 60_000,
    store,
  });
  assert.equal(
    await Promise.race([
      providerStarted.then(() => "started" as const),
      first.then(() => "finished" as const),
    ]),
    "started"
  );
  assert.equal(providerCalls, 1);

  const concurrent = await runIdempotentOperation({
    cacheSuccessfulResponse: false,
    idempotencyKey: KEY,
    operation: OPERATION,
    ownerId: OWNER,
    perform,
    request: {},
    retentionMs: 60_000,
    store,
  });

  assert.deepEqual(concurrent, { kind: "in_progress" });
  assert.equal(providerCalls, 1);
  releaseProvider();
  assert.equal((await first).kind, "response");
});

test("parallel claims permit exactly one provider call", async () => {
  const store = new MemoryIdempotencyStore();
  let providerCalls = 0;
  let releaseProvider!: () => void;
  let providerStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });

  const first = run({
    perform: async () => {
      providerCalls += 1;
      providerStarted();
      await providerGate;
      return { body: { ok: true }, status: 200 };
    },
    request: {},
    store,
  });
  await started;

  const followers = await Promise.all(
    Array.from({ length: 8 }, () =>
      run({
        perform: () => {
          providerCalls += 1;
          return Promise.resolve({
            body: { impossible: true },
            status: 200,
          });
        },
        request: {},
        store,
      })
    )
  );

  assert.equal(providerCalls, 1);
  assert.ok(followers.every((result) => result.kind === "in_progress"));

  releaseProvider();
  await first;
});

test("a renewable claim survives its original TTL and replays the completed response", async () => {
  const clock = new ManualClock();
  const timers = new ManualTimers();
  const store = new MemoryIdempotencyStore();
  let providerCalls = 0;
  let releaseProvider!: () => void;
  let signalProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    signalProviderStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });

  const first = runRenewable({
    createOwnerToken: () => "owner-one",
    now: clock.now,
    perform: async () => {
      providerCalls += 1;
      signalProviderStarted();
      await providerGate;
      return { body: { url: "https://checkout.test/renewed" }, status: 200 };
    },
    store,
    timers,
  });
  await providerStarted;

  clock.advance(CLAIM_TTL_MS / 2);
  await timers.runNext();
  clock.advance(CLAIM_TTL_MS / 2 + 1);

  const concurrent = await runRenewable({
    createOwnerToken: () => "owner-two",
    now: clock.now,
    perform: () => {
      providerCalls += 1;
      return Promise.resolve({
        body: { url: "https://checkout.test/impossible" },
        status: 200,
      });
    },
    store,
    timers,
  });

  assert.deepEqual(concurrent, { kind: "in_progress" });
  assert.equal(providerCalls, 1);

  releaseProvider();
  assert.equal((await first).kind, "response");

  const replay = await runRenewable({
    createOwnerToken: () => "owner-three",
    now: clock.now,
    perform: () => {
      providerCalls += 1;
      return Promise.resolve({
        body: { url: "https://checkout.test/impossible" },
        status: 200,
      });
    },
    store,
    timers,
  });
  assert.deepEqual(replay, {
    kind: "response",
    replayed: true,
    response: {
      body: { url: "https://checkout.test/renewed" },
      status: 200,
    },
  });
  assert.equal(providerCalls, 1);
  assert.deepEqual(store.claimedOwnerTokens, [
    "owner-one",
    "owner-two",
    "owner-three",
  ]);
  assert.equal(timers.activeCount, 0);
});

test("a stale renewable owner cannot complete its successor's record", async () => {
  const clock = new ManualClock();
  const timers = new ManualTimers();
  const store = new MemoryIdempotencyStore();
  let releaseFirst!: () => void;
  let releaseSuccessor!: () => void;
  let signalFirstStarted!: () => void;
  let signalSuccessorStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const successorStarted = new Promise<void>((resolve) => {
    signalSuccessorStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const successorGate = new Promise<void>((resolve) => {
    releaseSuccessor = resolve;
  });

  const first = runRenewable({
    createOwnerToken: () => "owner-one",
    now: clock.now,
    perform: async () => {
      signalFirstStarted();
      await firstGate;
      return { body: { owner: "stale" }, status: 200 };
    },
    store,
    timers,
  });
  await firstStarted;

  clock.advance(CLAIM_TTL_MS + 1);
  const successor = runRenewable({
    createOwnerToken: () => "owner-two",
    now: clock.now,
    perform: async () => {
      signalSuccessorStarted();
      await successorGate;
      return { body: { owner: "successor" }, status: 200 };
    },
    store,
    timers,
  });
  await successorStarted;

  releaseFirst();
  assert.deepEqual(await first, { kind: "in_progress" });
  releaseSuccessor();
  await successor;

  const replay = await runRenewable({
    createOwnerToken: () => "owner-three",
    now: clock.now,
    perform: () =>
      Promise.resolve({ body: { owner: "impossible" }, status: 200 }),
    store,
    timers,
  });
  assert.deepEqual(replay, {
    kind: "response",
    replayed: true,
    response: { body: { owner: "successor" }, status: 200 },
  });
  assert.deepEqual(store.claimedOwnerTokens.slice(0, 2), [
    "owner-one",
    "owner-two",
  ]);
});

test("a stale renewable owner cannot release its successor's record", async () => {
  const clock = new ManualClock();
  const timers = new ManualTimers();
  const store = new MemoryIdempotencyStore();
  let releaseFirst!: () => void;
  let releaseSuccessor!: () => void;
  let signalFirstStarted!: () => void;
  let signalSuccessorStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });
  const successorStarted = new Promise<void>((resolve) => {
    signalSuccessorStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const successorGate = new Promise<void>((resolve) => {
    releaseSuccessor = resolve;
  });

  const first = runRenewable({
    createOwnerToken: () => "owner-one",
    now: clock.now,
    perform: async () => {
      signalFirstStarted();
      await firstGate;
      return { body: { error: "retry" }, status: 502 };
    },
    store,
    timers,
  });
  await firstStarted;

  clock.advance(CLAIM_TTL_MS + 1);
  const successor = runRenewable({
    createOwnerToken: () => "owner-two",
    now: clock.now,
    perform: async () => {
      signalSuccessorStarted();
      await successorGate;
      return { body: { owner: "successor" }, status: 200 };
    },
    store,
    timers,
  });
  await successorStarted;

  releaseFirst();
  assert.deepEqual(await first, { kind: "in_progress" });

  const blocked = await runRenewable({
    createOwnerToken: () => "owner-three",
    now: clock.now,
    perform: () =>
      Promise.resolve({ body: { owner: "impossible" }, status: 200 }),
    store,
    timers,
  });
  assert.deepEqual(blocked, { kind: "in_progress" });
  assert.deepEqual(store.claimedOwnerTokens.slice(0, 2), [
    "owner-one",
    "owner-two",
  ]);

  releaseSuccessor();
  await successor;
});

test("response storage encodes on completion and decodes only on replay", async () => {
  const store = new MemoryIdempotencyStore();
  let replayCalls = 0;
  let storeCalls = 0;
  const responseStorage: IdempotencyResponseStorage = {
    replay(envelope) {
      replayCalls += 1;
      assert.equal(envelope.kind, "encrypted_json");
      return Promise.resolve({ deviceCode: "device-secret" });
    },
    store(body) {
      storeCalls += 1;
      assert.deepEqual(body, { deviceCode: "device-secret" });
      return Promise.resolve(encryptedTestEnvelope());
    },
  };

  const first = await run({
    perform: () =>
      Promise.resolve({
        body: { deviceCode: "device-secret" },
        status: 200,
      }),
    request: {},
    responseStorage,
    store,
  });
  assert.equal(first.kind, "response");
  assert.equal(storeCalls, 1);
  assert.equal(replayCalls, 0);
  assert.equal(store.lastCompletedResponse?.envelope.kind, "encrypted_json");

  const replay = await run({
    perform: () => Promise.resolve({ body: { impossible: true }, status: 200 }),
    request: {},
    responseStorage,
    store,
  });

  assert.deepEqual(replay, {
    kind: "response",
    replayed: true,
    response: { body: { deviceCode: "device-secret" }, status: 200 },
  });
  assert.equal(storeCalls, 1);
  assert.equal(replayCalls, 1);
});

test("cleanup failure fails closed before a claim or provider call", async () => {
  const store = new MemoryIdempotencyStore();
  store.cleanupFailure = new Error("cleanup failed");
  let providerCalls = 0;

  await assert.rejects(
    run({
      perform: () => {
        providerCalls += 1;
        return Promise.resolve({ body: { ok: true }, status: 200 });
      },
      request: {},
      store,
    }),
    /cleanup failed/
  );

  assert.equal(store.claimCount, 0);
  assert.equal(providerCalls, 0);
  assert.equal(store.lastCleanupLimit, 100);
});

test("raw keys are validated, hashed before storage, and never used as provider keys", async () => {
  const store = new MemoryIdempotencyStore();
  let providerKey = "";

  await Promise.all(
    [
      null,
      "short",
      `valid-key-${String.fromCharCode(31)}-but-control`,
      "x".repeat(129),
    ].map(async (idempotencyKey) => {
      const result = await runIdempotentOperation({
        idempotencyKey,
        operation: OPERATION,
        ownerId: OWNER,
        perform: () =>
          Promise.resolve({ body: { impossible: true }, status: 200 }),
        request: {},
        retentionMs: 1000,
        store,
      });
      assert.equal(
        result.kind,
        idempotencyKey === null ? "missing_key" : "invalid_key"
      );
    })
  );

  await run({
    perform: (input) => {
      providerKey = input.providerIdempotencyKey;
      return Promise.resolve({ body: { ok: true }, status: 200 });
    },
    request: {},
    store,
  });

  assert.equal(store.lastClaim?.keyHash.length, 64);
  assert.notEqual(store.lastClaim?.keyHash, KEY);
  assert.equal(providerKey.includes(KEY), false);
  assert.match(providerKey, /^coven_[a-f0-9]{64}$/);
});

test("replayed responses are non-cacheable and identify safe replay", async () => {
  const response = idempotencyResultResponse({
    kind: "response",
    replayed: true,
    response: { body: { ok: true }, status: 202 },
  });

  assert.equal(response.status, 202);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("idempotency-replayed"), "true");
  assert.deepEqual(await response.json(), { ok: true });
});

test("idempotency conflicts have stable explicit errors", async () => {
  await Promise.all(
    (
      [
        ["missing_key", 400, "idempotency_key_required"],
        ["invalid_key", 400, "invalid_idempotency_key"],
        ["conflict", 409, "idempotency_conflict"],
        ["in_progress", 409, "request_in_progress"],
      ] as const
    ).map(async ([kind, status, error]) => {
      const response = idempotencyResultResponse({ kind });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
    })
  );
});

function run(options: {
  now?: () => Date;
  perform: Parameters<typeof runIdempotentOperation>[0]["perform"];
  request: Parameters<typeof runIdempotentOperation>[0]["request"];
  responseStorage?: IdempotencyResponseStorage;
  retentionMs?: number;
  store: IdempotencyStore;
}) {
  return runIdempotentOperation({
    idempotencyKey: KEY,
    now: options.now,
    operation: OPERATION,
    ownerId: OWNER,
    perform: options.perform,
    request: options.request,
    responseStorage: options.responseStorage,
    retentionMs: options.retentionMs ?? 60_000,
    store: options.store,
  });
}

function runRenewable(options: {
  createOwnerToken: () => string;
  now: () => Date;
  perform: Parameters<typeof runIdempotentOperation>[0]["perform"];
  store: IdempotencyStore;
  timers: ManualTimers;
}) {
  const renewableRun = runIdempotentOperation as (
    input: Parameters<typeof runIdempotentOperation>[0] & {
      claimLease: {
        createOwnerToken: () => string;
        timers: ManualTimers;
      };
    }
  ) => ReturnType<typeof runIdempotentOperation>;
  return renewableRun({
    claimLease: {
      createOwnerToken: options.createOwnerToken,
      timers: options.timers,
    },
    idempotencyKey: KEY,
    now: options.now,
    operation: OPERATION,
    ownerId: OWNER,
    perform: options.perform,
    request: {},
    retentionMs: 60_000,
    store: options.store,
  });
}

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

class ManualTimers {
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

type MemoryRecord = {
  claimExpiresAt: Date;
  envelope: StoredIdempotencyResponseEnvelope | null;
  ownerToken: string | null;
  requestHash: string;
  state: "completed" | "in_progress";
  status: number | null;
  expiresAt: Date;
};

class MemoryIdempotencyStore implements IdempotencyStore {
  claimedOwnerTokens: Array<string | null> = [];
  claimCount = 0;
  cleanupDeletedStates: MemoryRecord["state"][] = [];
  cleanupFailure: Error | null = null;
  lastClaim: IdempotencyClaimInput | null = null;
  lastCleanupLimit: number | null = null;
  lastCompletedResponse: IdempotencyCompleteInput["response"] | null = null;
  releaseCount = 0;
  private readonly records = new Map<string, MemoryRecord>();

  cleanupExpired(input: { before: Date; limit: number }): Promise<void> {
    this.lastCleanupLimit = input.limit;
    if (this.cleanupFailure) {
      return Promise.reject(this.cleanupFailure);
    }

    let deleted = 0;
    for (const [scope, record] of this.records) {
      if (
        deleted < input.limit &&
        record.expiresAt.getTime() <= input.before.getTime()
      ) {
        this.cleanupDeletedStates.push(record.state);
        this.records.delete(scope);
        deleted += 1;
      }
    }
    return Promise.resolve();
  }

  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.claimCount += 1;
    this.claimedOwnerTokens.push(ownerToken(input));
    this.lastClaim = input;
    const scope = scoped(input);
    const existing = this.records.get(scope);

    if (
      existing?.state === "completed" &&
      "reclaimCompleted" in input &&
      input.reclaimCompleted === true &&
      existing.requestHash === input.requestHash
    ) {
      this.records.set(scope, {
        claimExpiresAt: input.claimExpiresAt,
        envelope: null,
        expiresAt: input.claimExpiresAt,
        ownerToken:
          "ownerToken" in input && typeof input.ownerToken === "string"
            ? input.ownerToken
            : null,
        requestHash: input.requestHash,
        state: "in_progress",
        status: null,
      });
      return Promise.resolve({
        claim: claimHandle(input),
        kind: "claimed",
      });
    }

    if (!existing || existing.expiresAt.getTime() <= input.now.getTime()) {
      this.records.set(scope, {
        claimExpiresAt: input.claimExpiresAt,
        envelope: null,
        expiresAt: input.claimExpiresAt,
        ownerToken:
          "ownerToken" in input && typeof input.ownerToken === "string"
            ? input.ownerToken
            : null,
        requestHash: input.requestHash,
        state: "in_progress",
        status: null,
      });
      return Promise.resolve({
        claim: claimHandle(input),
        kind: "claimed",
      });
    }

    if (existing.requestHash !== input.requestHash) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (existing.state === "in_progress") {
      return Promise.resolve({ kind: "in_progress" });
    }
    assert.ok(existing.envelope);
    assert.ok(existing.status);
    return Promise.resolve({
      kind: "completed",
      response: {
        envelope: existing.envelope,
        status: existing.status,
      },
    });
  }

  seedCompleted(response: IdempotencyResponse) {
    const now = new Date("2026-08-31T00:00:00.000Z");
    this.records.set(`${OWNER}:${OPERATION}:${sha256(KEY)}`, {
      claimExpiresAt: now,
      envelope: {
        body: response.body,
        kind: "plain_json",
      },
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
      ownerToken: null,
      requestHash: sha256("{}"),
      state: "completed",
      status: response.status,
    });
  }

  complete(input: IdempotencyCompleteInput): Promise<"completed" | "lost"> {
    const record = this.records.get(scoped(input.claim));
    if (
      !record ||
      record.claimExpiresAt.getTime() !==
        input.claim.claimExpiresAt.getTime() ||
      record.ownerToken !== ownerToken(input.claim)
    ) {
      return Promise.resolve("lost");
    }
    record.envelope = input.response.envelope;
    record.expiresAt = input.expiresAt;
    record.state = "completed";
    record.status = input.response.status;
    this.lastCompletedResponse = input.response;
    return Promise.resolve("completed");
  }

  release(input: IdempotencyReleaseInput): Promise<"lost" | "released"> {
    const scope = scoped(input.claim);
    const record = this.records.get(scope);
    if (
      record?.state === "in_progress" &&
      record.claimExpiresAt.getTime() ===
        input.claim.claimExpiresAt.getTime() &&
      record.ownerToken === ownerToken(input.claim)
    ) {
      this.records.delete(scope);
      this.releaseCount += 1;
      return Promise.resolve("released");
    }
    this.releaseCount += 1;
    return Promise.resolve("lost");
  }

  renew(input: IdempotencyRenewInput) {
    const record = this.records.get(scoped(input.claim));
    if (
      record?.state !== "in_progress" ||
      record.ownerToken !== ownerToken(input.claim) ||
      record.expiresAt.getTime() <= input.now.getTime()
    ) {
      return Promise.resolve({ kind: "lost" } as const);
    }
    record.claimExpiresAt = input.claimExpiresAt;
    record.expiresAt = input.claimExpiresAt;
    return Promise.resolve({
      claim: {
        ...input.claim,
        claimExpiresAt: input.claimExpiresAt,
      },
      kind: "renewed",
    } as const);
  }
}

function encryptedTestEnvelope(): StoredIdempotencyResponseEnvelope {
  return {
    kind: "encrypted_json",
    payload: {
      aadVersion: 0,
      ciphertext: "ciphertext",
      iv: "iv",
      kekVersion: "v1",
      wrappedKey: "wrapped-key",
    },
  };
}

function reverseOrderedRequest() {
  const request: Record<string, number> = {};
  request.b = 2;
  request.a = 1;
  return request;
}

function scoped(input: {
  keyHash: string;
  operation: string;
  ownerId: string;
}): string {
  return `${input.ownerId}:${input.operation}:${input.keyHash}`;
}

function claimHandle(input: IdempotencyClaimInput) {
  return {
    claimExpiresAt: input.claimExpiresAt,
    keyHash: input.keyHash,
    operation: input.operation,
    ...("ownerToken" in input ? { ownerToken: input.ownerToken } : {}),
    ownerId: input.ownerId,
    requestHash: input.requestHash,
  };
}

function ownerToken(input: object): string | null {
  return "ownerToken" in input && typeof input.ownerToken === "string"
    ? input.ownerToken
    : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
