import assert from "node:assert/strict";
import test from "node:test";
import { DEMO_SPEED, MAX_GAP_MS, planPlayback } from "./player";

const EVENT = { id: 1, status: "running", type: "status" } as const;
const PROVENANCE = {
  fixture: "demo-replay",
  kind: "synthetic-demo",
} as const;

function entries(...offsets: number[]) {
  return offsets.map((offsetMs) => ({
    event: EVENT,
    offsetMs,
    provenance: PROVENANCE,
  }));
}

test("delays are the gaps between offsets, not the offsets", () => {
  const plan = planPlayback(entries(0, 500, 900));

  assert.deepEqual(
    plan.map((step) => step.delayMs),
    [0, 500, 400]
  );
  assert.deepEqual(
    plan.map((step) => step.event),
    [EVENT, EVENT, EVENT]
  );
});

test("a long pause is capped", () => {
  // A real run waits minutes while a harness thinks. Replaying that faithfully
  // means a visitor staring at a spinner.
  const plan = planPlayback(entries(0, 120_000));

  assert.equal(plan[1]?.delayMs, MAX_GAP_MS);
});

test("relative rhythm survives capping", () => {
  // A tool call that took noticeably longer than its neighbours should still
  // look that way. That texture is what makes a replay read as real work.
  const plan = planPlayback(entries(0, 100, 900));

  assert.ok((plan[2]?.delayMs ?? 0) > (plan[1]?.delayMs ?? 0));
});

test("speed scales every delay together", () => {
  const plan = planPlayback(entries(0, 400), { speed: 2 });

  assert.equal(plan[1]?.delayMs, 200);
});

test("a speed of zero or less is refused rather than freezing the demo", () => {
  for (const speed of [0, -1, Number.NaN]) {
    assert.throws(() => planPlayback(entries(0, 400), { speed }), /speed/i);
  }
});

test("the default speed is unmodified playback", () => {
  assert.equal(DEMO_SPEED, 1);
});
