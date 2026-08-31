import assert from "node:assert/strict";
import test from "node:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { StripeEventUpdateInput } from "@/lib/billing/webhook";
import { user } from "./schema";
import { stripeEventOwnerWhere } from "./stripe-event";

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
