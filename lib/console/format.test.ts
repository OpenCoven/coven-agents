import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAge,
  formatDuration,
  formatOffset,
  glyphFor,
  spanBetween,
  splitPath,
} from "./format";

test("a sub-minute span keeps one decimal", () => {
  assert.equal(formatDuration(2400), "2.4s");
  assert.equal(formatDuration(900), "0.9s");
  assert.equal(formatDuration(41_200), "41.2s");
});

test("a span past a minute zero-pads its seconds", () => {
  // Zero padding is what keeps the column from shifting while it counts, which
  // is the whole reason a running clock is readable at a glance.
  assert.equal(formatDuration(68_000), "1m 08s");
  assert.equal(formatDuration(144_000), "2m 24s");
});

test("an hour-long run reports hours and minutes", () => {
  assert.equal(formatDuration(3_900_000), "1h 05m");
});

test("a nonsensical span is an em dash rather than a number", () => {
  // The console must never print a plausible figure the receipt cannot
  // support; a negative or non-finite span means the runner reported no
  // usable timestamps.
  assert.equal(formatDuration(-1), "—");
  assert.equal(formatDuration(Number.NaN), "—");
});

test("a span needs both ends", () => {
  assert.equal(spanBetween(null, "2026-08-25T00:00:00.000Z"), null);
  assert.equal(spanBetween("2026-08-25T00:00:00.000Z", undefined), null);
  assert.equal(
    spanBetween("2026-08-25T00:00:00.000Z", "2026-08-25T00:00:02.000Z"),
    2000
  );
});

test("a span that runs backwards is refused", () => {
  // A completion before its start is a clock disagreement, not a negative
  // duration to render.
  assert.equal(
    spanBetween("2026-08-25T00:00:05.000Z", "2026-08-25T00:00:00.000Z"),
    null
  );
});

test("age is coarse and reads in words", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  assert.equal(formatAge("2026-08-25T11:59:50.000Z", now), "just now");
  assert.equal(formatAge("2026-08-25T11:56:00.000Z", now), "4m ago");
  assert.equal(formatAge("2026-08-25T09:00:00.000Z", now), "3h ago");
  assert.equal(formatAge("2026-08-22T12:00:00.000Z", now), "3d ago");
});

test("an agent that has never run says so", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");
  assert.equal(formatAge(null, now), "never run");
  assert.equal(formatAge("not a date", now), "never run");
});

test("without a clock, age is an em dash rather than a guess", () => {
  // Zero means the browser has not supplied one yet. Falling back to
  // `Date.now()` inside a render is what a prerender bakes into the static
  // output, so every visitor would measure against the build.
  assert.equal(formatAge("2026-08-25T11:00:00.000Z", 0), "—");
});

test("a glyph is the first letter or number of the name", () => {
  assert.equal(glyphFor("Builder"), "B");
  assert.equal(glyphFor("  scout"), "S");
  assert.equal(glyphFor("2nd critic"), "2");
});

test("a name with no letters still gets a well", () => {
  // An empty well reads as a hole in the rail rather than as an agent.
  assert.equal(glyphFor("···"), "◆");
  assert.equal(glyphFor(""), "◆");
});

test("a path splits into a dimmable directory and a leaf", () => {
  assert.deepEqual(splitPath("lib/session-claims.test.ts"), {
    dir: "lib/",
    leaf: "session-claims.test.ts",
  });
  assert.deepEqual(splitPath("README.md"), { dir: "", leaf: "README.md" });
});

test("an offset stamps the tape as +m:ss and zero-pads its seconds", () => {
  assert.equal(formatOffset(0), "+0:00");
  assert.equal(formatOffset(4900), "+0:04");
  assert.equal(formatOffset(68_000), "+1:08");
  assert.equal(formatOffset(3_725_000), "+1:02:05");
  assert.equal(formatOffset(-1), "—");
});
