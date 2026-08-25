import assert from "node:assert/strict";
import test from "node:test";
import { GRACE_PERIOD_DAYS, MONTHLY_RUN_CAP } from "./limits";

test("the cap is a positive whole number of runs", () => {
  // Quoted to the user in three places. A fractional or zero cap would be
  // shown verbatim on a pricing page.
  assert.ok(Number.isInteger(MONTHLY_RUN_CAP));
  assert.ok(MONTHLY_RUN_CAP > 0);
});

test("the cap is the agreed 750", () => {
  // Pinned deliberately. The number is a commercial commitment, not an
  // implementation detail, so changing it should require changing a test that
  // says so out loud.
  assert.equal(MONTHLY_RUN_CAP, 750);
});

test("grace is bounded", () => {
  // A deliberate window of unpaid access. Unbounded grace is a free tier
  // nobody decided to offer.
  assert.ok(Number.isInteger(GRACE_PERIOD_DAYS));
  assert.ok(GRACE_PERIOD_DAYS > 0 && GRACE_PERIOD_DAYS <= 7);
});
