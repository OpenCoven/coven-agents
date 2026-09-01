import assert from "node:assert/strict";
import test from "node:test";
import { paidInvoiceMutation } from "./paid-invoice";

const START = new Date("2026-09-01T00:00:00.000Z");
const END = new Date("2026-10-01T00:00:00.000Z");
const NEXT_END = new Date("2026-11-01T00:00:00.000Z");
const EVIDENCE_AT = new Date("2026-09-26T00:00:00.000Z");

const current = {
  billingPeriodStart: START,
  stripeCustomerId: "cus_paid",
  stripeSubscriptionId: "sub_paid",
  subscribedUntil: END,
};

test("paid interval ordering preserves exact webhook precedence", () => {
  for (const input of [
    { periodEnd: END, periodStart: START },
    {
      periodEnd: new Date("2026-09-15T00:00:00.000Z"),
      periodStart: new Date("2026-08-15T00:00:00.000Z"),
    },
    { periodEnd: END, periodStart: new Date("2026-09-15T00:00:00.000Z") },
  ]) {
    assert.equal(
      paidInvoiceMutation(current, {
        customerId: "cus_paid",
        eventCreatedAt: EVIDENCE_AT,
        stripeSubscriptionId: "sub_paid",
        ...input,
      }),
      null
    );
  }

  assert.deepEqual(
    paidInvoiceMutation(current, {
      customerId: "cus_paid",
      eventCreatedAt: EVIDENCE_AT,
      periodEnd: NEXT_END,
      periodStart: END,
      stripeSubscriptionId: "sub_paid",
    }),
    {
      billingPeriodStart: END,
      stripeSubscriptionId: "sub_paid",
      subscribedUntil: NEXT_END,
    }
  );
  assert.deepEqual(
    paidInvoiceMutation(current, {
      customerId: "cus_paid",
      eventCreatedAt: EVIDENCE_AT,
      periodEnd: NEXT_END,
      periodStart: new Date("2026-08-01T00:00:00.000Z"),
      stripeSubscriptionId: "sub_paid",
    }),
    {
      kind: "manual_reconciliation",
      reason: "invoice_conflicting_paid_interval",
    }
  );
});

test("a non-overlapping paid replacement carries the exact new subscription interval", () => {
  assert.deepEqual(
    paidInvoiceMutation(current, {
      customerId: "cus_paid",
      eventCreatedAt: EVIDENCE_AT,
      periodEnd: NEXT_END,
      periodStart: END,
      stripeSubscriptionId: "sub_replacement",
    }),
    {
      billingPeriodStart: END,
      stripeSubscriptionId: "sub_replacement",
      subscribedUntil: NEXT_END,
    }
  );
});
