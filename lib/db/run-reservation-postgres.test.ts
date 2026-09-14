import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

/**
 * Pack balances are derived from what earlier periods drew beyond their
 * bucket. The two defects this guards against — a cap change rewriting that
 * history, and an abuse-key rotation erasing it — live in the SQL that
 * groups and compares reservations, which no in-memory fake exercises. Point
 * `RUN_RESERVATION_POSTGRES_TEST_URL` at a migrated throwaway database to
 * run it.
 */
const databaseUrl = process.env.RUN_RESERVATION_POSTGRES_TEST_URL;

const USER_ID = "30000000-0000-4000-8000-0000000000a1";
const JULY = new Date("2026-07-01T00:00:00.000Z");
const AUGUST = new Date("2026-08-01T00:00:00.000Z");

test("pack balance survives a cap change and an abuse-key rotation", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  process.env.POSTGRES_URL = databaseUrl;
  const [{ db }, reservations, session] = await Promise.all([
    import("./queries"),
    import("@/lib/billing/run-reservations"),
    import("@/lib/session"),
  ]);
  const {
    consumeRunReservation,
    drizzleRunReservationDatabase,
    reservationUsage,
    reserveRun,
  } = reservations;
  const tenant = session.tenantForUser(USER_ID);
  const database = drizzleRunReservationDatabase(db);
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const runIds = ["rr-ledger-july-a", "rr-ledger-july-b", "rr-ledger-legacy"];

  const usage = (input: { keySecret: string; tenantMonthlyCap: number }) =>
    reservationUsage(database, {
      globalDailyCap: 500,
      now: new Date("2026-08-15T12:00:00.000Z"),
      periodStart: AUGUST,
      tenant,
      tenantDailyCap: 100,
      ...input,
    });

  try {
    await sql`DELETE FROM "RunUsage" WHERE "runId" = ANY(${runIds})`;
    await sql`DELETE FROM "RunReservation" WHERE "runId" = ANY(${runIds})`;
    await sql`DELETE FROM "MinutePack" WHERE "userId" = ${USER_ID}`;
    await sql`DELETE FROM "User" WHERE id = ${USER_ID}`;
    await sql`
        INSERT INTO "User" (id, email, "emailVerified")
        VALUES (${USER_ID}, ${`${USER_ID}@example.invalid`}, true)
      `;
    await sql`
        INSERT INTO "MinutePack" (minutes, "priceId", "stripeCheckoutSessionId", "userId")
        VALUES (10, 'price_probe', 'cs_rr_ledger_probe', ${USER_ID})
      `;

    // July ran 7 against a bucket of 3, under the pre-rotation key.
    for (const [runId, costUnits, day] of [
      ["rr-ledger-july-a", 4, "2026-07-20T12:00:00.000Z"],
      ["rr-ledger-july-b", 3, "2026-07-21T12:00:00.000Z"],
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: admission of the second run depends on the first being consumed
      const reserved = await reserveRun(database, {
        costUnits,
        globalDailyCap: 500,
        keySecret: "abuse-key-before-rotation",
        now: new Date(day),
        periodStart: JULY,
        runId,
        tenant,
        tenantDailyCap: 100,
        tenantMonthlyCap: 3,
      });
      assert.equal(reserved.kind, "reserved", runId);
      await consumeRunReservation(database, {
        consumedAt: new Date(day),
        runId,
        tenant,
      });
    }

    const [recorded] = await sql`
        SELECT "userId", "monthlyCap" FROM "RunReservation"
        WHERE "runId" = 'rr-ledger-july-a'
      `;
    assert.equal(recorded.userId, USER_ID);
    assert.equal(recorded.monthlyCap, 3);

    // Four pack minutes are gone, whatever the cap says today.
    const same = await usage({
      keySecret: "abuse-key-before-rotation",
      tenantMonthlyCap: 3,
    });
    assert.equal(same.tenantPackMinutes, 6);
    const lowered = await usage({
      keySecret: "abuse-key-before-rotation",
      tenantMonthlyCap: 1,
    });
    assert.equal(lowered.tenantPackMinutes, 6);
    const raised = await usage({
      keySecret: "abuse-key-before-rotation",
      tenantMonthlyCap: 20,
    });
    assert.equal(raised.tenantPackMinutes, 6);

    // Rotating the key changes every tenant hash; the account still matches.
    const rotated = await usage({
      keySecret: "abuse-key-after-rotation",
      tenantMonthlyCap: 3,
    });
    assert.equal(rotated.tenantPackMinutes, 6);

    // A row admitted before the ledger columns: hash-matched, judged
    // against the caller's cap, and lost to rotation by design. Plain
    // literals, because a Date parameter arrives as timestamptz and would
    // shift into these timestamp columns by the session offset.
    const [legacyHash] = await sql`
        SELECT "tenantHash" FROM "RunReservation"
        WHERE "runId" = 'rr-ledger-july-a'
      `;
    await sql`
        INSERT INTO "RunReservation" (
          "runId", "tenantHash", "periodDay", "periodMonth", "reservedAt",
          "expiresAt", "consumedAt", "costUnits", "reservedUnits", state
        ) VALUES (
          'rr-ledger-legacy', ${legacyHash.tenantHash}, '2026-07-22',
          '2026-07-01 00:00:00', '2026-07-22 12:00:00', '2026-07-22 12:05:00',
          '2026-07-22 12:00:00', 2, 2, 'consumed'
        )
      `;
    const withLegacy = await usage({
      keySecret: "abuse-key-before-rotation",
      tenantMonthlyCap: 3,
    });
    assert.equal(withLegacy.tenantPackMinutes, 4);
    const legacyAfterRotation = await usage({
      keySecret: "abuse-key-after-rotation",
      tenantMonthlyCap: 3,
    });
    assert.equal(legacyAfterRotation.tenantPackMinutes, 6);
  } finally {
    await sql`DELETE FROM "RunUsage" WHERE "runId" = ANY(${runIds})`;
    await sql`DELETE FROM "RunReservation" WHERE "runId" = ANY(${runIds})`;
    await sql`DELETE FROM "MinutePack" WHERE "userId" = ${USER_ID}`;
    await sql`DELETE FROM "User" WHERE id = ${USER_ID}`;
    await sql.end();
    // queries.ts opens a module-scope client; the process never exits
    // without closing it.
    await db.$client.end();
  }
});
