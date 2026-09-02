import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { tenantHashForReservation } from "@/lib/billing/run-reservations";
import type { RunReservation } from "@/lib/db/schema";
import {
  type CredentialLeaseDatabase,
  CredentialLeaseDeniedError,
  type CredentialLeaseRecord,
  type CredentialLeaseTransaction,
  consumeCredentialLease,
  issueCredentialLease,
  releaseCredentialLease,
  releaseCredentialLeaseForRun,
} from "./leases";

const NOW = new Date("2026-08-27T19:00:00.000Z");
const TENANT = "tenant_acme";
const SECRET = "fixed-test-abuse-key-secret";
const NO_AUDIT = () => undefined;
const NO_PREPARE = () => Promise.resolve();

function requestHash(requestId = "request-1"): string {
  return createHmac("sha256", SECRET)
    .update("credential-lease-request\0", "utf8")
    .update(requestId, "utf8")
    .digest("hex");
}

function operationHash(operationId = "operation-1"): string {
  return createHmac("sha256", SECRET)
    .update("credential-lease-operation\0", "utf8")
    .update(operationId, "utf8")
    .digest("hex");
}

function reservation(overrides: Partial<RunReservation> = {}): RunReservation {
  return {
    consumedAt: null,
    costUnits: 15,
    durationSeconds: null,
    expiresAt: new Date(NOW.getTime() + 300_000),
    meteredAt: null,
    meteringOutcome: null,
    periodDay: "2026-08-27",
    periodMonth: new Date("2026-08-01T00:00:00.000Z"),
    releasedAt: null,
    reservedAt: NOW,
    reservedUnits: 15,
    runId: "run-1",
    settledAt: null,
    state: "reserved",
    tenantHash: tenantHashForReservation(TENANT, SECRET),
    ...overrides,
  };
}

function lease(
  overrides: Partial<CredentialLeaseRecord> = {}
): CredentialLeaseRecord {
  return {
    consumedAt: null,
    expiresAt: new Date(NOW.getTime() + 120_000),
    harnessId: "copilot",
    issuedAt: NOW,
    operationIdHash: operationHash(),
    requestIdHash: requestHash(),
    runId: "run-1",
    tenantHash: tenantHashForReservation(TENANT, SECRET),
    ...overrides,
  };
}

function memoryDatabase(options: {
  events?: string[];
  leases?: CredentialLeaseRecord[];
  reservation?: RunReservation | null;
}): CredentialLeaseDatabase & { leases: CredentialLeaseRecord[] } {
  const stored = [...(options.leases ?? [])];
  const database = {
    cleanupExpiredBefore: (cutoff: Date) => {
      for (let index = stored.length - 1; index >= 0; index -= 1) {
        if (stored[index]?.expiresAt < cutoff) {
          stored.splice(index, 1);
        }
      }
      return Promise.resolve();
    },
    leases: stored,
    transaction: async <T>(
      callback: (tx: CredentialLeaseTransaction) => Promise<T>
    ): Promise<T> => {
      const working = stored.map((row) => ({ ...row }));
      const tx: CredentialLeaseTransaction = {
        consumeReservation: (_runId, _tenant, consumedAt) => {
          options.events?.push("consume-reservation");
          const current = options.reservation ?? null;
          if (
            current?.state !== "reserved" ||
            current.expiresAt <= consumedAt
          ) {
            return Promise.resolve(null);
          }
          return Promise.resolve({
            ...current,
            consumedAt,
            state: "consumed",
          });
        },
        credentialStore: {} as CredentialLeaseTransaction["credentialStore"],
        deleteByRequestIdHash: (requestIdHash) => {
          const index = working.findIndex(
            (row) => row.requestIdHash === requestIdHash
          );
          if (index < 0) {
            return Promise.resolve(null);
          }
          const [deleted] = working.splice(index, 1);
          return Promise.resolve(deleted ?? null);
        },
        findByOperationIdHash: (operationIdHash) =>
          Promise.resolve(
            working.find((row) => row.operationIdHash === operationIdHash) ??
              null
          ),
        findByRequestIdHash: (requestIdHash) =>
          Promise.resolve(
            working.find((row) => row.requestIdHash === requestIdHash) ?? null
          ),
        findByRunId: (runId) =>
          Promise.resolve(working.find((row) => row.runId === runId) ?? null),
        findReservationForUpdate: () => {
          options.events?.push("lock-reservation");
          return Promise.resolve(options.reservation ?? null);
        },
        insert: (record) => {
          options.events?.push("insert-lease");
          working.push(record);
          return Promise.resolve();
        },
        markConsumed: (requestIdHash, consumedAt) => {
          options.events?.push("consume-lease");
          const record = working.find(
            (row) =>
              row.requestIdHash === requestIdHash &&
              row.consumedAt === null &&
              row.expiresAt > consumedAt
          );
          if (!record) {
            return Promise.resolve(null);
          }
          record.consumedAt = consumedAt;
          return Promise.resolve(record);
        },
      };
      const result = await callback(tx);
      stored.splice(0, stored.length, ...working);
      return result;
    },
  };
  return database;
}

function input(
  overrides: Partial<Parameters<typeof consumeCredentialLease>[1]> = {}
) {
  return {
    harnessId: "copilot",
    keySecret: SECRET,
    now: NOW,
    operationId: "operation-1",
    requestId: "request-1",
    runId: "run-1",
    tenant: TENANT,
    ...overrides,
  };
}

async function denied(
  database: CredentialLeaseDatabase,
  overrides: Partial<Parameters<typeof consumeCredentialLease>[1]>,
  reason: CredentialLeaseDeniedError["reason"]
) {
  await assert.rejects(
    () =>
      consumeCredentialLease(
        database,
        input(overrides),
        NO_PREPARE,
        () => Promise.resolve("credential"),
        NO_AUDIT
      ),
    (error: unknown) =>
      error instanceof CredentialLeaseDeniedError && error.reason === reason
  );
}

async function deniedIssue(
  database: CredentialLeaseDatabase,
  overrides: Partial<Parameters<typeof issueCredentialLease>[1]>,
  reason: CredentialLeaseDeniedError["reason"]
) {
  await assert.rejects(
    () => issueCredentialLease(database, input(overrides), NO_AUDIT),
    (error: unknown) =>
      error instanceof CredentialLeaseDeniedError && error.reason === reason
  );
}

test("a lease is consumed before credential decryption and stores no raw identity", async () => {
  const events: string[] = [];
  const database = memoryDatabase({ events, reservation: reservation() });
  await issueCredentialLease(database, input(), NO_AUDIT);
  events.length = 0;

  const credential = await consumeCredentialLease(
    database,
    input(),
    NO_PREPARE,
    () => {
      events.push("decrypt");
      return Promise.resolve("credential-secret");
    },
    NO_AUDIT
  );

  assert.equal(credential, "credential-secret");
  assert.deepEqual(events, [
    "lock-reservation",
    "consume-lease",
    "lock-reservation",
    "consume-reservation",
    "decrypt",
  ]);
  assert.equal(database.leases.length, 1);
  const [stored] = database.leases;
  assert.equal(stored?.consumedAt?.toISOString(), NOW.toISOString());
  assert.equal(
    stored?.expiresAt.toISOString(),
    new Date(NOW.getTime() + 120_000).toISOString()
  );
  assert.equal(stored?.runId, "run-1");
  assert.equal(stored?.harnessId, "copilot");
  assert.notEqual(stored?.tenantHash, TENANT);
  assert.notEqual(stored?.requestIdHash, "request-1");
});

test("a reservation expiring during preparation is refused before decryption", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  let currentTime = NOW;
  let decryptions = 0;
  await issueCredentialLease(database, input(), NO_AUDIT);

  await assert.rejects(
    () =>
      consumeCredentialLease(
        database,
        input({ clock: () => currentTime }),
        () => {
          currentTime = new Date(NOW.getTime() + 300_001);
          return Promise.resolve();
        },
        () => {
          decryptions += 1;
          return Promise.resolve("credential");
        },
        NO_AUDIT
      ),
    (error: unknown) =>
      error instanceof CredentialLeaseDeniedError &&
      error.reason === "reservation_unavailable"
  );

  assert.equal(decryptions, 0);
  assert.equal(
    database.leases[0]?.consumedAt?.toISOString(),
    NOW.toISOString()
  );
});

test("a lease must be issued before it can be consumed", async () => {
  await denied(
    memoryDatabase({ reservation: reservation() }),
    {},
    "missing_lease"
  );
});

test("issuing a lease creates an unconsumed two-minute binding", async () => {
  const database = memoryDatabase({ reservation: reservation() });

  await issueCredentialLease(database, input(), NO_AUDIT);

  assert.equal(database.leases.length, 1);
  assert.equal(database.leases[0]?.consumedAt, null);
  assert.equal(
    database.leases[0]?.expiresAt.toISOString(),
    new Date(NOW.getTime() + 120_000).toISOString()
  );
});

test("repeating the same issuance is idempotent", async () => {
  const database = memoryDatabase({ reservation: reservation() });

  const first = await issueCredentialLease(database, input(), NO_AUDIT);
  const second = await issueCredentialLease(database, input(), NO_AUDIT);

  assert.equal(database.leases.length, 1);
  assert.equal(database.leases[0]?.consumedAt, null);
  assert.deepEqual(first, { kind: "issued" });
  assert.deepEqual(second, { kind: "existing" });
});

test("issuance removes lease rows older than the retention window", async () => {
  const database = memoryDatabase({
    leases: [
      lease({
        expiresAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1),
        requestIdHash: requestHash("old-request"),
        runId: "old-run",
      }),
    ],
    reservation: reservation(),
  });

  await issueCredentialLease(database, input(), NO_AUDIT);

  assert.deepEqual(
    database.leases.map(({ runId }) => runId),
    ["run-1"]
  );
});

test("lease cleanup commits even when issuance is denied", async () => {
  const database = memoryDatabase({
    leases: [
      lease({
        expiresAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1),
        requestIdHash: requestHash("old-request"),
        runId: "old-run",
      }),
    ],
    reservation: reservation({ releasedAt: NOW, state: "released" }),
  });

  await deniedIssue(database, {}, "reservation_unavailable");

  assert.equal(database.leases.length, 0);
});

test("a consumed request cannot be replayed", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  let decryptions = 0;
  await issueCredentialLease(database, input(), NO_AUDIT);
  await consumeCredentialLease(
    database,
    input(),
    NO_PREPARE,
    () => {
      decryptions += 1;
      return Promise.resolve("credential");
    },
    NO_AUDIT
  );

  await denied(database, {}, "replayed");
  assert.equal(decryptions, 1);
});

test("a consumed lease can be released after a pre-launch failure", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  await issueCredentialLease(database, input(), NO_AUDIT);
  await consumeCredentialLease(
    database,
    input(),
    NO_PREPARE,
    () => Promise.resolve("credential"),
    NO_AUDIT,
    { consumeReservation: false }
  );

  await releaseCredentialLease(database, input(), NO_AUDIT);

  assert.equal(database.leases.length, 0);
});

test("operator cleanup releases only the exact run lease", async () => {
  const database = memoryDatabase({
    leases: [
      lease(),
      lease({
        operationIdHash: operationHash("operation-2"),
        requestIdHash: requestHash("request-2"),
        runId: "run-2",
      }),
    ],
    reservation: reservation(),
  });

  await releaseCredentialLeaseForRun(database, "run-1", NO_AUDIT);

  assert.deepEqual(
    database.leases.map((record) => record.runId),
    ["run-2"]
  );
});

test("an existing request cannot change tenant, harness, operation, or run", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  await issueCredentialLease(database, input(), NO_AUDIT);
  await consumeCredentialLease(
    database,
    input(),
    NO_PREPARE,
    () => Promise.resolve("credential"),
    NO_AUDIT
  );

  await denied(database, { tenant: "tenant_other" }, "tenant_mismatch");
  await denied(database, { harnessId: "claude" }, "harness_mismatch");
  await denied(database, { operationId: "operation-2" }, "operation_mismatch");
  await denied(database, { runId: "run-2" }, "run_mismatch");
});

test("an expired lease cannot be consumed", async () => {
  const database = memoryDatabase({
    leases: [lease({ expiresAt: NOW })],
    reservation: reservation(),
  });

  await denied(database, {}, "expired");
});

test("a released or expired reservation cannot authorize a lease", async () => {
  await deniedIssue(
    memoryDatabase({
      reservation: reservation({
        releasedAt: NOW,
        state: "released",
      }),
    }),
    {},
    "reservation_unavailable"
  );
  await deniedIssue(
    memoryDatabase({
      reservation: reservation({ expiresAt: NOW }),
    }),
    {},
    "reservation_unavailable"
  );
  await deniedIssue(
    memoryDatabase({
      reservation: reservation({
        consumedAt: NOW,
        state: "consumed",
      }),
    }),
    {},
    "reservation_unavailable"
  );
});

test("a reservation for another tenant cannot authorize a lease", async () => {
  await deniedIssue(
    memoryDatabase({
      reservation: reservation({
        tenantHash: tenantHashForReservation("tenant_other", SECRET),
      }),
    }),
    {},
    "tenant_mismatch"
  );
});

test("one run cannot mint a second lease under a fresh request id", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  await issueCredentialLease(database, input(), NO_AUDIT);

  await deniedIssue(database, { requestId: "request-2" }, "run_already_leased");
});

test("one signed operation cannot mint a lease for a second run", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  await issueCredentialLease(database, input(), NO_AUDIT);

  await deniedIssue(
    database,
    { requestId: "request-2", runId: "run-2" },
    "operation_already_leased"
  );
});

test("a failed decrypt leaves the lease consumed and cannot be retried", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  await issueCredentialLease(database, input(), NO_AUDIT);

  await assert.rejects(
    () =>
      consumeCredentialLease(
        database,
        input(),
        NO_PREPARE,
        () => Promise.reject(new Error("decrypt failed")),
        NO_AUDIT
      ),
    /decrypt failed/
  );
  assert.equal(database.leases.length, 1);
  assert.equal(
    database.leases[0]?.consumedAt?.toISOString(),
    NOW.toISOString()
  );
  await denied(database, {}, "replayed");
});

test("a failed credential refresh commits lease consumption before plaintext read", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  let decryptions = 0;
  await issueCredentialLease(database, input(), NO_AUDIT);

  await assert.rejects(
    () =>
      consumeCredentialLease(
        database,
        input(),
        () => Promise.reject(new Error("refresh failed")),
        () => {
          decryptions += 1;
          return Promise.resolve("credential");
        },
        NO_AUDIT
      ),
    /refresh failed/
  );

  assert.equal(decryptions, 0);
  assert.equal(
    database.leases[0]?.consumedAt?.toISOString(),
    NOW.toISOString()
  );
});

test("a failed transaction commit never repeats credential decryption", async () => {
  let decryptions = 0;
  let transactions = 0;
  const database: CredentialLeaseDatabase = {
    cleanupExpiredBefore: () => Promise.resolve(),
    transaction: async (callback) => {
      transactions += 1;
      const result = await callback({
        consumeReservation: () =>
          Promise.resolve({
            ...reservation(),
            consumedAt: NOW,
            state: "consumed",
          }),
        credentialStore: {} as CredentialLeaseTransaction["credentialStore"],
        deleteByRequestIdHash: () => Promise.resolve(null),
        findByOperationIdHash: () => Promise.resolve(lease()),
        findByRequestIdHash: () =>
          Promise.resolve(
            lease({ consumedAt: transactions === 1 ? null : NOW })
          ),
        findByRunId: () => Promise.resolve(lease()),
        findReservationForUpdate: () => Promise.resolve(reservation()),
        insert: () => Promise.resolve(),
        markConsumed: () => Promise.resolve(lease({ consumedAt: NOW })),
      });
      if (transactions === 2) {
        throw Object.assign(new Error("serialization failed at commit"), {
          code: "40001",
        });
      }
      return result;
    },
  };

  await assert.rejects(
    () =>
      consumeCredentialLease(
        database,
        input(),
        NO_PREPARE,
        () => {
          decryptions += 1;
          return Promise.resolve("credential");
        },
        NO_AUDIT
      ),
    /serialization failed/
  );
  assert.equal(decryptions, 1);
});

test("the server-owned HMAC secret is not constrained like request identifiers", async () => {
  const longSecret = "s".repeat(256);
  const database = memoryDatabase({
    reservation: reservation({
      tenantHash: tenantHashForReservation(TENANT, longSecret),
    }),
  });
  await issueCredentialLease(
    database,
    input({ keySecret: longSecret }),
    NO_AUDIT
  );

  assert.equal(
    await consumeCredentialLease(
      database,
      input({ keySecret: longSecret }),
      NO_PREPARE,
      () => Promise.resolve("credential"),
      NO_AUDIT
    ),
    "credential"
  );
});

test("audit events contain only the allowed pseudonymous fields", async () => {
  const database = memoryDatabase({ reservation: reservation() });
  const events: unknown[] = [];
  await issueCredentialLease(database, input(), NO_AUDIT);

  await consumeCredentialLease(
    database,
    input(),
    NO_PREPARE,
    () => Promise.resolve("credential-secret"),
    (event) => {
      events.push(event);
    }
  );

  assert.equal(events.length, 1);
  const serialized = JSON.stringify(events[0]);
  assert.match(serialized, /credential_lease/);
  assert.match(serialized, /copilot/);
  assert.match(serialized, /run-1/);
  assert.match(serialized, /consumed/);
  assert.doesNotMatch(serialized, /tenant_acme|request-1|credential-secret/);
});

test("the lease schema enforces one request and one lease per run", () => {
  const schema = readFileSync(
    new URL("../db/schema.ts", import.meta.url),
    "utf8"
  );
  const migration = readFileSync(
    new URL("../db/migrations/0012_credential_leases.sql", import.meta.url),
    "utf8"
  );

  assert.match(schema, /credentialLease = pgTable\(\s*"CredentialLease"/);
  assert.match(schema, /requestIdHash[\s\S]*primaryKey\(\)/);
  assert.match(schema, /operationIdHash[\s\S]*unique\(\)/);
  assert.match(schema, /uniqueIndex\("CredentialLease_run_idx"\)/);
  assert.match(schema, /CredentialLease_expiry_valid/);
  assert.match(schema, /CredentialLease_consumption_valid/);
  assert.doesNotMatch(schema, /CredentialLease[\s\S]{0,700}requestId:/);
  assert.doesNotMatch(schema, /CredentialLease[\s\S]{0,700}operationId:/);
  assert.doesNotMatch(schema, /CredentialLease[\s\S]{0,700}tenant:/);
  assert.match(migration, /CREATE TABLE "CredentialLease"/);
  assert.match(migration, /"requestIdHash" varchar\(64\) PRIMARY KEY NOT NULL/);
  assert.match(migration, /"operationIdHash" varchar\(64\) NOT NULL/);
  assert.match(
    migration,
    /"CredentialLease_operationIdHash_unique" UNIQUE\("operationIdHash"\)/
  );
  assert.match(migration, /CREATE UNIQUE INDEX "CredentialLease_run_idx"/);
});
