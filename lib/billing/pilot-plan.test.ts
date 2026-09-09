import assert from "node:assert/strict";
import test from "node:test";
import {
  DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS,
  DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS,
} from "../runner/daytona/resource-policy";
import { MONTHLY_MINUTE_CAP, RUN_MINUTE_RESERVATION } from "./limits";
import {
  assertPilotSubscriptionPrice,
  CLOUD_PILOT_PLAN,
  type PilotSubscriptionPrice,
} from "./pilot-plan";

const recurring = {
  interval: "month",
  interval_count: 1,
  trial_period_days: null,
  usage_type: "licensed",
} as const;

const price: PilotSubscriptionPrice = {
  active: true,
  billing_scheme: "per_unit",
  currency: "usd",
  custom_unit_amount: null,
  id: "price_pilot",
  recurring,
  transform_quantity: null,
  type: "recurring",
  unit_amount: 2500,
  unit_amount_decimal: "2500",
};

test("pilot disclosure reuses admission limits and includes no automatic overage or inference", () => {
  assert.equal(CLOUD_PILOT_PLAN.includedMinutes, MONTHLY_MINUTE_CAP);
  assert.equal(CLOUD_PILOT_PLAN.maximumRunMinutes, RUN_MINUTE_RESERVATION);
  assert.equal(CLOUD_PILOT_PLAN.overage, "none");
  assert.equal(CLOUD_PILOT_PLAN.inference, "customer_supplied");
  assert.ok(Object.isFrozen(CLOUD_PILOT_PLAN));
  assert.equal(
    CLOUD_PILOT_PLAN.sandboxPolicy.defaults,
    DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS
  );
  assert.equal(
    CLOUD_PILOT_PLAN.sandboxPolicy.caps,
    DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS
  );
  assert.ok(Object.isFrozen(CLOUD_PILOT_PLAN.sandboxPolicy));
});

test("one fixed monthly price is accepted without inventing an amount or currency", () => {
  assert.doesNotThrow(() => assertPilotSubscriptionPrice(price, price.id));
  assert.doesNotThrow(() =>
    assertPilotSubscriptionPrice(
      {
        ...price,
        currency: "jpy",
        unit_amount: 100,
        unit_amount_decimal: "100",
      },
      price.id
    )
  );
});

test("unsupported prices fail closed", () => {
  const invalid: Partial<PilotSubscriptionPrice>[] = [
    { id: "price_other" },
    { active: false },
    { type: "one_time" },
    { billing_scheme: "tiered" },
    { recurring: null },
    { recurring: { ...recurring, interval: "year" } },
    { recurring: { ...recurring, interval_count: 2 } },
    { recurring: { ...recurring, usage_type: "metered" } },
    { recurring: { ...recurring, trial_period_days: 7 } },
    { custom_unit_amount: { maximum: null, minimum: null, preset: 2500 } },
    { transform_quantity: { divide_by: 10, round: "up" } },
    { currency: "USD" },
    { unit_amount: null },
    { unit_amount: 0, unit_amount_decimal: "0" },
    { unit_amount: -1, unit_amount_decimal: "-1" },
    { unit_amount: 2.5, unit_amount_decimal: "2.5" },
    { unit_amount: Number.MAX_SAFE_INTEGER + 1 },
    { unit_amount_decimal: null },
    { unit_amount_decimal: "2500.5" },
  ];
  for (const override of invalid) {
    assert.throws(
      () => assertPilotSubscriptionPrice({ ...price, ...override }, price.id),
      /does not match/
    );
  }
});
