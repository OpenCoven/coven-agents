import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { withDisposableDatabase } from "../../scripts/disposable-postgres";

// Synthetic accounting fixtures only. No verified identity, login, live Stripe,
// provider call, or direct entitlement write is used by this test.
const databaseUrl = process.env.RUN_RESERVATION_POSTGRES_TEST_URL;
const USER_ID = "30000000-0000-4000-8000-0000000000a1";
const JULY = new Date("2026-07-01T00:00:00.000Z");
const AUGUST = new Date("2026-08-01T00:00:00.000Z");
const SECRET = "synthetic-ledger-abuse-key";

test("pack ledger preserves paid minutes through cap edits, rotation and reservation lifecycle", {
  skip: !databaseUrl,
}, async (t) => {
  assert.ok(databaseUrl);
  process.env.POSTGRES_URL = databaseUrl;
  const [queries, reservations, cleanup, session] = await Promise.all([
    import("./queries"),
    import("@/lib/billing/run-reservations"),
    import("@/lib/credentials/runner-credential"),
    import("@/lib/session"),
  ]);
  const tenant = session.tenantForUser(USER_ID);
  const database = reservations.drizzleRunReservationDatabase(queries.db);
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const runIds = [
    "rr-ledger-july-a",
    "rr-ledger-july-b",
    "rr-ledger-raised",
    "rr-ledger-legacy",
    "rr-ledger-expired",
    "rr-ledger-hold-a",
    "rr-ledger-hold-b",
    "rr-ledger-rotated",
  ];
  const usage = (cap: number, keySecret = SECRET) =>
    reservations.reservationUsage(database, {
      globalDailyCap: 500,
      keySecret,
      now: new Date("2026-08-15T12:00:00.000Z"),
      periodStart: AUGUST,
      tenant,
      tenantDailyCap: 100,
      tenantMonthlyCap: cap,
    });
  const reserve = (
    runId: string,
    costUnits: number,
    now: Date,
    periodStart: Date,
    cap: number,
    keySecret = SECRET
  ) =>
    reservations.reserveRun(database, {
      costUnits,
      globalDailyCap: 500,
      keySecret,
      now,
      periodStart,
      runId,
      tenant,
      tenantDailyCap: 100,
      tenantMonthlyCap: cap,
    });
  try {
    await sql`INSERT INTO "User" (id, email, "stripeCustomerId") VALUES (${USER_ID}, 'ledger-fixture@example.invalid', 'cus_ledger_fixture')`;
    // Exercise the canonical idempotent pack-credit operation, never insert an entitlement.
    assert.equal(
      await queries.creditMinutePack({
        customerId: "cus_ledger_fixture",
        eventId: "evt_ledger_fixture",
        minutes: 10,
        paymentIntentId: null,
        priceId: "price_ledger_fixture",
        sessionId: "cs_ledger_fixture",
        userId: USER_ID,
      }),
      "applied"
    );

    await t.test(
      "migration refuses paid legacy history instead of guessing its balance",
      async () => {
        const migration = await readFile(
          new URL("./migrations/0049_explicit_pack_draws.sql", import.meta.url),
          "utf8"
        );
        const [guard] = migration.split("--> statement-breakpoint");
        assert.ok(guard);
        await sql.unsafe(guard);
        await sql`INSERT INTO "RunReservation" ("runId", "tenantHash", "periodDay", "periodMonth", "reservedAt", "expiresAt", "consumedAt", "costUnits", "reservedUnits", state)
        VALUES ('rr-ledger-legacy', ${"a".repeat(64)}, '2026-07-22', '2026-07-01 00:00:00', '2026-07-22 12:00:00', '2026-07-22 12:05:00', '2026-07-22 12:00:00', 2, 2, 'consumed')`;
        await assert.rejects(
          sql.unsafe(guard),
          /requires owner reconciliation/
        );
        await sql`DELETE FROM "RunReservation" WHERE "runId" = 'rr-ledger-legacy'`;
      }
    );

    await t.test(
      "a rejected ledger insert rolls admission back atomically",
      async () => {
        await sql`CREATE FUNCTION rr_ledger_reject_insert() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic draw insert failure''; END'`;
        await sql`CREATE TRIGGER rr_ledger_reject_insert BEFORE INSERT ON "RunPackDraw" FOR EACH ROW EXECUTE FUNCTION rr_ledger_reject_insert()`;
        try {
          await assert.rejects(
            reserve(
              "rr-ledger-july-a",
              4,
              new Date("2026-07-20T12:00:00.000Z"),
              JULY,
              3
            )
          );
          const [row] =
            await sql`SELECT count(*)::int AS n FROM "RunReservation" WHERE "runId" = 'rr-ledger-july-a'`;
          assert.equal(row.n, 0);
        } finally {
          await sql`DROP TRIGGER rr_ledger_reject_insert ON "RunPackDraw"`;
          await sql`DROP FUNCTION rr_ledger_reject_insert()`;
        }
      }
    );

    for (const [runId, cost, day] of [
      ["rr-ledger-july-a", 4, "2026-07-20T12:00:00.000Z"],
      ["rr-ledger-july-b", 3, "2026-07-21T12:00:00.000Z"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: each admission consumes the preceding balance.
      const result = await reserve(runId, cost, new Date(day), JULY, 3);
      assert.equal(result.kind, "reserved");
      // biome-ignore lint/performance/noAwaitInLoops: sequential consumption is the scenario.
      await reservations.consumeRunReservation(database, {
        consumedAt: new Date(day),
        runId,
        tenant,
      });
    }
    const raisedAt = new Date("2026-07-22T12:00:00.000Z");
    assert.equal(
      (await reserve("rr-ledger-raised", 1, raisedAt, JULY, 20)).kind,
      "reserved"
    );
    await reservations.consumeRunReservation(database, {
      consumedAt: raisedAt,
      runId: "rr-ledger-raised",
      tenant,
    });

    await t.test(
      "next-period cap changes and rotation cannot refund the four recorded draws",
      async () => {
        assert.equal((await usage(3)).tenantPackMinutes, 6);
        assert.equal((await usage(1)).tenantPackMinutes, 6);
        assert.equal((await usage(20)).tenantPackMinutes, 6);
        assert.equal(
          (await usage(20, "synthetic-rotated-key")).tenantPackMinutes,
          6
        );
        const [draws] =
          await sql`SELECT sum(minutes)::int AS minutes FROM "RunPackDraw" WHERE "userId" = ${USER_ID}`;
        assert.equal(draws.minutes, 4);
      }
    );

    await t.test(
      "same-period key rotation and missing audit metadata cannot spend packs twice",
      async () => {
        await sql`UPDATE "RunReservation" SET "userId" = null, "monthlyCap" = null WHERE "runId" = 'rr-ledger-july-a'`;
        assert.equal(
          (
            await reserve(
              "rr-ledger-rotated",
              7,
              raisedAt,
              JULY,
              3,
              "synthetic-rotated-key"
            )
          ).kind,
          "refused"
        );
      }
    );

    await t.test(
      "a rejected pack refund rolls settlement back atomically",
      async () => {
        await sql`CREATE FUNCTION rr_ledger_reject_update() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''synthetic draw refund failure''; END'`;
        await sql`CREATE TRIGGER rr_ledger_reject_update BEFORE UPDATE ON "RunPackDraw" FOR EACH ROW EXECUTE FUNCTION rr_ledger_reject_update()`;
        try {
          assert.deepEqual(
            await cleanup.cleanupRunnerCredentialResourcesAtomically(
              cleanup.drizzleRunnerCredentialCleanupDatabase(queries.db),
              {
                completedAt: new Date("2026-07-20T12:02:00.000Z"),
                mode: "terminal",
                runId: "rr-ledger-july-a",
                startedAt: new Date("2026-07-20T12:00:00.000Z"),
              }
            ),
            { kind: "cleanup_pending", retryable: true }
          );
          const [row] =
            await sql`SELECT "costUnits", "settledAt" FROM "RunReservation" WHERE "runId" = 'rr-ledger-july-a'`;
          assert.equal(row.costUnits, 4);
          assert.equal(row.settledAt, null);
          assert.equal((await usage(1)).tenantPackMinutes, 6);
        } finally {
          await sql`DROP TRIGGER rr_ledger_reject_update ON "RunPackDraw"`;
          await sql`DROP FUNCTION rr_ledger_reject_update()`;
        }
      }
    );

    await t.test(
      "settlement refunds only the unused allocation and is idempotent",
      async () => {
        const cleanupDb = cleanup.drizzleRunnerCredentialCleanupDatabase(
          queries.db
        );
        const input = {
          completedAt: new Date("2026-07-20T12:02:00.000Z"),
          mode: "terminal",
          runId: "rr-ledger-july-a",
          startedAt: new Date("2026-07-20T12:00:00.000Z"),
        } as const;
        assert.deepEqual(
          await cleanup.cleanupRunnerCredentialResourcesAtomically(
            cleanupDb,
            input
          ),
          { kind: "cleaned" }
        );
        assert.deepEqual(
          await cleanup.cleanupRunnerCredentialResourcesAtomically(
            cleanupDb,
            input
          ),
          { kind: "cleaned" }
        );
        assert.equal((await usage(1)).tenantPackMinutes, 7);
        const rows =
          await sql`SELECT "runId", minutes FROM "RunPackDraw" WHERE "runId" IN ('rr-ledger-july-a', 'rr-ledger-july-b') ORDER BY "runId"`;
        assert.deepEqual(
          rows.map((row) => [row.runId, row.minutes]),
          [
            ["rr-ledger-july-a", 0],
            ["rr-ledger-july-b", 3],
          ]
        );
      }
    );

    await t.test(
      "compensation reverses one debit without refunding other usage",
      async () => {
        await reservations.compensateRunReservation(database, {
          runId: "rr-ledger-july-b",
          tenant,
        });
        await reservations.compensateRunReservation(database, {
          runId: "rr-ledger-july-b",
          tenant,
        });
        assert.equal((await usage(1)).tenantPackMinutes, 10);
      }
    );

    await t.test("an expired hold frees its allocation", async () => {
      const earlier = new Date("2026-08-15T11:00:00.000Z");
      assert.equal(
        (await reserve("rr-ledger-expired", 4, earlier, AUGUST, 1)).kind,
        "reserved"
      );
      assert.equal((await usage(1)).tenantMonthlyRemaining, 11);
    });

    await t.test(
      "serializable concurrent holds cannot overdraw packs",
      async () => {
        const now = new Date("2026-08-15T12:00:00.000Z");
        const results = await Promise.all(
          ["rr-ledger-hold-a", "rr-ledger-hold-b"].map((runId) =>
            reserve(runId, 7, now, AUGUST, 1)
          )
        );
        assert.equal(
          results.filter((row) => row.kind === "reserved").length,
          1
        );
        assert.equal(results.filter((row) => row.kind === "refused").length, 1);
      }
    );
  } finally {
    await sql`DELETE FROM "RunUsage" WHERE "runId" = ANY(${runIds})`;
    await sql`DELETE FROM "RunReservation" WHERE "runId" = ANY(${runIds})`;
    await sql`DELETE FROM "MinutePack" WHERE "userId" = ${USER_ID}`;
    await sql`DELETE FROM "StripeEvent" WHERE id = 'evt_ledger_fixture'`;
    await sql`DELETE FROM "User" WHERE id = ${USER_ID}`;
    await sql.end();
    await queries.db.$client.end();
  }
});

test("the billing chain upgrades a database through runner migration 0047", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const full = fileURLToPath(new URL("./migrations/", import.meta.url));
  const folder = await mkdtemp(join(tmpdir(), "coven-ledger-0047-"));
  try {
    await cp(full, folder, { recursive: true });
    const journalPath = join(folder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter(({ idx }) => idx <= 47);
    assert.equal(journal.entries.at(-1)?.idx, 47);
    await writeFile(journalPath, JSON.stringify(journal));
    await withDisposableDatabase(
      {
        E2E_POSTGRES_DISPOSABLE: "1",
        E2E_POSTGRES_URL: databaseUrl,
        NODE_ENV: "test",
      },
      async (url) => {
        const sql = postgres(url, { max: 1, onnotice: () => undefined });
        try {
          const db = drizzle(sql);
          await migrate(db, { migrationsFolder: folder });
          await sql`INSERT INTO "RunReservation" ("runId", "tenantHash", "periodDay", "periodMonth", "reservedAt", "expiresAt", "costUnits", "reservedUnits", state)
            VALUES ('ledger-predecessor-fixture', ${"a".repeat(64)}, '2026-07-22', '2026-07-01 00:00:00', '2026-07-22 12:00:00', '2026-07-22 12:05:00', 2, 2, 'reserved')`;
          await migrate(db, { migrationsFolder: full });
          const [legacy] =
            await sql`SELECT "monthlyCap", "userId" FROM "RunReservation" WHERE "runId" = 'ledger-predecessor-fixture'`;
          assert.deepEqual({ ...legacy }, { monthlyCap: null, userId: null });
          const [draws] =
            await sql`SELECT count(*)::int AS count FROM "RunPackDraw"`;
          assert.equal(draws.count, 0);
        } finally {
          await sql.end();
        }
      }
    );
  } finally {
    await rm(folder, { force: true, recursive: true });
  }
});
