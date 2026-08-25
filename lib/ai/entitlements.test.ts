import assert from "node:assert/strict";
import test from "node:test";
import { entitlementsByPlan } from "./entitlements";

test("every plan has an entitlement and demo is the most limited", () => {
  assert.ok(entitlementsByPlan.demo);
  assert.ok(entitlementsByPlan.subscriber);
  assert.ok(
    entitlementsByPlan.demo.maxMessagesPerHour <
      entitlementsByPlan.subscriber.maxMessagesPerHour
  );
});

test("a demo plan cannot run a harness", () => {
  // Demo has no credential by construction, so this is belt and braces — but
  // it is the entitlement a paywall would be built on, and it must not
  // default open.
  assert.equal(entitlementsByPlan.demo.canRunHarness, false);
  assert.equal(entitlementsByPlan.demo.maxMessagesPerHour, 0);
  assert.equal(entitlementsByPlan.subscriber.canRunHarness, true);
});
