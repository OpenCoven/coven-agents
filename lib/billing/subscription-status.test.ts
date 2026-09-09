import assert from "node:assert/strict";
import test from "node:test";
import { CLOUD_PILOT_PLAN } from "./pilot-plan";
import { subscriptionStatusFor } from "./subscription-status";

const NOW = new Date("2026-08-31T12:00:00.000Z");
const FUTURE = new Date("2026-09-30T12:00:00.000Z");

test("subscription status is active only for a stored future timestamp", () => {
  assert.deepEqual(
    subscriptionStatusFor({ subscribedUntil: FUTURE }, true, NOW),
    {
      active: true,
      checkoutEnabled: true,
      minutePacks: [],
      plan: CLOUD_PILOT_PLAN,
      subscribedUntil: FUTURE.toISOString(),
    }
  );
  assert.deepEqual(
    subscriptionStatusFor({ subscribedUntil: FUTURE }, true, NOW, [
      { minutes: 100, priceId: "price_small" },
    ]).minutePacks,
    [{ minutes: 100, priceId: "price_small" }]
  );

  for (const subscribedUntil of [NOW, null]) {
    assert.equal(
      subscriptionStatusFor({ subscribedUntil }, true, NOW).active,
      false
    );
  }
});

test("subscription status exposes only the public billing shape", () => {
  const status = subscriptionStatusFor({ subscribedUntil: FUTURE }, false, NOW);

  assert.deepEqual(Object.keys(status).sort(), [
    "active",
    "checkoutEnabled",
    "minutePacks",
    "plan",
    "subscribedUntil",
  ]);
  assert.equal("stripeCustomerId" in status, false);
  assert.equal("stripeSubscriptionId" in status, false);
  assert.equal("authVersion" in status, false);
});
