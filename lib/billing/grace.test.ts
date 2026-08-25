import assert from "node:assert/strict";
import test from "node:test";
import { graceExtension } from "./grace";
import { GRACE_PERIOD_DAYS } from "./limits";

const PAID_UNTIL = new Date("2026-09-20T12:00:00.000Z");

test("a failed renewal extends once", () => {
  const extended = graceExtension({
    billingReason: "subscription_cycle",
    graceAlreadyApplied: false,
    subscribedUntil: PAID_UNTIL,
  });

  assert.ok(extended);
  assert.equal(
    extended.getTime() - PAID_UNTIL.getTime(),
    GRACE_PERIOD_DAYS * 86_400_000
  );
});

test("a failed FIRST payment grants nothing", () => {
  // The one that would hand out free subscriptions. Extending after a failed
  // subscription_create gives a subscriber session -- database writes and
  // credential storage -- to someone who has never paid, contradicting the
  // no-trial invariant the spec states directly.
  assert.equal(
    graceExtension({
      billingReason: "subscription_create",
      graceAlreadyApplied: false,
      subscribedUntil: null,
    }),
    null
  );
});

test("a renewal failure with no paid period behind it grants nothing", () => {
  // Defence in depth: `subscription_cycle` with a null date should not happen,
  // and if it does it must not become an extension from nowhere.
  assert.equal(
    graceExtension({
      billingReason: "subscription_cycle",
      graceAlreadyApplied: false,
      subscribedUntil: null,
    }),
    null
  );
});

test("grace does not compound", () => {
  // Two consecutive failures must not become a fortnight of free access.
  assert.equal(
    graceExtension({
      billingReason: "subscription_cycle",
      graceAlreadyApplied: true,
      subscribedUntil: PAID_UNTIL,
    }),
    null
  );
});

test("an unknown billing reason grants nothing", () => {
  // Allow-listed rather than excluded, so a reason Stripe adds later defaults
  // to granting nothing instead of silently being admitted.
  for (const billingReason of [
    "manual",
    "subscription_update",
    "subscription_threshold",
    "",
  ]) {
    assert.equal(
      graceExtension({
        billingReason,
        graceAlreadyApplied: false,
        subscribedUntil: PAID_UNTIL,
      }),
      null,
      `${JSON.stringify(billingReason)} must not extend`
    );
  }
});
