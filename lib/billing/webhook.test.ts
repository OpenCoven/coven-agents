import assert from "node:assert/strict";
import test from "node:test";
import { GRACE_PERIOD_DAYS } from "./limits";
import { subscriptionUpdate } from "./webhook";

const PAID_UNTIL = new Date("2026-09-20T12:00:00.000Z");

test("a paid invoice sets the period end", () => {
  const update = subscriptionUpdate({
    billingReason: "subscription_cycle",
    current: null,
    periodEnd: PAID_UNTIL,
    type: "invoice.paid",
  });

  assert.equal(update?.subscribedUntil.toISOString(), PAID_UNTIL.toISOString());
});

test("a paid invoice with no period end changes nothing", () => {
  // Without a date there is nothing to grant, and defaulting to "now plus a
  // month" would invent a subscription the invoice never described.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: null,
      periodEnd: null,
      type: "invoice.paid",
    }),
    null
  );
});

test("a failed renewal extends by the grace window", () => {
  const update = subscriptionUpdate({
    billingReason: "subscription_cycle",
    current: PAID_UNTIL,
    periodEnd: null,
    type: "invoice.payment_failed",
  });

  assert.equal(
    update?.subscribedUntil.getTime(),
    PAID_UNTIL.getTime() + GRACE_PERIOD_DAYS * 86_400_000
  );
});

test("a failed renewal preserves the paid billing-period start", () => {
  const input = {
    billingReason: "subscription_cycle",
    current: PAID_UNTIL,
    currentPeriodStart: new Date("2026-08-20T12:00:00.000Z"),
    periodEnd: null,
    type: "invoice.payment_failed",
  };
  const update = subscriptionUpdate(input);

  assert.deepEqual(update, {
    billingPeriodStart: input.currentPeriodStart,
    subscribedUntil: new Date(
      PAID_UNTIL.getTime() + GRACE_PERIOD_DAYS * 86_400_000
    ),
  });
});

test("a failed FIRST payment changes nothing", () => {
  // Would otherwise grant a subscriber session -- database writes and
  // credential storage -- to someone who has never paid.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_create",
      current: null,
      periodEnd: null,
      type: "invoice.payment_failed",
    }),
    null
  );
});

test("a cancellation revokes nothing", () => {
  // The period is already paid for. Access ends when the date passes.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: PAID_UNTIL,
      periodEnd: null,
      type: "customer.subscription.deleted",
    }),
    null
  );
});

test("an unrecognised event changes nothing", () => {
  // Allow-listed on type, so an event Stripe adds later defaults to changing
  // nothing rather than falling into a branch never considered for it.
  for (const type of ["invoice.upcoming", "customer.updated", "ping", ""]) {
    assert.equal(
      subscriptionUpdate({
        billingReason: "subscription_cycle",
        current: PAID_UNTIL,
        periodEnd: PAID_UNTIL,
        type,
      }),
      null,
      `${JSON.stringify(type)} must change nothing`
    );
  }
});

test("a failed FIRST payment is refused even when a prior period exists", () => {
  // Closes a hole mutation testing found: every other subscription_create
  // case in this file also had a null `current`, so graceExtension refused on
  // the missing date rather than the reason -- and hardcoding the reason to
  // "subscription_cycle" passed the whole suite. A returning customer whose
  // first invoice on a NEW subscription fails would then have been handed
  // three free days.
  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_create",
      current: PAID_UNTIL,
      periodEnd: null,
      type: "invoice.payment_failed",
    }),
    null
  );
});

test("grace does not compound across two failures", () => {
  // `current` already beyond `periodEnd` means grace was granted once. A
  // second failure inside that window must not extend again -- otherwise two
  // failed retries become a fortnight of unpaid access.
  const alreadyExtended = new Date(PAID_UNTIL.getTime() + 3 * 86_400_000);

  assert.equal(
    subscriptionUpdate({
      billingReason: "subscription_cycle",
      current: alreadyExtended,
      periodEnd: PAID_UNTIL,
      type: "invoice.payment_failed",
    }),
    null
  );
});
