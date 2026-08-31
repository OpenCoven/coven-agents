import assert from "node:assert/strict";
import test from "node:test";
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompleteInput,
  IdempotencyReleaseInput,
  IdempotencyRenewInput,
  StoredIdempotencyResponse,
} from "../abuse/idempotency";
import {
  CREDENTIAL_DEVICE_POLL_RETENTION_MS,
  type CredentialDevicePollClaim,
  type CredentialDevicePollStore,
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
  claim: CredentialDevicePollClaim;
  expiresAt: Date;
  response: StoredIdempotencyResponse | null;
  state: "completed" | "in_progress";
};

class MemoryStore implements CredentialDevicePollStore<StoredCredential> {
  commitAttempts = 0;
  commitFailures: string[] = [];
  committed: IdempotencyCompleteInput | null = null;
  credentialWrites = 0;
  duplicateBeforeCommit = false;
  loseAuthorityBeforeCommit = false;
  loseFenceBeforeCommit = false;
  releaseCount = 0;
  readonly credentials = new Map<string, StoredCredential>();
  private nextRecord = 0;
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
    const { ownerToken } = input;
    assert.ok(ownerToken);
    const key = this.key(input);
    const existing = this.records.get(key);
    if (!existing) {
      this.nextRecord += 1;
      const claim: CredentialDevicePollClaim = {
        claimExpiresAt: input.claimExpiresAt,
        keyHash: input.keyHash,
        operation: input.operation,
        ownerId: input.ownerId,
        ownerToken,
        recordId: `record-${this.nextRecord}`,
        requestHash: input.requestHash,
      };
      this.records.set(key, {
        claim,
        expiresAt: input.claimExpiresAt,
        response: null,
        state: "in_progress",
      });
      return Promise.resolve({ claim, kind: "claimed" });
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

  complete(): Promise<"completed" | "lost"> {
    throw new Error("authorized device polls must use the atomic commit");
  }

  commitAuthorized(
    input: IdempotencyCompleteInput & {
      authVersion: number;
      claim: CredentialDevicePollClaim;
      credential: StoredCredential;
    }
  ) {
    this.commitAttempts += 1;
    const key = this.key(input.claim);
    const record = this.records.get(key);

    if (this.duplicateBeforeCommit && record) {
      this.duplicateBeforeCommit = false;
      record.claim = {
        ...record.claim,
        ownerToken: "concurrent-winner-token",
      };
      record.expiresAt = input.expiresAt;
      record.response = input.response;
      record.state = "completed";
      this.credentials.set(
        input.claim.ownerId,
        structuredClone(input.credential)
      );
      this.credentialWrites += 1;
    } else if (this.loseFenceBeforeCommit && record) {
      this.loseFenceBeforeCommit = false;
      record.claim = {
        ...record.claim,
        ownerToken: "replacement-owner-token",
      };
    }

    if (
      !record ||
      record.claim.recordId !== input.claim.recordId ||
      record.claim.ownerToken !== input.claim.ownerToken ||
      record.claim.requestHash !== input.claim.requestHash ||
      record.claim.claimExpiresAt.getTime() !==
        input.claim.claimExpiresAt.getTime() ||
      record.expiresAt.getTime() <= input.completedAt.getTime() ||
      record.state !== "in_progress"
    ) {
      if (
        record?.state === "completed" &&
        record.claim.recordId === input.claim.recordId &&
        record.claim.requestHash === input.claim.requestHash &&
        record.response
      ) {
        return Promise.resolve({
          kind: "replayed",
          response: record.response,
        } as const);
      }
      return Promise.resolve("lost" as const);
    }

    if (this.loseAuthorityBeforeCommit) {
      this.loseAuthorityBeforeCommit = false;
      return Promise.resolve("authority_lost" as const);
    }

    const failureCode = this.commitFailures.shift();
    if (failureCode) {
      return Promise.reject(
        Object.assign(new Error("transaction commit failed"), {
          code: failureCode,
        })
      );
    }

    record.expiresAt = input.expiresAt;
    record.response = input.response;
    record.state = "completed";
    this.credentials.set(
      input.claim.ownerId,
      structuredClone(input.credential)
    );
    this.credentialWrites += 1;
    this.committed = input;
    return Promise.resolve("completed" as const);
  }

  release(input: IdempotencyReleaseInput) {
    const key = this.key(input.claim);
    const record = this.records.get(key);
    if (
      record?.state === "in_progress" &&
      record.claim.recordId === input.claim.recordId &&
      record.claim.ownerToken === input.claim.ownerToken
    ) {
      this.records.delete(key);
      this.releaseCount += 1;
      return Promise.resolve("released" as const);
    }
    this.releaseCount += 1;
    return Promise.resolve("lost" as const);
  }

  renew(input: IdempotencyRenewInput) {
    const record = this.records.get(this.key(input.claim));
    if (
      record?.state !== "in_progress" ||
      record.claim.recordId !== input.claim.recordId ||
      record.claim.ownerToken !== input.claim.ownerToken ||
      record.expiresAt.getTime() <= input.now.getTime()
    ) {
      return Promise.resolve({ kind: "lost" } as const);
    }
    const claim = {
      ...record.claim,
      claimExpiresAt: input.claimExpiresAt,
    };
    record.claim = claim;
    record.expiresAt = input.claimExpiresAt;
    return Promise.resolve({ claim, kind: "renewed" } as const);
  }

  private key(input: { keyHash: string; operation: string; ownerId: string }) {
    return `${input.ownerId}:${input.operation}:${input.keyHash}`;
  }
}

function authorized(): DeviceExchange {
  return { credential: CREDENTIAL, kind: "authorized" };
}

function poll(
  store: MemoryStore,
  overrides: Partial<{
    exchange: () => Promise<DeviceExchange | { kind: "unavailable" }>;
    idempotencyKey: string | null;
    ownerId: string;
    prepareCredential: (
      credential: StoredCredential
    ) => Promise<StoredCredential>;
    revalidateAuthority: () => Promise<boolean>;
  }> = {}
) {
  return runCredentialDevicePoll({
    authVersion: 4,
    deviceCode: DEVICE_CODE,
    exchange: overrides.exchange ?? (() => Promise.resolve(authorized())),
    idempotencyKey:
      "idempotencyKey" in overrides ? (overrides.idempotencyKey ?? null) : KEY,
    ownerId: overrides.ownerId ?? OWNER_A,
    prepareCredential:
      overrides.prepareCredential ??
      ((credential) => Promise.resolve(structuredClone(credential))),
    revalidateAuthority:
      overrides.revalidateAuthority ?? (() => Promise.resolve(true)),
    store,
  });
}

test("a lost authorized response replays without exchanging or storing twice", async () => {
  const store = new MemoryStore();
  let exchanges = 0;
  let preparations = 0;
  const run = () =>
    poll(store, {
      exchange: () => {
        exchanges += 1;
        return Promise.resolve(authorized());
      },
      prepareCredential: (credential) => {
        preparations += 1;
        return Promise.resolve(structuredClone(credential));
      },
    });

  assert.equal((await run()).kind, "response");
  const replay = await run();

  assert.deepEqual(replay, {
    kind: "response",
    replayed: true,
    response: { body: { status: "authorized" }, status: 200 },
  });
  assert.equal(exchanges, 1);
  assert.equal(preparations, 1);
  assert.equal(store.credentialWrites, 1);
});

test("pending releases the key so a later authorized poll can complete", async () => {
  const store = new MemoryStore();
  const results: DeviceExchange[] = [{ kind: "pending" }, authorized()];
  const exchange = () => Promise.resolve(results.shift() ?? authorized());

  assert.deepEqual(await poll(store, { exchange }), {
    kind: "response",
    replayed: false,
    response: { body: { status: "pending" }, status: 200 },
  });
  assert.deepEqual(await poll(store, { exchange }), {
    kind: "response",
    replayed: false,
    response: { body: { status: "authorized" }, status: 200 },
  });
  assert.equal(store.releaseCount, 1);
  assert.equal(store.credentialWrites, 1);
});

test("provider configuration errors release the key for a later retry", async () => {
  const store = new MemoryStore();

  assert.deepEqual(
    await poll(store, {
      exchange: () => Promise.resolve({ kind: "unavailable" }),
    }),
    {
      kind: "response",
      replayed: false,
      response: { body: { error: "github_unconfigured" }, status: 503 },
    }
  );
  assert.equal((await poll(store)).kind, "response");
  assert.equal(store.releaseCount, 1);
  assert.equal(store.credentialWrites, 1);
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
  const run = () =>
    poll(store, {
      exchange: async () => {
        exchanges += 1;
        exchangeStarted();
        await gate;
        return authorized();
      },
    });

  const first = run();
  await started;
  assert.deepEqual(await run(), { kind: "in_progress" });
  assert.equal(exchanges, 1);
  releaseExchange();
  await first;
});

test("a transient transaction failure retries without re-exchanging or re-encrypting", async () => {
  const store = new MemoryStore();
  store.commitFailures.push("40001");
  let exchanges = 0;
  let preparations = 0;

  const result = await poll(store, {
    exchange: () => {
      exchanges += 1;
      return Promise.resolve(authorized());
    },
    prepareCredential: (credential) => {
      preparations += 1;
      return Promise.resolve(structuredClone(credential));
    },
  });

  assert.deepEqual(result, {
    kind: "response",
    replayed: false,
    response: { body: { status: "authorized" }, status: 200 },
  });
  assert.equal(exchanges, 1);
  assert.equal(preparations, 1);
  assert.equal(store.commitAttempts, 2);
  assert.equal(store.credentialWrites, 1);
});

test("an unrecoverable transaction failure returns an explicit 503 and releases the claim", async () => {
  const store = new MemoryStore();
  store.commitFailures.push("XX000");

  const result = await poll(store);

  assert.deepEqual(result, {
    kind: "response",
    replayed: false,
    response: {
      body: { error: "credential_storage_unavailable" },
      status: 503,
    },
  });
  assert.equal(store.credentials.size, 0);
  assert.equal(store.committed, null);
  assert.equal(store.releaseCount, 1);
});

test("authority lost after provider exchange returns 403 without publishing poll state", async () => {
  const store = new MemoryStore();
  let revalidations = 0;

  const result = await poll(store, {
    exchange: () => Promise.resolve({ kind: "pending" }),
    revalidateAuthority: () => {
      revalidations += 1;
      return Promise.resolve(false);
    },
  });

  assert.deepEqual(result, {
    kind: "response",
    replayed: false,
    response: {
      body: { error: "subscription_required" },
      status: 403,
    },
  });
  assert.equal(revalidations, 1);
  assert.equal(store.releaseCount, 1);
});

test("authority lost inside the commit transaction stores no credential", async () => {
  const store = new MemoryStore();
  store.loseAuthorityBeforeCommit = true;

  assert.deepEqual(await poll(store), {
    kind: "response",
    replayed: false,
    response: {
      body: { error: "subscription_required" },
      status: 403,
    },
  });
  assert.equal(store.credentialWrites, 0);
  assert.equal(store.releaseCount, 1);
});

test("a lost exact fence does not write a credential or report authorization", async () => {
  const store = new MemoryStore();
  store.loseFenceBeforeCommit = true;

  assert.deepEqual(await poll(store), { kind: "in_progress" });
  assert.equal(store.credentialWrites, 0);
  assert.equal(store.committed, null);
});

test("a concurrently completed exact record replays without a second credential write", async () => {
  const store = new MemoryStore();
  store.duplicateBeforeCommit = true;

  assert.deepEqual(await poll(store), {
    kind: "response",
    replayed: true,
    response: { body: { status: "authorized" }, status: 200 },
  });
  assert.equal(store.credentialWrites, 1);
  assert.equal(store.committed, null);
});

test("the completed response is bounded and contains no credential or device code", async () => {
  const store = new MemoryStore();
  await poll(store);

  assert.deepEqual(store.committed?.response, {
    envelope: {
      body: { status: "authorized" },
      kind: "plain_json",
    },
    status: 200,
  });
  assert.equal(
    store.committed?.expiresAt.getTime() -
      store.committed?.completedAt.getTime(),
    CREDENTIAL_DEVICE_POLL_RETENTION_MS
  );
  assert.doesNotMatch(
    JSON.stringify(store.committed?.response),
    /access-secret|refresh-secret|device-secret/
  );
});

test("missing and malformed keys are rejected before provider work", async () => {
  const results = await Promise.all(
    [null, "short"].map(async (idempotencyKey) => {
      const store = new MemoryStore();
      let exchanges = 0;
      const result = await poll(store, {
        exchange: () => {
          exchanges += 1;
          return Promise.resolve(authorized());
        },
        idempotencyKey,
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
  const run = (ownerId: string) =>
    poll(store, {
      exchange: () => {
        exchanges += 1;
        return Promise.resolve(authorized());
      },
      ownerId,
    });

  assert.equal((await run(OWNER_A)).kind, "response");
  assert.equal((await run(OWNER_B)).kind, "response");
  assert.equal(exchanges, 2);
  assert.equal(store.credentials.size, 2);
});

test("credential preparation failure returns 503 without completing authorization", async () => {
  const store = new MemoryStore();

  assert.deepEqual(
    await poll(store, {
      prepareCredential: () =>
        Promise.reject(new Error("credential encryption unavailable")),
    }),
    {
      kind: "response",
      replayed: false,
      response: {
        body: { error: "credential_storage_unavailable" },
        status: 503,
      },
    }
  );
  assert.equal(store.commitAttempts, 0);
  assert.equal(store.credentials.size, 0);
  assert.equal(store.releaseCount, 1);
});
