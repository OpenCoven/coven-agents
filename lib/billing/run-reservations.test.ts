import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { runReservation } from "@/lib/db/schema";
import {
  consumeRunReservation,
  globalDailyRunCapFromEnv,
  type RunReservationDatabase,
  type RunReservationRecord,
  type RunReservationTransaction,
  releaseRunReservation,
  reservationUsage,
  reserveRun,
  TENANT_DAILY_RUN_CAP,
  tenantHashForReservation,
} from "./run-reservations";

const NOW = new Date("2026-08-25T18:00:00.000Z");
const PERIOD_START = new Date("2026-08-20T12:00:00.000Z");
const SECRET = "fixed-test-abuse-key-secret";
const TENANT = "tenant_acme";

class MemoryReservationDatabase
  implements RunReservationDatabase, RunReservationTransaction
{
  readonly legacyUsage: Array<{
    countedAt: Date;
    runId: string;
    tenant: string;
  }> = [];
  readonly reservations = new Map<string, RunReservationRecord>();
  readonly usage = new Set<string>();
  readonly transactionIsolationLevels: string[] = [];

  private mutex = Promise.resolve();

  async transaction<T>(
    callback: (tx: RunReservationTransaction) => Promise<T>,
    config: { isolationLevel: "serializable" }
  ): Promise<T> {
    this.transactionIsolationLevels.push(config.isolationLevel);

    const previous = this.mutex;
    let unlock: () => void = () => {
      // Replaced before the mutex is awaited.
    };
    this.mutex = new Promise<void>((resolve) => {
      unlock = resolve;
    });

    await previous;
    try {
      return await callback(this);
    } finally {
      unlock();
    }
  }

  findByRunId(runId: string): Promise<RunReservationRecord | null> {
    return Promise.resolve(this.reservations.get(runId) ?? null);
  }

  releaseExpired(now: Date): Promise<void> {
    for (const [runId, reservation] of this.reservations) {
      if (reservation.state === "reserved" && reservation.expiresAt <= now) {
        this.reservations.set(runId, {
          ...reservation,
          releasedAt: now,
          state: "released",
        });
      }
    }
    return Promise.resolve();
  }

  activeUnits(input: {
    now: Date;
    periodDay?: string;
    periodMonth?: Date;
    tenant?: string;
    tenantHash?: string;
  }): Promise<number> {
    let units = 0;
    for (const reservation of this.reservations.values()) {
      const active =
        reservation.state === "consumed" ||
        (reservation.state === "reserved" && reservation.expiresAt > input.now);
      if (
        active &&
        (input.tenantHash === undefined ||
          reservation.tenantHash === input.tenantHash) &&
        (input.periodDay === undefined ||
          reservation.periodDay === input.periodDay) &&
        (input.periodMonth === undefined ||
          reservation.periodMonth.getTime() === input.periodMonth.getTime())
      ) {
        units += reservation.costUnits;
      }
    }

    for (const legacy of this.legacyUsage) {
      if (
        !this.reservations.has(legacy.runId) &&
        (input.tenant === undefined || legacy.tenant === input.tenant) &&
        (input.periodDay === undefined ||
          legacy.countedAt.toISOString().slice(0, 10) === input.periodDay) &&
        (input.periodMonth === undefined ||
          legacy.countedAt >= input.periodMonth)
      ) {
        units += 1;
      }
    }
    return Promise.resolve(units);
  }

  insert(reservation: RunReservationRecord): Promise<void> {
    if (this.reservations.has(reservation.runId)) {
      throw new Error("duplicate run id");
    }
    this.reservations.set(reservation.runId, reservation);
    return Promise.resolve();
  }

  markConsumed(
    runId: string,
    tenant: string,
    consumedAt: Date
  ): Promise<RunReservationRecord | null> {
    const reservation = this.reservations.get(runId);
    if (!reservation) {
      return Promise.resolve(null);
    }
    if (reservation.state === "released") {
      return Promise.resolve(reservation);
    }

    const consumed: RunReservationRecord =
      reservation.state === "consumed"
        ? reservation
        : { ...reservation, consumedAt, state: "consumed" };
    this.reservations.set(runId, consumed);
    this.usage.add(`${tenant}:${runId}`);
    return Promise.resolve(consumed);
  }

  markReleased(
    runId: string,
    releasedAt: Date
  ): Promise<RunReservationRecord | null> {
    const reservation = this.reservations.get(runId);
    if (!reservation) {
      return Promise.resolve(null);
    }
    if (reservation.state !== "reserved") {
      return Promise.resolve(reservation);
    }

    const released: RunReservationRecord = {
      ...reservation,
      releasedAt,
      state: "released",
    };
    this.reservations.set(runId, released);
    return Promise.resolve(released);
  }
}

function reservationInput(
  runId: string,
  overrides: Partial<Parameters<typeof reserveRun>[1]> = {}
) {
  return {
    globalDailyCap: 500,
    keySecret: SECRET,
    now: NOW,
    periodStart: PERIOD_START,
    runId,
    tenant: TENANT,
    tenantDailyCap: 5,
    tenantMonthlyCap: 750,
    ...overrides,
  };
}

test("parallel reservations cannot exceed the tenant daily cap", async () => {
  const db = new MemoryReservationDatabase();
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      reserveRun(db, reservationInput(`run-${index}`))
    )
  );

  assert.equal(
    results.filter((result) => result.kind === "reserved").length,
    5
  );
  assert.equal(
    results.filter(
      (result) =>
        result.kind === "refused" && result.reason === "tenant_daily_cap"
    ).length,
    15
  );
  assert.equal(db.reservations.size, 5);
  assert.ok(
    db.transactionIsolationLevels.every((level) => level === "serializable")
  );
});

test("parallel reservations cannot exceed the global daily cap", async () => {
  const db = new MemoryReservationDatabase();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      reserveRun(
        db,
        reservationInput(`global-${index}`, {
          globalDailyCap: 3,
          tenant: `tenant_${index}`,
          tenantDailyCap: 20,
        })
      )
    )
  );

  assert.equal(
    results.filter((result) => result.kind === "reserved").length,
    3
  );
  assert.equal(
    results.filter(
      (result) =>
        result.kind === "refused" && result.reason === "global_daily_cap"
    ).length,
    9
  );
});

test("a duplicate run id returns the existing reservation and charges once", async () => {
  const db = new MemoryReservationDatabase();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      reserveRun(db, reservationInput("same-run"))
    )
  );

  assert.equal(
    results.filter((result) => result.kind === "reserved").length,
    1
  );
  assert.equal(
    results.filter((result) => result.kind === "existing").length,
    9
  );
  assert.equal(db.reservations.size, 1);
  assert.equal(
    await db.activeUnits({
      now: NOW,
      periodDay: "2026-08-25",
      tenantHash: tenantHashForReservation(TENANT, SECRET),
    }),
    1
  );
});

test("a concurrent duplicate insert retries and returns the winner", async () => {
  const winner = new MemoryReservationDatabase();
  await reserveRun(winner, reservationInput("raced-run"));
  let attempts = 0;
  const racingDatabase: RunReservationDatabase = {
    transaction: async (callback, config) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }
      return await winner.transaction(callback, config);
    },
  };

  const result = await reserveRun(
    racingDatabase,
    reservationInput("raced-run")
  );

  assert.equal(result.kind, "existing");
  assert.equal(attempts, 2);
  assert.equal(winner.reservations.size, 1);
});

test("the monthly cap follows the subscription billing period across calendar months", async () => {
  const db = new MemoryReservationDatabase();

  const first = await reserveRun(
    db,
    reservationInput("august-run", {
      now: new Date("2026-08-31T23:59:00.000Z"),
      periodStart: new Date("2026-08-20T12:00:00.000Z"),
      tenantDailyCap: 10,
      tenantMonthlyCap: 1,
    })
  );
  const sameBillingPeriod = await reserveRun(
    db,
    reservationInput("september-run", {
      now: new Date("2026-09-01T00:01:00.000Z"),
      periodStart: new Date("2026-08-20T12:00:00.000Z"),
      tenantDailyCap: 10,
      tenantMonthlyCap: 1,
    })
  );

  assert.equal(first.kind, "reserved");
  assert.deepEqual(sameBillingPeriod, {
    kind: "refused",
    reason: "tenant_monthly_cap",
  });
});

test("expired reservations are released before capacity is counted", async () => {
  const db = new MemoryReservationDatabase();
  await reserveRun(
    db,
    reservationInput("expired", {
      reservationTtlMs: 1000,
      tenantDailyCap: 1,
    })
  );

  const later = new Date(NOW.getTime() + 1001);
  const replacement = await reserveRun(
    db,
    reservationInput("replacement", {
      now: later,
      tenantDailyCap: 1,
    })
  );

  assert.equal(replacement.kind, "reserved");
  assert.equal(db.reservations.get("expired")?.state, "released");
  assert.equal(
    db.reservations.get("expired")?.releasedAt?.toISOString(),
    later.toISOString()
  );
});

test("pre-reservation usage still counts toward the active billing period", async () => {
  const db = new MemoryReservationDatabase();
  db.legacyUsage.push({
    countedAt: new Date("2026-08-21T12:00:00.000Z"),
    runId: "legacy-run",
    tenant: TENANT,
  });

  const result = await reserveRun(
    db,
    reservationInput("new-run", {
      tenantDailyCap: 10,
      tenantMonthlyCap: 1,
    })
  );
  const usage = await reservationUsage(db, {
    globalDailyCap: 500,
    keySecret: SECRET,
    now: NOW,
    periodStart: PERIOD_START,
    tenant: TENANT,
    tenantDailyCap: 10,
    tenantMonthlyCap: 1,
  });

  assert.deepEqual(result, {
    kind: "refused",
    reason: "tenant_monthly_cap",
  });
  assert.equal(usage.tenantMonthlyRemaining, 0);
});

test("pre-reservation usage remains isolated to its raw tenant", async () => {
  const db = new MemoryReservationDatabase();
  db.legacyUsage.push({
    countedAt: new Date("2026-08-21T12:00:00.000Z"),
    runId: "other-legacy-run",
    tenant: "tenant_other",
  });

  const result = await reserveRun(
    db,
    reservationInput("isolated-new-run", {
      tenantDailyCap: 10,
      tenantMonthlyCap: 1,
    })
  );

  assert.equal(result.kind, "reserved");
});

test("tenant identifiers are HMAC-pseudonymized before storage", async () => {
  const db = new MemoryReservationDatabase();

  await reserveRun(db, reservationInput("pseudonymous"));

  const stored = db.reservations.get("pseudonymous");
  assert.ok(stored);
  assert.notEqual(stored.tenantHash, TENANT);
  assert.equal(stored.tenantHash.length, 64);
  assert.equal(stored.tenantHash, tenantHashForReservation(TENANT, SECRET));
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(TENANT));
});

test("consuming is idempotent and preserves legacy per-run analytics", async () => {
  const db = new MemoryReservationDatabase();
  await reserveRun(db, reservationInput("consumed"));

  const first = await consumeRunReservation(db, {
    consumedAt: NOW,
    runId: "consumed",
    tenant: TENANT,
  });
  const duplicate = await consumeRunReservation(db, {
    consumedAt: new Date(NOW.getTime() + 1000),
    runId: "consumed",
    tenant: TENANT,
  });

  assert.equal(first.kind, "consumed");
  assert.equal(duplicate.kind, "consumed");
  assert.equal(db.usage.size, 1);
  assert.equal(
    db.reservations.get("consumed")?.consumedAt?.toISOString(),
    NOW.toISOString()
  );
});

test("released reservations do not consume tenant or global capacity", async () => {
  const db = new MemoryReservationDatabase();
  await reserveRun(db, reservationInput("released"));

  const released = await releaseRunReservation(db, {
    releasedAt: NOW,
    runId: "released",
  });
  const usage = await reservationUsage(db, {
    globalDailyCap: 1,
    keySecret: SECRET,
    now: NOW,
    periodStart: PERIOD_START,
    tenant: TENANT,
    tenantDailyCap: 1,
    tenantMonthlyCap: 1,
  });

  assert.equal(released?.state, "released");
  assert.deepEqual(usage, {
    globalAdmissionClosed: false,
    tenantDailyRemaining: 1,
    tenantMonthlyRemaining: 1,
  });
});

test("global capacity configuration accepts only positive integers", () => {
  assert.equal(globalDailyRunCapFromEnv("500"), 500);

  for (const value of [undefined, "", "0", "-1", "1.5", "many"]) {
    assert.throws(
      () => globalDailyRunCapFromEnv(value),
      /GLOBAL_DAILY_RUN_CAP/
    );
  }
});

test("the tenant daily cap is conservative, usable, and below the monthly cap", () => {
  assert.equal(TENANT_DAILY_RUN_CAP, 50);
  assert.ok(TENANT_DAILY_RUN_CAP > 0);
  assert.ok(TENANT_DAILY_RUN_CAP < 750);
});

test("RunReservation has the required key, indexes, and integrity checks", () => {
  const config = getTableConfig(runReservation);
  const primaryKeyColumns = config.columns
    .filter((column) => column.primary)
    .map((column) => column.name);
  const indexColumns = config.indexes.map((entry) =>
    entry.config.columns.map(
      (column) => (column as { name?: string }).name ?? null
    )
  );
  const checkNames = config.checks.map((entry) => entry.name);

  assert.deepEqual(primaryKeyColumns, ["runId"]);
  assert.ok(
    indexColumns.some(
      (columns) =>
        JSON.stringify(columns) ===
        JSON.stringify(["tenantHash", "periodDay", "state"])
    )
  );
  assert.ok(
    indexColumns.some(
      (columns) =>
        JSON.stringify(columns) === JSON.stringify(["periodDay", "state"])
    )
  );
  assert.ok(checkNames.includes("RunReservation_costUnits_positive"));
  assert.ok(checkNames.includes("RunReservation_state_valid"));
  assert.ok(checkNames.includes("RunReservation_state_timestamps_valid"));
  assert.ok(checkNames.includes("RunReservation_expiry_valid"));
});
