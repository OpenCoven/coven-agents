import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { setTimeout } from "node:timers/promises";
import postgres from "postgres";
import type Stripe from "stripe";
import {
  STRIPE_RECONCILIATION_STATUSES,
  type StripeReconciliationReason,
  type StripeReconciliationRecord,
} from "../billing/stripe-reconciliation";
import {
  type StripeEventUpdateInput,
  type StripeManualReconciliationWriteResult,
  type StripeWebhookConfig,
  type StripeWebhookDependencies,
  stripeWebhookResponse,
} from "../billing/webhook";
import { ChatbotError } from "../errors";

// Run only against a migrated, disposable PostgreSQL database. Provider calls
// are replaced at the webhook boundary; all billing writes use the real DB.
const databaseUrl = process.env.STRIPE_RECONCILIATION_POSTGRES_TEST_URL;
type StoredReconciliation = StripeReconciliationRecord & { createdAt: Date };

test("Stripe reconciliation redelivery against PostgreSQL", {
  skip: !databaseUrl,
  timeout: 30_000,
}, async (t) => {
  assert.ok(databaseUrl);
  const previousDatabaseUrl = process.env.POSTGRES_URL;
  process.env.POSTGRES_URL = databaseUrl;
  const queries = await import("./queries");
  const sql = postgres(databaseUrl, { max: 1 });
  const userId = randomUUID();
  const runId = randomUUID().slice(0, 8);
  const eventIds: string[] = [];
  const customerId = `cus_reconciliation_${runId}`;
  const priceId = "price_reconciliation300";

  function record(
    name: string,
    reason: StripeReconciliationReason = "minute_pack_unconfigured",
    eventType: StripeReconciliationRecord["eventType"] = "checkout.session.completed"
  ): StripeReconciliationRecord {
    const eventId = `evt_reconcile_${runId}_${name}`;
    eventIds.push(eventId);
    return { eventId, eventType, reason, status: "pending" };
  }

  async function stored(eventId: string) {
    const rows = await sql<StoredReconciliation[]>`
      SELECT * FROM "StripeReconciliation" WHERE "eventId" = ${eventId}
    `;
    assert.equal(rows.length, 1);
    return rows[0];
  }

  async function marker(eventId: string) {
    return await sql`
      SELECT * FROM "StripeEvent" WHERE id = ${eventId}
    `;
  }

  try {
    await sql`
      INSERT INTO "User" (id, email, "emailVerified", "stripeCustomerId")
      VALUES (${userId}, ${`${userId}@example.invalid`}, true, ${customerId})
    `;

    for (const status of STRIPE_RECONCILIATION_STATUSES) {
      // biome-ignore lint/performance/noAwaitInLoops: Each case exercises ordered redeliveries.
      await t.test(
        `a changed reason reopens ${status}; same-reason replay preserves it`,
        async () => {
          const initial = record(status);
          assert.deepEqual(
            await queries.recordStripeReconciliation({
              ...initial,
              status: "resolved",
            }),
            { kind: "manual_reconciliation", record: initial }
          );
          await sql`
          UPDATE "StripeReconciliation" SET status = ${status}
          WHERE "eventId" = ${initial.eventId}
        `;
          const before = await stored(initial.eventId);
          const claim = await marker(initial.eventId);
          assert.equal(
            await queries.recordStripeReconciliation(initial),
            "duplicate"
          );
          assert.deepEqual(await stored(initial.eventId), before);

          const changed = {
            ...initial,
            reason: "minute_pack_owner_mismatch",
          } as const;
          assert.deepEqual(await queries.recordStripeReconciliation(changed), {
            kind: "manual_reconciliation",
            record: changed,
          });
          assert.deepEqual(await stored(initial.eventId), {
            ...before,
            reason: changed.reason,
            status: "pending",
          });
          assert.deepEqual(await marker(initial.eventId), claim);
          assert.equal(
            await queries.recordStripeReconciliation(changed),
            "duplicate"
          );
          assert.deepEqual(await stored(initial.eventId), {
            ...before,
            reason: changed.reason,
            status: "pending",
          });
        }
      );
    }

    for (const eventType of [
      "invoice.paid",
      "invoice.payment_failed",
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: These share the same account and database connection.
      await t.test(
        `${eventType} evidence can change without replaying financial effects`,
        async () => {
          const initial = record(
            eventType,
            "invoice_invalid_period",
            eventType
          );
          await queries.recordStripeReconciliation(initial);
          const changed = {
            ...initial,
            reason: "invoice_invalid_reference",
          } as const;
          assert.deepEqual(await queries.recordStripeReconciliation(changed), {
            kind: "manual_reconciliation",
            record: changed,
          });
          assert.equal((await stored(initial.eventId)).reason, changed.reason);

          const input: StripeEventUpdateInput = {
            billingReason: "subscription_cycle",
            customerId,
            eventCreatedAt: new Date("2026-09-14T00:00:00Z"),
            eventId: initial.eventId,
            eventType:
              eventType === "invoice.paid"
                ? "invoice_paid"
                : "invoice_payment_failed",
            periodEnd: new Date("2026-10-14T00:00:00Z"),
            periodStart: new Date("2026-09-14T00:00:00Z"),
            stripeSubscriptionId: "sub_reconciliation",
            userId,
          };
          const before = await sql`SELECT * FROM "User" WHERE id = ${userId}`;
          assert.equal(
            await queries.applyStripeEventUpdate(input),
            "duplicate"
          );
          assert.deepEqual(
            await sql`SELECT * FROM "User" WHERE id = ${userId}`,
            before
          );
        }
      );
    }

    await t.test(
      "a processed event with no reconciliation stays duplicate",
      async () => {
        const initial = record(
          "processed",
          "invoice_invalid_period",
          "invoice.paid"
        );
        const input: StripeEventUpdateInput = {
          billingReason: "subscription_create",
          customerId,
          eventCreatedAt: new Date("2026-09-14T00:00:00Z"),
          eventId: initial.eventId,
          eventType: "invoice_paid",
          periodEnd: new Date("2026-10-14T00:00:00Z"),
          periodStart: new Date("2026-09-14T00:00:00Z"),
          stripeSubscriptionId: "sub_reconciliation",
          userId,
        };
        assert.equal(await queries.applyStripeEventUpdate(input), "applied");
        const before = await sql`SELECT * FROM "User" WHERE id = ${userId}`;
        const claim = await marker(initial.eventId);
        assert.equal(
          await queries.recordStripeReconciliation(initial),
          "duplicate"
        );
        assert.equal(
          await queries.applyStripeEventUpdate({
            ...input,
            periodEnd: new Date("2026-11-14T00:00:00Z"),
            periodStart: new Date("2026-10-14T00:00:00Z"),
          }),
          "duplicate"
        );
        assert.deepEqual(
          await sql`SELECT * FROM "User" WHERE id = ${userId}`,
          before
        );
        assert.deepEqual(await marker(initial.eventId), claim);
        const rows = await sql`
        SELECT * FROM "StripeReconciliation" WHERE "eventId" = ${initial.eventId}
      `;
        assert.equal(rows.length, 0);
      }
    );

    await t.test(
      "a competing processed-event claim never creates reconciliation evidence",
      async () => {
        const initial = record("processed_race");
        let pending: Promise<StripeManualReconciliationWriteResult> | undefined;
        let result: StripeManualReconciliationWriteResult | undefined;
        try {
          await sql.begin(async (transaction) => {
            await transaction`INSERT INTO "StripeEvent" (id) VALUES (${initial.eventId})`;
            pending = queries.recordStripeReconciliation(initial);
            await waitForBlockedWriter(transaction);
          });
        } finally {
          result = await pending;
        }
        assert.equal(result, "duplicate");
        assert.equal((await marker(initial.eventId)).length, 1);
        const rows = await sql`
        SELECT * FROM "StripeReconciliation" WHERE "eventId" = ${initial.eventId}
      `;
        assert.equal(rows.length, 0);
      }
    );

    await t.test(
      "a competing claim waits for its reconciliation row before updating the reason",
      async () => {
        const initial = record("claim_race");
        const changed = {
          ...initial,
          reason: "minute_pack_owner_mismatch",
        } as const;
        let pending: Promise<StripeManualReconciliationWriteResult> | undefined;
        let result: StripeManualReconciliationWriteResult | undefined;
        try {
          await sql.begin(async (transaction) => {
            await transaction`INSERT INTO "StripeEvent" (id) VALUES (${initial.eventId})`;
            pending = queries.recordStripeReconciliation(changed);
            await waitForBlockedWriter(transaction);
            await transaction`
            INSERT INTO "StripeReconciliation" ("eventId", "eventType", reason, status)
            VALUES (${initial.eventId}, ${initial.eventType}, ${initial.reason}, 'resolved')
          `;
          });
        } finally {
          result = await pending;
        }
        assert.deepEqual(result, {
          kind: "manual_reconciliation",
          record: changed,
        });
        assert.equal((await stored(initial.eventId)).reason, changed.reason);
        assert.equal((await stored(initial.eventId)).status, "pending");
      }
    );

    await t.test(
      "a rolled-back competing claim does not consume the retry",
      async () => {
        const initial = record("claim_rollback");
        const aborted = new Error("abort first event writer");
        let pending: Promise<StripeManualReconciliationWriteResult> | undefined;
        let result: StripeManualReconciliationWriteResult | undefined;
        try {
          await assert.rejects(
            sql.begin(async (transaction) => {
              await transaction`INSERT INTO "StripeEvent" (id) VALUES (${initial.eventId})`;
              pending = queries.recordStripeReconciliation(initial);
              await waitForBlockedWriter(transaction);
              throw aborted;
            }),
            (error) => error === aborted
          );
        } finally {
          result = await pending;
        }
        assert.deepEqual(result, {
          kind: "manual_reconciliation",
          record: initial,
        });
        assert.equal((await stored(initial.eventId)).reason, initial.reason);
        assert.equal((await marker(initial.eventId)).length, 1);
      }
    );

    await t.test(
      "concurrent same-reason redeliveries reopen exactly once",
      async () => {
        const initial = record("concurrent");
        await queries.recordStripeReconciliation(initial);
        await sql`
        UPDATE "StripeReconciliation" SET status = 'acknowledged'
        WHERE "eventId" = ${initial.eventId}
      `;
        const changed = {
          ...initial,
          reason: "minute_pack_owner_mismatch",
        } as const;
        const results = await Promise.all(
          Array.from({ length: 8 }, () =>
            queries.recordStripeReconciliation(changed)
          )
        );
        assert.equal(
          results.filter((result) => result === "duplicate").length,
          7
        );
        assert.deepEqual(
          results.filter((result) => result !== "duplicate"),
          [{ kind: "manual_reconciliation", record: changed }]
        );
        assert.equal((await stored(initial.eventId)).reason, changed.reason);
        assert.equal((await stored(initial.eventId)).status, "pending");
      }
    );

    await t.test(
      "a failed evidence insert rolls back the event claim",
      async () => {
        const initial = record("insert_failure");
        await assert.rejects(
          queries.recordStripeReconciliation({
            ...initial,
            // Deliberately cross the typed boundary to exercise a real CHECK failure.
            reason: "invalid" as StripeReconciliationReason,
          }),
          isCheckConstraintFailure
        );
        assert.equal((await marker(initial.eventId)).length, 0);
        assert.deepEqual(await queries.recordStripeReconciliation(initial), {
          kind: "manual_reconciliation",
          record: initial,
        });
      }
    );

    await t.test(
      "a failed reason update preserves the previous evidence and status",
      async () => {
        const initial = record("update_failure");
        await queries.recordStripeReconciliation(initial);
        await sql`
        UPDATE "StripeReconciliation" SET status = 'resolved'
        WHERE "eventId" = ${initial.eventId}
      `;
        const before = await stored(initial.eventId);
        const claim = await marker(initial.eventId);
        await assert.rejects(
          queries.recordStripeReconciliation({
            ...initial,
            reason: "invalid" as StripeReconciliationReason,
          }),
          isCheckConstraintFailure
        );
        assert.deepEqual(await stored(initial.eventId), before);
        assert.deepEqual(await marker(initial.eventId), claim);
      }
    );

    for (const eventType of [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ] as const) {
      // biome-ignore lint/performance/noAwaitInLoops: Each repair sequence deliberately shares one account.
      await t.test(
        `${eventType}: unconfigured -> owner mismatch -> one credit retains the latest reason`,
        async () => {
          const initial = record(
            eventType === "checkout.session.completed"
              ? "sequence"
              : "async_sequence",
            "minute_pack_unconfigured",
            eventType
          );
          const sessionId = `cs_${initial.eventId}`;
          await sql`
          UPDATE "User" SET "stripeCustomerId" = 'cus_stale'
          WHERE id = ${userId}
        `;
          const session: Partial<Stripe.Checkout.Session> = {
            client_reference_id: userId,
            customer: customerId,
            id: sessionId,
            metadata: {
              kind: "minute_pack",
              minutePackFlowVersion: "1",
              minutes: "300",
              priceId,
              userId,
            },
            mode: "payment",
            object: "checkout.session",
            payment_intent: null,
            payment_status: "paid",
          };
          const event: Stripe.Event = {
            api_version: "2026-08-26.dahlia",
            created: 1_789_344_000,
            data: { object: session as Stripe.Checkout.Session },
            id: initial.eventId,
            livemode: false,
            object: "event",
            pending_webhooks: 1,
            request: null,
            type: eventType,
          };
          const config: StripeWebhookConfig = {
            apiKey: "unused-offline-provider",
            minutePacks: [],
            priceId: "price_subscription",
            webhookSecret: "unused-offline-provider",
          };
          const alerts: StripeReconciliationRecord[] = [];
          const dependencies: StripeWebhookDependencies = {
            applyEventUpdate: queries.applyStripeEventUpdate,
            createProvider: () => ({
              constructEvent: async () => event,
              listInvoiceLines: unexpectedProviderCall,
              retrieveCustomer: unexpectedProviderCall,
            }),
            creditMinutePack: queries.creditMinutePack,
            enforceAbuse: async () => ({ kind: "allowed" }),
            findCheckoutAttemptState: queries.findCheckoutAttemptState,
            findUserByStripeCustomerId: queries.findUserByStripeCustomerId,
            getConfig: () => config,
            now: () => new Date((event.created + 7200) * 1000),
            recordManualReconciliation: queries.recordStripeReconciliation,
            reportManualReconciliation: (value) => {
              alerts.push(value);
            },
          };
          const deliver = async () => {
            const response = await stripeWebhookResponse(
              new Request("http://localhost/api/stripe/webhook", {
                body: '{"offline":true}',
                headers: { "stripe-signature": "offline-fixture" },
                method: "POST",
              }),
              dependencies,
              null
            );
            assert.equal(response.status, 200);
            return await response.json();
          };
          const packs = async () =>
            await sql`
            SELECT * FROM "MinutePack" WHERE "stripeCheckoutSessionId" = ${sessionId}
          `;

          assert.deepEqual(await deliver(), {
            reason: initial.reason,
            reconciliation: true,
          });
          const before = await stored(initial.eventId);
          assert.equal((await packs()).length, 0);

          config.minutePacks = [{ minutes: 300, priceId }];
          const changed = {
            ...initial,
            reason: "minute_pack_owner_mismatch",
          } as const;
          assert.deepEqual(await deliver(), {
            reason: changed.reason,
            reconciliation: true,
          });
          assert.deepEqual(await stored(initial.eventId), {
            ...before,
            reason: changed.reason,
          });
          assert.equal((await packs()).length, 0);
          assert.deepEqual(await deliver(), { deduped: true });
          assert.deepEqual(alerts, [initial, changed]);

          await sql`
          UPDATE "User" SET "stripeCustomerId" = ${customerId}
          WHERE id = ${userId}
        `;
          const results = await Promise.all(Array.from({ length: 6 }, deliver));
          assert.equal(results.filter((result) => result.received).length, 1);
          assert.equal(results.filter((result) => result.deduped).length, 5);
          const credited = await packs();
          assert.equal(credited.length, 1);
          assert.equal(credited[0].minutes, 300);
          assert.equal(credited[0].userId, userId);
          assert.deepEqual(await deliver(), { deduped: true });

          event.id = record(
            `${initial.eventType === "checkout.session.completed" ? "sequence" : "async"}_alias`
          ).eventId;
          assert.deepEqual(await deliver(), { deduped: true });
          assert.deepEqual(await packs(), credited);
          assert.deepEqual(await stored(initial.eventId), {
            ...before,
            reason: changed.reason,
          });
          assert.deepEqual(alerts, [initial, changed]);
        }
      );
    }
  } finally {
    await sql`DELETE FROM "MinutePack" WHERE "userId" = ${userId}`;
    if (eventIds.length > 0) {
      await sql`DELETE FROM "StripeReconciliation" WHERE "eventId" IN ${sql(eventIds)}`;
      await sql`DELETE FROM "StripeEvent" WHERE id IN ${sql(eventIds)}`;
    }
    await sql`DELETE FROM "User" WHERE id = ${userId}`;
    await sql.end();
    await queries.db.$client.end();
    if (previousDatabaseUrl === undefined) {
      delete process.env.POSTGRES_URL;
    } else {
      process.env.POSTGRES_URL = previousDatabaseUrl;
    }
  }
});

async function waitForBlockedWriter(transaction: postgres.TransactionSql) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    // biome-ignore lint/performance/noAwaitInLoops: Observe the actual lock wait before allowing the first writer to commit.
    const [row] = await transaction`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND pg_backend_pid() = ANY(pg_blocking_pids(pid))
      ) AS blocked
    `;
    if (row.blocked) {
      return;
    }
    await setTimeout(10);
  }
  assert.fail(
    "the competing event writer never waited on the first transaction"
  );
}

function isCheckConstraintFailure(error: unknown): boolean {
  assert.ok(error instanceof ChatbotError);
  let cause: unknown = error.cause;
  while (cause instanceof Error && cause.cause) {
    ({ cause } = cause);
  }
  assert.ok(cause instanceof postgres.PostgresError);
  assert.equal(cause.code, "23514");
  return true;
}

function unexpectedProviderCall(): never {
  throw new Error("this fixture must not perform provider enrichment");
}
