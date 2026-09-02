// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import { tenantForUser } from "@/lib/session";
import {
  meterEventTimestamp,
  meterSettledUsage,
  type UnmeteredRun,
  USAGE_METERING_TIMESTAMP_WINDOW_MS,
  type UsageMeteringOutcome,
  type UsageMeteringProvider,
  UsageMeteringProviderUnauthorizedError,
  type UsageMeteringStore,
  userIdForTenant,
} from "./usage-metering";

const NOW = new Date("2026-09-02T18:00:00.000Z");
const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const OTHER_USER_ID = "7ba7b810-9dad-11d1-80b4-00c04fd430c8";

type Row = UnmeteredRun & {
  meteredAt: Date | null;
  outcome: UsageMeteringOutcome | null;
};

function row(runId: string, overrides: Partial<Row> = {}): Row {
  return {
    costUnits: 5,
    meteredAt: null,
    outcome: null,
    runId,
    settledAt: new Date("2026-09-02T17:30:00.000Z"),
    tenant: tenantForUser(USER_ID),
    ...overrides,
  };
}

function memoryStore(
  rows: Row[],
  customers: Record<string, string | null> = { [USER_ID]: "cus_acme" }
) {
  const calls: string[] = [];
  const store: UsageMeteringStore = {
    transaction: async (callback) => {
      calls.push("begin");
      const result = await callback({
        lockUnmetered: async (limit) => {
          calls.push(`lock:${limit}`);
          return rows
            .filter((entry) => entry.meteredAt === null)
            .sort((a, b) => a.settledAt.getTime() - b.settledAt.getTime())
            .slice(0, limit)
            .map(({ costUnits, runId, settledAt, tenant }) => ({
              costUnits,
              runId,
              settledAt,
              tenant,
            }));
        },
        markMetered: async (runId, outcome, meteredAt) => {
          const entry = rows.find((candidate) => candidate.runId === runId);
          if (!entry || entry.meteredAt !== null) {
            return false;
          }
          entry.meteredAt = meteredAt;
          entry.outcome = outcome;
          calls.push(`mark:${runId}:${outcome}`);
          return true;
        },
        stripeCustomerIdForUser: async (userId) => customers[userId] ?? null,
      });
      calls.push("commit");
      return result;
    },
  };
  return { calls, store };
}

function recordingProvider(
  fail: (identifier: string) => Error | null = () => null
) {
  const events: Parameters<UsageMeteringProvider["createMeterEvent"]>[0][] = [];
  const provider: UsageMeteringProvider = {
    createMeterEvent: async (input) => {
      const failure = fail(input.identifier);
      if (failure) {
        throw failure;
      }
      events.push(input);
    },
  };
  return { events, provider };
}

test("a subscriber tenant maps back to its account id and nothing else does", () => {
  assert.equal(userIdForTenant(tenantForUser(USER_ID)), USER_ID);
  assert.equal(userIdForTenant("d_6ba7b8109dad11d180b400c04fd430c8"), null);
  assert.equal(userIdForTenant("u_not-hex"), null);
  assert.equal(userIdForTenant("u_6ba7b8109dad11d180b400c04fd430c"), null);
  assert.equal(userIdForTenant(null), null);
});

test("settled runs are reported once, with the run id as the event identifier", async () => {
  const rows = [row("run-a"), row("run-b", { costUnits: 1 })];
  const { calls, store } = memoryStore(rows);
  const { events, provider } = recordingProvider();

  const result = await meterSettledUsage({
    eventName: "run_minutes",
    now: NOW,
    provider,
    store,
  });

  assert.deepEqual(result, {
    batches: 1,
    noCustomer: 0,
    notBillable: 0,
    reported: 2,
    scanned: 2,
    stopped: "drained",
  });
  assert.deepEqual(events, [
    {
      customerId: "cus_acme",
      eventName: "run_minutes",
      identifier: "run:run-a",
      timestamp: new Date("2026-09-02T17:30:00.000Z"),
      value: 5,
    },
    {
      customerId: "cus_acme",
      eventName: "run_minutes",
      identifier: "run:run-b",
      timestamp: new Date("2026-09-02T17:30:00.000Z"),
      value: 1,
    },
  ]);
  assert.deepEqual(calls, [
    "begin",
    "lock:50",
    "mark:run-a:reported",
    "mark:run-b:reported",
    "commit",
  ]);
  assert.ok(
    rows.every((entry) => entry.meteredAt?.getTime() === NOW.getTime())
  );

  const replay = await meterSettledUsage({
    eventName: "run_minutes",
    now: NOW,
    provider,
    store,
  });
  assert.equal(replay.scanned, 0);
  assert.equal(events.length, 2);
});

test("demo tenants and accounts without a Stripe Customer are marked, not reported", async () => {
  const rows = [
    row("demo-run", { tenant: "d_6ba7b8109dad11d180b400c04fd430c8" }),
    row("orphan-run", { tenant: null }),
    row("granted-run", { tenant: tenantForUser(OTHER_USER_ID) }),
  ];
  const { store } = memoryStore(rows, {
    [OTHER_USER_ID]: null,
    [USER_ID]: "cus_acme",
  });
  const { events, provider } = recordingProvider();

  const result = await meterSettledUsage({
    eventName: "run_minutes",
    now: NOW,
    provider,
    store,
  });

  assert.deepEqual(result, {
    batches: 1,
    noCustomer: 1,
    notBillable: 2,
    reported: 0,
    scanned: 3,
    stopped: "drained",
  });
  assert.deepEqual(events, []);
  assert.deepEqual(
    rows.map((entry) => entry.outcome),
    ["not_billable", "not_billable", "no_customer"]
  );
});

test("a provider failure keeps the unreported rows pending and stops the run", async () => {
  const rows = [row("run-a"), row("run-b"), row("run-c")];
  const { store } = memoryStore(rows);
  const { events, provider } = recordingProvider((identifier) =>
    identifier === "run:run-b" ? new Error("stripe down") : null
  );

  const result = await meterSettledUsage({
    eventName: "run_minutes",
    now: NOW,
    provider,
    store,
  });

  assert.deepEqual(result, {
    batches: 1,
    noCustomer: 0,
    notBillable: 0,
    reported: 1,
    scanned: 2,
    stopped: "provider_failure",
  });
  assert.equal(events.length, 1);
  assert.deepEqual(
    rows.map((entry) => entry.outcome),
    ["reported", null, null]
  );
});

test("a credential rejection propagates instead of being retried quietly", async () => {
  const { store } = memoryStore([row("run-a")]);
  const { provider } = recordingProvider(
    () => new UsageMeteringProviderUnauthorizedError()
  );

  await assert.rejects(
    meterSettledUsage({
      eventName: "run_minutes",
      now: NOW,
      provider,
      store,
    }),
    UsageMeteringProviderUnauthorizedError
  );
});

test("batches are bounded per invocation and drain across runs", async () => {
  const rows = Array.from({ length: 5 }, (_, index) =>
    row(`run-${index}`, {
      settledAt: new Date(NOW.getTime() - (5 - index) * 60_000),
    })
  );
  const { store } = memoryStore(rows);
  const { events, provider } = recordingProvider();

  const first = await meterSettledUsage({
    batchSize: 2,
    eventName: "run_minutes",
    maxBatches: 2,
    now: NOW,
    provider,
    store,
  });
  assert.deepEqual(first, {
    batches: 2,
    noCustomer: 0,
    notBillable: 0,
    reported: 4,
    scanned: 4,
    stopped: "batch_limit",
  });
  // Oldest settlements are reported first, so a backlog never starves them.
  assert.deepEqual(
    events.map((event) => event.identifier),
    ["run:run-0", "run:run-1", "run:run-2", "run:run-3"]
  );

  const second = await meterSettledUsage({
    batchSize: 2,
    eventName: "run_minutes",
    maxBatches: 2,
    now: NOW,
    provider,
    store,
  });
  assert.equal(second.reported, 1);
  assert.equal(second.stopped, "drained");
});

test("settlements older than Stripe's window are reported at the current time", () => {
  const recent = new Date(NOW.getTime() - 3 * 86_400_000);
  const stale = new Date(
    NOW.getTime() - USAGE_METERING_TIMESTAMP_WINDOW_MS - 1
  );

  assert.deepEqual(meterEventTimestamp(recent, NOW), recent);
  assert.deepEqual(meterEventTimestamp(stale, NOW), NOW);
});

test("metering refuses an unusable meter name or batch shape", async () => {
  const { store } = memoryStore([]);
  const { provider } = recordingProvider();

  await Promise.all(
    [
      { eventName: " " },
      { eventName: "x".repeat(101) },
      { batchSize: 0, eventName: "run_minutes" },
      { eventName: "run_minutes", maxBatches: -1 },
    ].map((input) =>
      assert.rejects(
        meterSettledUsage({ ...input, now: NOW, provider, store }),
        /Usage metering configuration is invalid/
      )
    )
  );
});
