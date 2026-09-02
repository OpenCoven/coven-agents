import assert from "node:assert/strict";
import test from "node:test";
import { fillDays, utcDay, windowStart } from "./history";

test("a day with no runs is a zero, not an absence", () => {
  // The database returns only days that had a run. Charting that directly
  // draws a quiet week as a short dense series -- the shape would read as
  // steady use when the truth is that nothing happened.
  const filled = fillDays(
    [
      { day: "2026-08-20", minutes: 12, runs: 3 },
      { day: "2026-08-23", minutes: 4, runs: 1 },
    ],
    new Date("2026-08-20T00:00:00.000Z"),
    new Date("2026-08-24T00:00:00.000Z")
  );

  assert.deepEqual(filled, [
    { day: "2026-08-20", minutes: 12, runs: 3 },
    { day: "2026-08-21", minutes: 0, runs: 0 },
    { day: "2026-08-22", minutes: 0, runs: 0 },
    { day: "2026-08-23", minutes: 4, runs: 1 },
    { day: "2026-08-24", minutes: 0, runs: 0 },
  ]);
});

test("an empty tenant still gets a full window of zeroes", () => {
  const filled = fillDays(
    [],
    new Date("2026-08-24T00:00:00.000Z"),
    new Date("2026-08-26T00:00:00.000Z")
  );

  assert.equal(filled.length, 3);
  assert.ok(filled.every((entry) => entry.runs === 0 && entry.minutes === 0));
});

test("the window is inclusive of both ends", () => {
  // A seven-day window means seven columns. Counting the boundary once would
  // draw six and quietly drop the oldest day.
  const now = new Date("2026-08-25T18:30:00.000Z");
  const from = windowStart(now, 7);

  assert.equal(utcDay(from), "2026-08-19");
  assert.equal(fillDays([], from, now).length, 7);
});

test("the window starts at UTC midnight, not at the current time of day", () => {
  // Anchored to the instant instead, the oldest bucket would be a part-day and
  // would always look like a dip.
  const from = windowStart(new Date("2026-08-25T18:30:00.000Z"), 30);

  assert.equal(from.toISOString(), "2026-07-27T00:00:00.000Z");
});

test("a day is bucketed in UTC regardless of the server's zone", () => {
  // Bucketing locally would shift the whole series depending on where the
  // process happens to run.
  assert.equal(utcDay(new Date("2026-08-25T23:59:59.000Z")), "2026-08-25");
  assert.equal(utcDay(new Date("2026-08-26T00:00:01.000Z")), "2026-08-26");
});

test("a month boundary does not break the fill", () => {
  const filled = fillDays(
    [{ day: "2026-09-01", minutes: 9, runs: 2 }],
    new Date("2026-08-30T00:00:00.000Z"),
    new Date("2026-09-02T00:00:00.000Z")
  );

  assert.deepEqual(
    filled.map((entry) => entry.day),
    ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]
  );
  assert.equal(filled[2]?.runs, 2);
  assert.equal(filled[2]?.minutes, 9);
});
