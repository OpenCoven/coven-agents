import assert from "node:assert/strict";
import test from "node:test";
import { usageResponsePayload } from "./payload";

const RESETS_AT = new Date("2026-09-20T12:00:00.000Z");

test("usage returns tenant remaining budgets without global capacity numbers", () => {
  const payload = usageResponsePayload({
    globalAdmissionClosed: true,
    resetsAt: RESETS_AT,
    tenantDailyRemaining: 17,
    tenantMonthlyRemaining: 112,
  });

  assert.deepEqual(payload, {
    cap: 300,
    dailyRemaining: 17,
    globalAdmissionClosed: true,
    monthlyRemaining: 112,
    resetsAt: RESETS_AT.toISOString(),
    unit: "minutes",
    used: 188,
  });
  assert.doesNotMatch(
    JSON.stringify(payload),
    /globalDailyCap|globalRemaining|globalUsed/
  );
});
