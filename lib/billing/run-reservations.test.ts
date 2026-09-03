import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { runReservation, runUsage } from "@/lib/db/schema";
import { tenantForUser } from "@/lib/session";
import { MONTHLY_MINUTE_CAP, RUN_MINUTE_RESERVATION } from "./limits";
import { periodStart } from "./period";
import {
  compensateRunReservation,
  consumeRunReservation,
  discardRunReservation,
  globalDailyRunCapFromEnv,
  type RunReservationDatabase,
  type RunReservationRecord,
  type RunReservationTransaction,
  releaseRunReservation,
  reservationUsage,
  reserveRun,
  settledRunMinutes,
  TENANT_DAILY_MINUTE_CAP,
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
  readonly packs = new Map<string, number>();
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

  purchasedPackMinutes(userId: string): Promise<number> {
    return Promise.resolve(this.packs.get(userId) ?? 0);
  }

  priorPeriodOverflow(input: {
    cap: number;
    periodMonth: Date;
    tenantHash: string;
  }): Promise<number> {
    const perPeriod = new Map<number, number>();
    for (const reservation of this.reservations.values()) {
      if (
        reservation.tenantHash === input.tenantHash &&
        reservation.state === "consumed" &&
        reservation.periodMonth.getTime() < input.periodMonth.getTime()
      ) {
        const key = reservation.periodMonth.getTime();
        perPeriod.set(key, (perPeriod.get(key) ?? 0) + reservation.costUnits);
      }
    }
    let overflow = 0;
    for (const units of perPeriod.values()) {
      overflow += Math.max(0, units - input.cap);
    }
    return Promise.resolve(overflow);
  }

  hasUsageRunId(runId: string): Promise<boolean> {
    return Promise.resolve(
      this.legacyUsage.some((usage) => usage.runId === runId) ||
        [...this.usage].some((usage) => usage.endsWith(`:${runId}`))
    );
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
      const matchingReservation = this.reservations.get(legacy.runId);
      if (
        (matchingReservation === undefined ||
          matchingReservation.state === "released") &&
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

  compensateConsumed(
    runId: string,
    tenant: string,
    compensatedAt: Date
  ): Promise<RunReservationRecord | null> {
    const reservation = this.reservations.get(runId);
    if (!reservation) {
      return Promise.resolve(null);
    }
    if (reservation.state !== "consumed") {
      return Promise.resolve(reservation);
    }
    const released: RunReservationRecord = {
      ...reservation,
      consumedAt: null,
      releasedAt: compensatedAt,
      state: "released",
    };
    this.reservations.set(runId, released);
    this.usage.delete(`${tenant}:${runId}`);
    return Promise.resolve(released);
  }

  discardReserved(runId: string): Promise<RunReservationRecord | null> {
    const reservation = this.reservations.get(runId);
    if (reservation?.state !== "reserved") {
      return Promise.resolve(null);
    }
    this.reservations.delete(runId);
    return Promise.resolve(reservation);
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
    if (
      reservation.state === "released" ||
      (reservation.state === "reserved" && reservation.expiresAt <= consumedAt)
    ) {
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
    // Cap mechanics are unit-agnostic; one unit per run keeps the small caps
    // in these tests readable. The production default is asserted separately.
    costUnits: 1,
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

test("a run reserves the runner's full time limit in minutes by default", async () => {
  const db = new MemoryReservationDatabase();
  const { costUnits: _omitted, ...withoutUnits } = reservationInput("default", {
    tenantDailyCap: 100,
  });

  const result = await reserveRun(db, withoutUnits);

  assert.equal(result.kind, "reserved");
  const reserved = db.reservations.get("default");
  assert.equal(reserved?.costUnits, RUN_MINUTE_RESERVATION);
  assert.equal(reserved?.reservedUnits, RUN_MINUTE_RESERVATION);
  assert.equal(reserved?.settledAt, null);
  assert.equal(reserved?.durationSeconds, null);
});

test("the default caps are the monthly minute cap and the tenant daily minute cap", async () => {
  const db = new MemoryReservationDatabase();
  const {
    tenantDailyCap: _d,
    tenantMonthlyCap: _m,
    ...withDefaults
  } = reservationInput("defaults", { costUnits: MONTHLY_MINUTE_CAP + 1 });

  const monthly = await reserveRun(db, {
    ...withDefaults,
    tenantDailyCap: MONTHLY_MINUTE_CAP + 1,
  });
  const daily = await reserveRun(db, {
    ...withDefaults,
    costUnits: TENANT_DAILY_MINUTE_CAP + 1,
    tenantMonthlyCap: MONTHLY_MINUTE_CAP * 2,
  });

  assert.deepEqual(monthly, {
    cap: MONTHLY_MINUTE_CAP,
    kind: "refused",
    reason: "tenant_monthly_cap",
    used: 0,
  });
  assert.deepEqual(daily, {
    cap: TENANT_DAILY_MINUTE_CAP,
    kind: "refused",
    reason: "tenant_daily_cap",
    used: 0,
  });
});

const PACK_USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const PACK_TENANT = tenantForUser(PACK_USER_ID);

async function consumedRun(
  db: MemoryReservationDatabase,
  runId: string,
  overrides: Partial<Parameters<typeof reserveRun>[1]>
) {
  const reserved = await reserveRun(
    db,
    reservationInput(runId, { tenant: PACK_TENANT, ...overrides })
  );
  assert.equal(reserved.kind, "reserved", runId);
  await consumeRunReservation(db, {
    consumedAt: overrides.now ?? NOW,
    runId,
    tenant: PACK_TENANT,
  });
}

test("purchased pack minutes extend the bucket and are reported in usage", async () => {
  const db = new MemoryReservationDatabase();
  await consumedRun(db, "bucket-run", {
    costUnits: 3,
    tenantDailyCap: 100,
    tenantMonthlyCap: 3,
  });

  const refused = await reserveRun(
    db,
    reservationInput("over-bucket", {
      costUnits: 2,
      tenant: PACK_TENANT,
      tenantDailyCap: 100,
      tenantMonthlyCap: 3,
    })
  );
  assert.deepEqual(refused, {
    cap: 3,
    kind: "refused",
    reason: "tenant_monthly_cap",
    used: 3,
  });

  db.packs.set(PACK_USER_ID, 5);
  const admitted = await reserveRun(
    db,
    reservationInput("pack-run", {
      costUnits: 2,
      tenant: PACK_TENANT,
      tenantDailyCap: 100,
      tenantMonthlyCap: 3,
    })
  );
  assert.equal(admitted.kind, "reserved");

  const usage = await reservationUsage(db, {
    globalDailyCap: 500,
    keySecret: SECRET,
    now: NOW,
    periodStart: PERIOD_START,
    tenant: PACK_TENANT,
    tenantDailyCap: 100,
    tenantMonthlyCap: 3,
  });
  assert.equal(usage.tenantPackMinutes, 5);
  assert.equal(usage.tenantMonthlyRemaining, 3);

  const beyond = await reserveRun(
    db,
    reservationInput("beyond-packs", {
      costUnits: 4,
      tenant: PACK_TENANT,
      tenantDailyCap: 100,
      tenantMonthlyCap: 3,
    })
  );
  assert.deepEqual(beyond, {
    cap: 8,
    kind: "refused",
    reason: "tenant_monthly_cap",
    used: 5,
  });
});

test("pack minutes carry over, less what earlier periods drew beyond their bucket", async () => {
  const db = new MemoryReservationDatabase();
  db.packs.set(PACK_USER_ID, 10);
  const earlier = new Date("2026-07-20T12:00:00.000Z");
  // Last period used 7 against a bucket of 3: four pack minutes are gone.
  await consumedRun(db, "july-a", {
    costUnits: 4,
    now: new Date("2026-07-25T12:00:00.000Z"),
    periodStart: earlier,
    tenantDailyCap: 100,
    tenantMonthlyCap: 3,
  });
  await consumedRun(db, "july-b", {
    costUnits: 3,
    now: new Date("2026-07-26T12:00:00.000Z"),
    periodStart: earlier,
    tenantDailyCap: 100,
    tenantMonthlyCap: 3,
  });

  const usage = await reservationUsage(db, {
    globalDailyCap: 500,
    keySecret: SECRET,
    now: NOW,
    periodStart: PERIOD_START,
    tenant: PACK_TENANT,
    tenantDailyCap: 100,
    tenantMonthlyCap: 3,
  });
  assert.equal(usage.tenantPackMinutes, 6);
  assert.equal(usage.tenantMonthlyRemaining, 9);
});

test("a demo tenant never draws on packs", async () => {
  const db = new MemoryReservationDatabase();
  db.packs.set(PACK_USER_ID, 100);
  const refused = await reserveRun(
    db,
    reservationInput("demo-run", {
      costUnits: 2,
      tenant: "d_6ba7b8109dad11d180b400c04fd430c8",
      tenantDailyCap: 100,
      tenantMonthlyCap: 1,
    })
  );
  assert.equal(refused.kind, "refused");
  assert.equal(
    refused.kind === "refused" && refused.reason === "tenant_monthly_cap"
      ? refused.cap
      : null,
    1
  );
});

test("settlement charges whole minutes, rounded up, within the reservation", () => {
  const startedAt = new Date("2026-08-25T18:00:00.000Z");
  const at = (seconds: number) =>
    new Date(startedAt.getTime() + seconds * 1000);

  // Any part of a minute is a minute, and a run that launched pays for one.
  assert.deepEqual(
    settledRunMinutes({ completedAt: at(0), reservedUnits: 15, startedAt }),
    { costUnits: 1, durationSeconds: 0 }
  );
  assert.deepEqual(
    settledRunMinutes({ completedAt: at(60), reservedUnits: 15, startedAt }),
    { costUnits: 1, durationSeconds: 60 }
  );
  assert.deepEqual(
    settledRunMinutes({ completedAt: at(61), reservedUnits: 15, startedAt }),
    { costUnits: 2, durationSeconds: 61 }
  );
  // Sub-second overrun still rounds up: the provider bills the second.
  assert.deepEqual(
    settledRunMinutes({
      completedAt: new Date(at(60).getTime() + 1),
      reservedUnits: 15,
      startedAt,
    }),
    { costUnits: 2, durationSeconds: 61 }
  );
  // A run that somehow outlived its limit is never charged above what
  // admission checked against the cap.
  assert.deepEqual(
    settledRunMinutes({ completedAt: at(3600), reservedUnits: 15, startedAt }),
    { costUnits: 15, durationSeconds: 3600 }
  );
});

test("settlement refuses to invent a duration", () => {
  const startedAt = new Date("2026-08-25T18:00:00.000Z");
  const later = new Date("2026-08-25T18:05:00.000Z");

  assert.equal(
    settledRunMinutes({
      completedAt: later,
      reservedUnits: 15,
      startedAt: null,
    }),
    null
  );
  assert.equal(
    settledRunMinutes({ completedAt: null, reservedUnits: 15, startedAt }),
    null
  );
  assert.equal(
    settledRunMinutes({
      completedAt: startedAt,
      reservedUnits: 15,
      startedAt: later,
    }),
    null
  );
  assert.equal(
    settledRunMinutes({
      completedAt: new Date("invalid"),
      reservedUnits: 15,
      startedAt,
    }),
    null
  );
  assert.equal(
    settledRunMinutes({ completedAt: later, reservedUnits: 0, startedAt }),
    null
  );
});

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

test("tenant refusals report the safe cap and current usage", async () => {
  const dailyDb = new MemoryReservationDatabase();
  await reserveRun(
    dailyDb,
    reservationInput("daily-cap-holder", { tenantDailyCap: 1 })
  );
  const daily = await reserveRun(
    dailyDb,
    reservationInput("daily-refused", { tenantDailyCap: 1 })
  );

  const monthlyDb = new MemoryReservationDatabase();
  await reserveRun(
    monthlyDb,
    reservationInput("monthly-cap-holder", {
      tenantDailyCap: 10,
      tenantMonthlyCap: 1,
    })
  );
  await consumeRunReservation(monthlyDb, {
    consumedAt: NOW,
    runId: "monthly-cap-holder",
    tenant: TENANT,
  });
  const monthly = await reserveRun(
    monthlyDb,
    reservationInput("monthly-refused", {
      now: new Date("2026-08-26T18:00:00.000Z"),
      tenantDailyCap: 10,
      tenantMonthlyCap: 1,
    })
  );

  assert.deepEqual(daily, {
    cap: 1,
    kind: "refused",
    reason: "tenant_daily_cap",
    used: 1,
  });
  assert.deepEqual(monthly, {
    cap: 1,
    kind: "refused",
    reason: "tenant_monthly_cap",
    used: 1,
  });
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

test("a run id already present in usage cannot receive a reservation", async () => {
  const db = new MemoryReservationDatabase();
  db.legacyUsage.push({
    countedAt: NOW,
    runId: "already-counted",
    tenant: TENANT,
  });

  const result = await reserveRun(db, reservationInput("already-counted"));

  assert.deepEqual(result, {
    kind: "conflict",
    reason: "run_already_counted",
  });
  assert.equal(db.reservations.size, 0);
  assert.equal(
    await db.activeUnits({
      now: NOW,
      periodDay: "2026-08-25",
      tenant: TENANT,
      tenantHash: tenantHashForReservation(TENANT, SECRET),
    }),
    1
  );
});

test("a released reservation cannot mask or reuse existing usage", async () => {
  const db = new MemoryReservationDatabase();
  await reserveRun(db, reservationInput("released-counted"));
  await releaseRunReservation(db, {
    releasedAt: NOW,
    runId: "released-counted",
  });
  db.legacyUsage.push({
    countedAt: NOW,
    runId: "released-counted",
    tenant: TENANT,
  });

  const result = await reserveRun(db, reservationInput("released-counted"));

  assert.equal(result.kind, "existing");
  assert.equal(
    result.kind === "existing" ? result.reservation.state : undefined,
    "released"
  );
  assert.equal(db.reservations.size, 1);
  assert.equal(
    await db.activeUnits({
      now: NOW,
      periodDay: "2026-08-25",
      tenant: TENANT,
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

test("wrapped retryable Postgres failures retry the transaction", async () => {
  await Promise.all(
    ["23505", "40001", "40P01"].map(async (code) => {
      const winner = new MemoryReservationDatabase();
      await reserveRun(winner, reservationInput(`wrapped-${code}`));
      let attempts = 0;
      const database: RunReservationDatabase = {
        transaction: async (callback, config) => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error("Failed query", {
              cause: Object.assign(new Error("postgres failure"), { code }),
            });
          }
          return await winner.transaction(callback, config);
        },
      };

      const result = await reserveRun(
        database,
        reservationInput(`wrapped-${code}`)
      );

      assert.equal(result.kind, "existing", code);
      assert.equal(attempts, 2, code);
    })
  );
});

test("a cyclic cause chain is bounded and not retried", async () => {
  let attempts = 0;
  const cyclic = new Error("cyclic failure");
  Object.assign(cyclic, { cause: cyclic });
  const database: RunReservationDatabase = {
    transaction: () => {
      attempts += 1;
      return Promise.reject(cyclic);
    },
  };

  await assert.rejects(() =>
    reserveRun(database, reservationInput("cyclic-cause"))
  );
  assert.equal(attempts, 1);
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
    cap: 1,
    kind: "refused",
    reason: "tenant_monthly_cap",
    used: 1,
  });
});

test("grace extension preserves the active billing period allowance", async () => {
  const db = new MemoryReservationDatabase();
  const paidPeriodStart = new Date("2026-08-20T12:00:00.000Z");
  const paidPeriodEnd = new Date("2026-09-20T12:00:00.000Z");
  const graceEnd = new Date("2026-09-23T12:00:00.000Z");
  const startFor = periodStart as (
    subscribedUntil: Date | null,
    authoritativeStart?: Date | null
  ) => Date | null;

  const first = await reserveRun(
    db,
    reservationInput("paid-period-run", {
      now: new Date("2026-08-25T12:00:00.000Z"),
      periodStart: startFor(paidPeriodEnd, paidPeriodStart) ?? paidPeriodStart,
      tenantDailyCap: 10,
      tenantMonthlyCap: 1,
    })
  );
  assert.equal(first.kind, "reserved");
  await consumeRunReservation(db, {
    consumedAt: new Date("2026-08-25T12:01:00.000Z"),
    runId: "paid-period-run",
    tenant: TENANT,
  });

  const replayedAllowance = await reserveRun(
    db,
    reservationInput("grace-period-run", {
      now: new Date("2026-09-21T12:00:00.000Z"),
      periodStart: startFor(graceEnd, paidPeriodStart) ?? paidPeriodStart,
      tenantDailyCap: 10,
      tenantMonthlyCap: 1,
    })
  );

  assert.deepEqual(replayedAllowance, {
    cap: 1,
    kind: "refused",
    reason: "tenant_monthly_cap",
    used: 1,
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

test("an expired run-id replay cannot bypass a refilled tenant cap", async () => {
  const db = new MemoryReservationDatabase();
  await reserveRun(
    db,
    reservationInput("expired-replay", {
      reservationTtlMs: 1000,
      tenantDailyCap: 2,
    })
  );
  await reserveRun(
    db,
    reservationInput("cap-holder", {
      tenantDailyCap: 2,
    })
  );
  await consumeRunReservation(db, {
    consumedAt: NOW,
    runId: "cap-holder",
    tenant: TENANT,
  });

  const later = new Date(NOW.getTime() + 1001);
  const replay = await reserveRun(
    db,
    reservationInput("expired-replay", {
      now: later,
      tenantDailyCap: 1,
    })
  );
  const consumed = await consumeRunReservation(db, {
    consumedAt: later,
    runId: "expired-replay",
    tenant: TENANT,
  });

  assert.equal(replay.kind, "existing");
  assert.equal(
    replay.kind === "existing" && replay.reservation.state,
    "released"
  );
  assert.equal(consumed.kind, "released");
  assert.equal(db.usage.has(`${TENANT}:expired-replay`), false);
});

test("consumption at the reservation expiry boundary is refused", async () => {
  const db = new MemoryReservationDatabase();
  await reserveRun(
    db,
    reservationInput("expires-before-consume", {
      reservationTtlMs: 1000,
    })
  );

  const consumed = await consumeRunReservation(db, {
    consumedAt: new Date(NOW.getTime() + 1000),
    runId: "expires-before-consume",
    tenant: TENANT,
  });

  assert.equal(consumed.kind, "released");
  assert.equal(db.usage.has(`${TENANT}:expires-before-consume`), false);
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
    cap: 1,
    kind: "refused",
    reason: "tenant_monthly_cap",
    used: 1,
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
    tenantPackMinutes: 0,
  });
});

test("discarding an unconsumed reservation lets a transient credential failure retry safely", async () => {
  const db = new MemoryReservationDatabase();
  await reserveRun(db, reservationInput("retryable-credential"));

  const discarded = await discardRunReservation(db, {
    runId: "retryable-credential",
  });
  const retried = await reserveRun(
    db,
    reservationInput("retryable-credential")
  );

  assert.equal(discarded?.runId, "retryable-credential");
  assert.equal(retried.kind, "reserved");
  assert.equal(db.usage.size, 0);
});

test("compensating a pre-launch consumed reservation removes its usage charge", async () => {
  const db = new MemoryReservationDatabase();
  await reserveRun(db, reservationInput("launch-compensation"));
  await consumeRunReservation(db, {
    consumedAt: NOW,
    runId: "launch-compensation",
    tenant: TENANT,
  });

  const compensated = await compensateRunReservation(db, {
    compensatedAt: new Date(NOW.getTime() + 1000),
    runId: "launch-compensation",
    tenant: TENANT,
  });

  assert.equal(compensated.kind, "compensated");
  assert.equal(db.usage.has(`${TENANT}:launch-compensation`), false);
  assert.equal(db.reservations.get("launch-compensation")?.state, "released");
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
  assert.equal(TENANT_DAILY_MINUTE_CAP, 100);
  assert.ok(TENANT_DAILY_MINUTE_CAP > 0);
  assert.ok(TENANT_DAILY_MINUTE_CAP < MONTHLY_MINUTE_CAP);
  // A day must admit more than one full-length run or the cap is a lockout.
  assert.ok(TENANT_DAILY_MINUTE_CAP >= RUN_MINUTE_RESERVATION * 4);
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
  const expiryIndex = config.indexes.find(
    (entry) => entry.config.name === "RunReservation_reserved_expiry_idx"
  );
  assert.deepEqual(
    expiryIndex?.config.columns.map(
      (column) => (column as { name?: string }).name ?? null
    ),
    ["expiresAt"]
  );
  assert.ok(expiryIndex?.config.where);
  assert.ok(checkNames.includes("RunReservation_costUnits_positive"));
  assert.ok(checkNames.includes("RunReservation_costUnits_within_reserved"));
  assert.ok(checkNames.includes("RunReservation_settlement_valid"));
  assert.ok(checkNames.includes("RunReservation_state_valid"));
  assert.ok(checkNames.includes("RunReservation_state_timestamps_valid"));
  assert.ok(checkNames.includes("RunReservation_expiry_valid"));
});

test("RunUsage indexes support global and tenant time-window scans", () => {
  const indexColumns = getTableConfig(runUsage).indexes.map((entry) =>
    entry.config.columns.map(
      (column) => (column as { name?: string }).name ?? null
    )
  );

  assert.ok(
    indexColumns.some(
      (columns) => JSON.stringify(columns) === JSON.stringify(["countedAt"])
    )
  );
  assert.ok(
    indexColumns.some(
      (columns) =>
        JSON.stringify(columns) === JSON.stringify(["tenant", "countedAt"])
    )
  );
});
