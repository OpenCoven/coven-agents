import assert from "node:assert/strict";
import test from "node:test";
import { CAMPAIGN_PERIOD_EPOCH } from "./campaign";
import { runEntitlementFor } from "./entitlement";
import { MONTHLY_MINUTE_CAP, RUN_MINUTE_RESERVATION } from "./limits";

const CAMPAIGN = { minutes: 20, runMinutes: 5 };
const NOW = new Date("2026-09-06T00:00:00.000Z");

const LIVE_GRANT = {
  campaignExpiresAt: new Date("2026-09-20T00:00:00.000Z"),
  campaignGrantedAt: new Date("2026-09-06T00:00:00.000Z"),
};

test("an account with nothing has no entitlement", () => {
  assert.equal(runEntitlementFor(null, NOW, CAMPAIGN), null);
  assert.equal(
    runEntitlementFor(
      { billingPeriodStart: null, subscribedUntil: null },
      NOW,
      CAMPAIGN
    ),
    null
  );
});

test("a live subscription is admitted with the full bucket and full runs", () => {
  const entitlement = runEntitlementFor(
    {
      billingPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      subscribedUntil: new Date("2026-10-01T00:00:00.000Z"),
    },
    NOW,
    CAMPAIGN
  );
  assert.equal(entitlement?.source, "subscription");
  assert.equal(entitlement?.tenantMonthlyCap, MONTHLY_MINUTE_CAP);
  assert.equal(entitlement?.costUnits, RUN_MINUTE_RESERVATION);
  assert.deepEqual(
    entitlement?.periodStart,
    new Date("2026-09-01T00:00:00.000Z")
  );
});

test("a campaign grant is admitted with its own cap, run size and lifetime period", () => {
  const entitlement = runEntitlementFor(
    { ...LIVE_GRANT, billingPeriodStart: null, subscribedUntil: null },
    NOW,
    CAMPAIGN
  );
  assert.equal(entitlement?.source, "campaign");
  assert.equal(entitlement?.tenantMonthlyCap, 20);
  assert.equal(entitlement?.costUnits, 5);
  // The fixed epoch is what makes 20 minutes a lifetime total rather than a
  // monthly allowance that quietly refills.
  assert.deepEqual(entitlement?.periodStart, CAMPAIGN_PERIOD_EPOCH);
});

test("an expired grant is no entitlement at all", () => {
  assert.equal(
    runEntitlementFor(
      {
        billingPeriodStart: null,
        campaignExpiresAt: new Date("2026-09-05T00:00:00.000Z"),
        campaignGrantedAt: new Date("2026-08-22T00:00:00.000Z"),
        subscribedUntil: null,
      },
      NOW,
      CAMPAIGN
    ),
    null
  );
});

test("a paying subscriber holding a grant is admitted as a subscriber", () => {
  // Spending the smaller grant first would silently downgrade someone who
  // paid, and strand their campaign minutes behind an expiry they do not care
  // about.
  const entitlement = runEntitlementFor(
    {
      ...LIVE_GRANT,
      billingPeriodStart: new Date("2026-09-01T00:00:00.000Z"),
      subscribedUntil: new Date("2026-10-01T00:00:00.000Z"),
    },
    NOW,
    CAMPAIGN
  );
  assert.equal(entitlement?.source, "subscription");
  assert.equal(entitlement?.tenantMonthlyCap, MONTHLY_MINUTE_CAP);
});

test("a LAPSED subscriber holding a live grant falls back to the grant", () => {
  // The regression this guards: `periodStart` yields a date for any
  // `subscribedUntil`, including a past one, so testing the period alone would
  // hand a lapsed subscriber 300 minutes against a stale window.
  const entitlement = runEntitlementFor(
    {
      ...LIVE_GRANT,
      billingPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
      subscribedUntil: new Date("2026-08-01T00:00:00.000Z"),
    },
    NOW,
    CAMPAIGN
  );
  assert.equal(entitlement?.source, "campaign");
  assert.equal(entitlement?.tenantMonthlyCap, 20);
  assert.equal(entitlement?.costUnits, 5);
});

test("a lapsed subscriber with no grant has no entitlement", () => {
  assert.equal(
    runEntitlementFor(
      {
        billingPeriodStart: new Date("2026-07-01T00:00:00.000Z"),
        subscribedUntil: new Date("2026-08-01T00:00:00.000Z"),
      },
      NOW,
      CAMPAIGN
    ),
    null
  );
});

test("a campaign configured to nothing grants nothing", () => {
  for (const campaign of [
    { minutes: 0, runMinutes: 5 },
    { minutes: 20, runMinutes: 0 },
  ]) {
    assert.equal(
      runEntitlementFor(
        { ...LIVE_GRANT, billingPeriodStart: null, subscribedUntil: null },
        NOW,
        campaign
      ),
      null
    );
  }
});

test("a run can never reserve more than the whole grant", () => {
  const entitlement = runEntitlementFor(
    { ...LIVE_GRANT, billingPeriodStart: null, subscribedUntil: null },
    NOW,
    { minutes: 3, runMinutes: 5 }
  );
  assert.equal(entitlement?.costUnits, 3);
});
