import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { StripeEventUpdateInput } from "@/lib/billing/webhook";
import { idempotencyRecord, user } from "./schema";
import {
  checkoutAttemptProvenanceWhere,
  stripeEventOwnerWhere,
} from "./stripe-event";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function ownerLockSql(input: StripeEventUpdateInput) {
  return new QueryBuilder()
    .select()
    .from(user)
    .where(stripeEventOwnerWhere(input))
    .for("update")
    .limit(1)
    .toSQL();
}

test("Stripe event owner lookup locks the intended User by metadata id", () => {
  const { params, sql } = ownerLockSql({
    customerId: "cus_webhook",
    eventId: "evt_checkout",
    eventType: "checkout_reference",
    stripeSubscriptionId: "sub_webhook",
    userId: USER_ID,
  });

  assert.match(sql, /where "User"\."id" = \$1/u);
  assert.match(sql, /for update/u);
  assert.match(sql, /limit \$2/u);
  assert.deepEqual(params, [USER_ID, 1]);
});

test("Stripe invoice owner lookup falls back to the unique Customer reference", () => {
  const { params, sql } = ownerLockSql({
    billingReason: "subscription_cycle",
    customerId: "cus_webhook",
    eventId: "evt_invoice",
    eventType: "invoice_paid",
    periodEnd: new Date("2026-10-20T12:00:00.000Z"),
    periodStart: new Date("2026-09-20T12:00:00.000Z"),
    stripeSubscriptionId: "sub_webhook",
  });

  assert.match(sql, /where "User"\."stripeCustomerId" = \$1/u);
  assert.match(sql, /for update/u);
  assert.match(sql, /limit \$2/u);
  assert.deepEqual(params, ["cus_webhook", 1]);
});

test("checkout attempt provenance lookup is scoped by attempt, operation, and owner", () => {
  const { params, sql } = new QueryBuilder()
    .select({ requestHash: idempotencyRecord.requestHash })
    .from(idempotencyRecord)
    .where(
      checkoutAttemptProvenanceWhere({
        attemptId: "11111111-1111-4111-8111-111111111111",
        ownerId: USER_ID,
      })
    )
    .limit(1)
    .toSQL();

  assert.match(sql, /"IdempotencyRecord"\."id" = \$1/u);
  assert.match(sql, /"IdempotencyRecord"\."operation" = \$2/u);
  assert.match(sql, /"IdempotencyRecord"\."ownerId" = \$3/u);
  assert.deepEqual(params, [
    "11111111-1111-4111-8111-111111111111",
    "checkout-attempt",
    USER_ID,
    1,
  ]);
});

test("Stripe reconciliation schema and generated migration retain only bounded operational evidence", () => {
  const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  const reconciliationSchema = schema.slice(
    schema.indexOf("export const stripeReconciliation"),
    schema.indexOf("export const subscriptionOverrideAudit")
  );
  const migrationTag = "0021_lovely_loners";
  const migration = readFileSync(
    new URL(`./migrations/${migrationTag}.sql`, import.meta.url),
    "utf8"
  );
  const journal = readFileSync(
    new URL("./migrations/meta/_journal.json", import.meta.url),
    "utf8"
  );

  assert.match(
    reconciliationSchema,
    /stripeReconciliation = pgTable\(\s*"StripeReconciliation"/
  );
  assert.match(
    reconciliationSchema,
    /eventId: varchar\("eventId", \{ length: 64 \}\)[\s\S]*primaryKey\(\)[\s\S]*references\(\(\) => stripeEvent\.id, \{ onDelete: "restrict" \}\)/
  );
  assert.match(reconciliationSchema, /StripeReconciliation_eventType_check/);
  assert.match(reconciliationSchema, /StripeReconciliation_reason_check/);
  assert.match(reconciliationSchema, /StripeReconciliation_status_check/);
  assert.doesNotMatch(
    reconciliationSchema,
    /StripeReconciliation[\s\S]{0,1600}(userId|customerId|subscriptionId|payload|secret|metadata):/
  );

  assert.match(migration, /CREATE TABLE "StripeReconciliation"/);
  assert.match(migration, /"eventId" varchar\(64\) PRIMARY KEY NOT NULL/);
  assert.match(
    migration,
    /FOREIGN KEY \("eventId"\) REFERENCES "public"\."StripeEvent"\("id"\) ON DELETE restrict/
  );
  assert.match(migration, /StripeReconciliation_eventType_check/);
  assert.match(migration, /StripeReconciliation_reason_check/);
  assert.match(migration, /StripeReconciliation_status_check/);
  assert.match(journal, new RegExp(migrationTag));
  assert.doesNotMatch(
    migration,
    /"(userId|customerId|subscriptionId|payload|secret|metadata)"/
  );
});
