import assert from "node:assert/strict";
import test from "node:test";
import { periodStart } from "./period";

const UNTIL = new Date("2026-09-20T12:00:00.000Z");

test("the period runs back one month from the renewal date", () => {
  // Not the calendar month. A subscription starting on the 20th resets on the
  // 20th, which is what the customer's card statement will say.
  assert.equal(periodStart(UNTIL)?.toISOString(), "2026-08-20T12:00:00.000Z");
});

test("a renewal on the 31st steps back to a month that has one", () => {
  // 31 March back one month is not 31 February. Date arithmetic that lands on
  // an impossible day silently rolls forward, which would shorten the period
  // and undercount usage.
  const start = periodStart(new Date("2026-03-31T00:00:00.000Z"));

  assert.ok(start && start < new Date("2026-03-31T00:00:00.000Z"));
  assert.equal(start?.getUTCMonth(), 1, "February");
  assert.ok((start?.getUTCDate() ?? 99) <= 29);
});

test("a renewal on the 31st of a 31-day-preceded month keeps the day", () => {
  // December 31 back one month is November 30, not a rolled-forward December.
  const start = periodStart(new Date("2026-12-31T00:00:00.000Z"));

  assert.equal(start?.getUTCMonth(), 10, "November");
  assert.equal(start?.getUTCDate(), 30);
});

test("a leap-year February is respected", () => {
  const start = periodStart(new Date("2028-03-31T00:00:00.000Z"));

  assert.equal(start?.getUTCMonth(), 1, "February");
  assert.equal(start?.getUTCDate(), 29, "2028 is a leap year");
});

test("the period start is strictly before the renewal", () => {
  // Guards the whole idea: a start at or after the end would make every usage
  // query return nothing and the cap would never bind.
  for (const iso of [
    "2026-01-31T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z",
    "2026-12-31T23:59:59.000Z",
    "2027-02-28T00:00:00.000Z",
  ]) {
    const until = new Date(iso);
    const start = periodStart(until);

    assert.ok(start && start < until, `${iso} must yield an earlier start`);
  }
});

test("no subscription has no period", () => {
  assert.equal(periodStart(null), null);
});
