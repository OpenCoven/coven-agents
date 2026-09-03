import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";

/**
 * The credit path's ordering is only observable against a real database: the
 * bug it guards against was a transaction that committed a claim and returned
 * a mismatch, which no stubbed dependency can reproduce. Point
 * `MINUTE_PACK_POSTGRES_TEST_URL` at a migrated throwaway database to run it.
 */
const databaseUrl = process.env.MINUTE_PACK_POSTGRES_TEST_URL;

test("an owner mismatch leaves the Stripe event unclaimed so the credit survives redelivery", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  process.env.POSTGRES_URL = databaseUrl;
  const queries = await import("./queries");
  const { creditMinutePack } = queries;
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const userId = "20000000-0000-4000-8000-0000000000f1";
  const eventId = "evt_owner_mismatch_probe";
  const sessionId = "cs_owner_mismatch_probe";

  try {
    await sql`DELETE FROM "MinutePack" WHERE "userId" = ${userId}`;
    await sql`DELETE FROM "StripeEvent" WHERE id = ${eventId}`;
    await sql`DELETE FROM "User" WHERE id = ${userId}`;
    await sql`
        INSERT INTO "User" (id, email, "emailVerified", "stripeCustomerId")
        VALUES (${userId}, ${`${userId}@example.invalid`}, true, 'cus_correct')
      `;

    const credit = (customerId: string) =>
      creditMinutePack({
        customerId,
        eventId,
        minutes: 100,
        paymentIntentId: null,
        priceId: "price_probe",
        sessionId,
        userId,
      });

    assert.equal(await credit("cus_stale"), "owner_mismatch");
    const [claim] = await sql`
        SELECT count(*)::int AS n FROM "StripeEvent" WHERE id = ${eventId}
      `;
    assert.equal(
      claim.n,
      0,
      "a mismatch must not consume the event, or redelivery credits nothing"
    );

    // The same event, redelivered once the customer id is repaired.
    assert.equal(await credit("cus_correct"), "applied");
    const [packs] = await sql`
        SELECT count(*)::int AS n FROM "MinutePack" WHERE "userId" = ${userId}
      `;
    assert.equal(packs.n, 1);
    assert.equal(await credit("cus_correct"), "duplicate");

    /**
     * Evidence about an event writes the event marker for its foreign key. A
     * payment that was recorded but never credited must still be creditable
     * when it is redelivered, so the marker alone cannot mean "already paid".
     */
    const recordedOnly = "evt_recorded_not_credited";
    await sql`DELETE FROM "StripeReconciliation" WHERE "eventId" = ${recordedOnly}`;
    await sql`DELETE FROM "StripeEvent" WHERE id = ${recordedOnly}`;
    await sql`INSERT INTO "StripeEvent" (id) VALUES (${recordedOnly})`;
    await sql`
      INSERT INTO "StripeReconciliation" ("eventId", "eventType", reason, status)
      VALUES (${recordedOnly}, 'checkout.session.completed', 'minute_pack_owner_mismatch', 'pending')
    `;
    assert.equal(
      await creditMinutePack({
        customerId: "cus_correct",
        eventId: recordedOnly,
        minutes: 50,
        paymentIntentId: null,
        priceId: "price_probe",
        sessionId: "cs_recorded_not_credited",
        userId,
      }),
      "applied"
    );
    await sql`DELETE FROM "StripeReconciliation" WHERE "eventId" = ${recordedOnly}`;
    await sql`DELETE FROM "StripeEvent" WHERE id = ${recordedOnly}`;
  } finally {
    await sql`DELETE FROM "MinutePack" WHERE "userId" = ${userId}`;
    await sql`DELETE FROM "StripeEvent" WHERE id = ${eventId}`;
    await sql`DELETE FROM "User" WHERE id = ${userId}`;
    await sql.end();
    // queries.ts opens a module-scope client; without this the test file
    // never exits and takes the whole unit run down with it.
    await (
      queries.db as unknown as { $client: { end: () => Promise<void> } }
    ).$client.end();
  }
});
