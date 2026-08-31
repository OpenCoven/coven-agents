import assert from "node:assert/strict";
import test from "node:test";
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompleteInput,
  IdempotencyReleaseInput,
  IdempotencyStore,
  StoredIdempotencyResponse,
} from "../abuse/idempotency";
import {
  CREDENTIAL_DEVICE_POLL_RETENTION_MS,
  runCredentialDevicePoll,
} from "./device-poll";
import type { DeviceExchange } from "./github-device";
import type { StoredCredential } from "./shape";

const KEY = "device-poll-key-1234567890";
const OWNER_A = "00000000-0000-4000-8000-000000000001";
const OWNER_B = "00000000-0000-4000-8000-000000000002";
const DEVICE_CODE = "device-secret";
const CREDENTIAL: StoredCredential = {
  access: "access-secret",
  expiresAt: 1_900_000_000_000,
  kind: "oauth",
  refresh: "refresh-secret",
};

type RecordState = {
  claim: IdempotencyClaimInput;
  expiresAt: Date;
  response: StoredIdempotencyResponse | null;
  state: "completed" | "in_progress";
};

class MemoryStore implements IdempotencyStore {
  completed: IdempotencyCompleteInput | null = null;
  releaseCount = 0;
  private readonly records = new Map<string, RecordState>();

  cleanupExpired({ before }: { before: Date; limit: number }) {
    for (const [key, record] of this.records) {
      if (record.expiresAt <= before) {
        this.records.delete(key);
      }
    }
    return Promise.resolve();
  }

  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    const key = this.key(input);
    const existing = this.records.get(key);
    if (!existing) {
      this.records.set(key, {
        claim: input,
        expiresAt: input.claimExpiresAt,
        response: null,
        state: "in_progress",
      });
      return Promise.resolve({
        claim: {
          claimExpiresAt: input.claimExpiresAt,
          keyHash: input.keyHash,
          operation: input.operation,
          ownerId: input.ownerId,
          requestHash: input.requestHash,
        },
        kind: "claimed",
      });
    }
    if (existing.claim.requestHash !== input.requestHash) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (existing.state === "in_progress") {
      return Promise.resolve({ kind: "in_progress" });
    }
    assert.ok(existing.response);
    return Promise.resolve({
      kind: "completed",
      response: existing.response,
    });
  }

  complete(input: IdempotencyCompleteInput) {
    const record = this.records.get(this.key(input.claim));
    assert.ok(record);
    record.expiresAt = input.expiresAt;
    record.response = input.response;
    record.state = "completed";
    this.completed = input;
    return Promise.resolve("completed" as const);
  }

  release(input: IdempotencyReleaseInput) {
    this.records.delete(this.key(input.claim));
    this.releaseCount += 1;
    return Promise.resolve("released" as const);
  }

  private key(input: { keyHash: string; operation: string; ownerId: string }) {
    return `${input.ownerId}:${input.operation}:${input.keyHash}`;
  }
}

function authorized(): DeviceExchange {
  return { credential: CREDENTIAL, kind: "authorized" };
}

test("a lost authorized response replays without exchanging or storing twice", async () => {
  const store = new MemoryStore();
  let exchanges = 0;
  let writes = 0;
  const poll = () =>
    runCredentialDevicePoll({
      deviceCode: DEVICE_CODE,
      exchange: () => {
        exchanges += 1;
        return Promise.resolve(authorized());
      },
      idempotencyKey: KEY,
      ownerId: OWNER_A,
      store,
      storeCredential: () => {
        writes += 1;
        return Promise.resolve();
      },
    });

  const lostResponse = await poll();
  assert.equal(lostResponse.kind, "response");
  const replay = await poll();

  assert.deepEqual(replay, {
    kind: "response",
    replayed: true,
    response: { body: { status: "authorized" }, status: 200 },
  });
  assert.equal(exchanges, 1);
  assert.equal(writes, 1);
});

test("pending releases the key so a later authorized poll can complete", async () => {
  const store = new MemoryStore();
  const results: DeviceExchange[] = [{ kind: "pending" }, authorized()];
  let writes = 0;
  const poll = () =>
    runCredentialDevicePoll({
      deviceCode: DEVICE_CODE,
      exchange: () => Promise.resolve(results.shift() ?? authorized()),
      idempotencyKey: KEY,
      ownerId: OWNER_A,
      store,
      storeCredential: () => {
        writes += 1;
        return Promise.resolve();
      },
    });

  assert.deepEqual(await poll(), {
    kind: "response",
    replayed: false,
    response: { body: { status: "pending" }, status: 200 },
  });
  assert.deepEqual(await poll(), {
    kind: "response",
    replayed: false,
    response: { body: { status: "authorized" }, status: 200 },
  });
  assert.equal(store.releaseCount, 1);
  assert.equal(writes, 1);
});

test("provider configuration errors release the key for a later retry", async () => {
  const store = new MemoryStore();
  let configured = false;
  let writes = 0;
  const poll = () =>
    runCredentialDevicePoll({
      deviceCode: DEVICE_CODE,
      exchange: () =>
        Promise.resolve(configured ? authorized() : { kind: "unavailable" }),
      idempotencyKey: KEY,
      ownerId: OWNER_A,
      store,
      storeCredential: () => {
        writes += 1;
        return Promise.resolve();
      },
    });

  assert.deepEqual(await poll(), {
    kind: "response",
    replayed: false,
    response: { body: { error: "github_unconfigured" }, status: 503 },
  });
  configured = true;
  assert.deepEqual(await poll(), {
    kind: "response",
    replayed: false,
    response: { body: { status: "authorized" }, status: 200 },
  });
  assert.equal(store.releaseCount, 1);
  assert.equal(writes, 1);
});

test("concurrent same-key polls permit one provider exchange", async () => {
  const store = new MemoryStore();
  let releaseExchange!: () => void;
  let exchangeStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    exchangeStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseExchange = resolve;
  });
  let exchanges = 0;
  const poll = () =>
    runCredentialDevicePoll({
      deviceCode: DEVICE_CODE,
      exchange: async () => {
        exchanges += 1;
        exchangeStarted();
        await gate;
        return authorized();
      },
      idempotencyKey: KEY,
      ownerId: OWNER_A,
      store,
      storeCredential: () => Promise.resolve(),
    });

  const first = poll();
  await started;
  assert.deepEqual(await poll(), { kind: "in_progress" });
  assert.equal(exchanges, 1);
  releaseExchange();
  await first;
});

test("the cached response contains only the authorized status", async () => {
  const store = new MemoryStore();
  await runCredentialDevicePoll({
    deviceCode: DEVICE_CODE,
    exchange: () => Promise.resolve(authorized()),
    idempotencyKey: KEY,
    ownerId: OWNER_A,
    store,
    storeCredential: () => Promise.resolve(),
  });

  assert.deepEqual(store.completed?.response, {
    envelope: {
      body: { status: "authorized" },
      kind: "plain_json",
    },
    status: 200,
  });
  assert.equal(
    store.completed?.expiresAt.getTime() -
      store.completed?.completedAt.getTime(),
    CREDENTIAL_DEVICE_POLL_RETENTION_MS
  );
  assert.doesNotMatch(JSON.stringify(store.completed?.response), /secret/);
});

test("missing and malformed keys are rejected before provider work", async () => {
  const results = await Promise.all(
    [null, "short"].map(async (idempotencyKey) => {
      const store = new MemoryStore();
      let exchanges = 0;
      const result = await runCredentialDevicePoll({
        deviceCode: DEVICE_CODE,
        exchange: () => {
          exchanges += 1;
          return Promise.resolve(authorized());
        },
        idempotencyKey,
        ownerId: OWNER_A,
        store,
        storeCredential: () => Promise.resolve(),
      });
      return { exchanges, idempotencyKey, result };
    })
  );

  for (const { exchanges, idempotencyKey, result } of results) {
    assert.equal(
      result.kind,
      idempotencyKey === null ? "missing_key" : "invalid_key"
    );
    assert.equal(exchanges, 0);
  }
});

test("the same browser key is scoped independently to each authenticated owner", async () => {
  const store = new MemoryStore();
  let exchanges = 0;
  const poll = (ownerId: string) =>
    runCredentialDevicePoll({
      deviceCode: DEVICE_CODE,
      exchange: () => {
        exchanges += 1;
        return Promise.resolve(authorized());
      },
      idempotencyKey: KEY,
      ownerId,
      store,
      storeCredential: () => Promise.resolve(),
    });

  assert.equal((await poll(OWNER_A)).kind, "response");
  assert.equal((await poll(OWNER_B)).kind, "response");
  assert.equal(exchanges, 2);
});

test("credential storage failure releases the claim and never authorizes", async () => {
  const store = new MemoryStore();
  let writes = 0;
  const poll = () =>
    runCredentialDevicePoll({
      deviceCode: DEVICE_CODE,
      exchange: () => Promise.resolve(authorized()),
      idempotencyKey: KEY,
      ownerId: OWNER_A,
      store,
      storeCredential: () => {
        writes += 1;
        return writes === 1
          ? Promise.reject(new Error("database unavailable"))
          : Promise.resolve();
      },
    });

  await assert.rejects(poll(), /database unavailable/);
  assert.equal(store.completed, null);
  assert.equal(store.releaseCount, 1);
  assert.deepEqual(await poll(), {
    kind: "response",
    replayed: false,
    response: { body: { status: "authorized" }, status: 200 },
  });
});
