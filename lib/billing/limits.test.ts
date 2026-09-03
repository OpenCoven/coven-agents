import assert from "node:assert/strict";
import test from "node:test";
import { RUNNER_MID_RUN_ENTITLEMENT_POLICY } from "@/lib/runner/entitlement-policy";
import {
  GRACE_PERIOD_DAYS,
  MONTHLY_MINUTE_CAP,
  RUN_MINUTE_RESERVATION,
} from "./limits";

test("the cap is a positive whole number of minutes", () => {
  // Quoted to the user in three places. A fractional or zero cap would be
  // shown verbatim on a pricing page.
  assert.ok(Number.isInteger(MONTHLY_MINUTE_CAP));
  assert.ok(MONTHLY_MINUTE_CAP > 0);
});

test("the cap is the agreed 300 minutes", () => {
  // Pinned deliberately. The number is a commercial commitment, not an
  // implementation detail, so changing it should require changing a test that
  // says so out loud.
  assert.equal(MONTHLY_MINUTE_CAP, 300);
});

test("a run reserves exactly the runner's execution time limit", () => {
  // Admission reserves the most a run can hold. If the runner limit moves,
  // this reservation must move with it or the cap becomes overcommittable.
  assert.ok(Number.isInteger(RUN_MINUTE_RESERVATION));
  assert.equal(
    RUN_MINUTE_RESERVATION,
    Math.ceil(RUNNER_MID_RUN_ENTITLEMENT_POLICY.maxDurationMs / 60_000)
  );
  assert.ok(RUN_MINUTE_RESERVATION < MONTHLY_MINUTE_CAP);
});

test("grace is bounded", () => {
  // A deliberate window of unpaid access. Unbounded grace is a free tier
  // nobody decided to offer.
  assert.ok(Number.isInteger(GRACE_PERIOD_DAYS));
  assert.ok(GRACE_PERIOD_DAYS > 0 && GRACE_PERIOD_DAYS <= 7);
});
