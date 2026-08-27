import assert from "node:assert/strict";
import test from "node:test";
import {
  type IdempotencyClaimInput,
  type IdempotencyClaimResult,
  type IdempotencyCompleteInput,
  type IdempotencyReleaseInput,
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

type MemoryRecord = {
  claimExpiresAt: Date;
  envelope: StoredIdempotencyResponseEnvelope | null;
  requestHash: string;
  state: "completed" | "in_progress";
  status: number | null;
  expiresAt: Date;
};

class MemoryIdempotencyStore implements IdempotencyStore {
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
    this.lastClaim = input;
    const scope = scoped(input);
    const existing = this.records.get(scope);

    if (!existing || existing.expiresAt.getTime() <= input.now.getTime()) {
      this.records.set(scope, {
        claimExpiresAt: input.claimExpiresAt,
        envelope: null,
        expiresAt: input.claimExpiresAt,
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

  complete(input: IdempotencyCompleteInput): Promise<void> {
    const record = this.records.get(scoped(input.claim));
    assert.ok(record);
    assert.equal(
      record.claimExpiresAt.getTime(),
      input.claim.claimExpiresAt.getTime()
    );
    record.envelope = input.response.envelope;
    record.expiresAt = input.expiresAt;
    record.state = "completed";
    record.status = input.response.status;
    this.lastCompletedResponse = input.response;
    return Promise.resolve();
  }

  release(input: IdempotencyReleaseInput): Promise<void> {
    const scope = scoped(input.claim);
    const record = this.records.get(scope);
    if (
      record?.state === "in_progress" &&
      record.claimExpiresAt.getTime() === input.claim.claimExpiresAt.getTime()
    ) {
      this.records.delete(scope);
    }
    this.releaseCount += 1;
    return Promise.resolve();
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
    ownerId: input.ownerId,
    requestHash: input.requestHash,
  };
}
