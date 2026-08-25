import assert from "node:assert/strict";
import test from "node:test";
import type { RunEvent } from "@opencoven/agent-contracts";
import { toOffsets } from "./offsets";

const event: RunEvent = {
  id: 1,
  status: "running",
  type: "status",
};

test("derives offsets from arrival time", () => {
  const result = toOffsets([
    { event, receivedAt: 1000 },
    { event, receivedAt: 3500 },
    { event, receivedAt: 4000 },
  ]);

  assert.deepEqual(
    result.map(({ offsetMs }) => offsetMs),
    [0, 2500, 3000]
  );
});

test("returns no offsets for no arrivals", () => {
  assert.deepEqual(toOffsets([]), []);
});

test("clamps out-of-order arrivals to monotonic offsets", () => {
  const result = toOffsets([
    { event, receivedAt: 5000 },
    { event, receivedAt: 10_000 },
    { event, receivedAt: 3000 },
  ]);
  const offsets = result.map(({ offsetMs }) => offsetMs);

  assert.deepEqual(offsets, [0, 5000, 5000]);
  assert.ok(offsets[1] >= offsets[0]);
  assert.ok(offsets[2] >= offsets[1]);
});

test("rounds fractional arrival times to integer offsets", () => {
  const result = toOffsets([
    { event, receivedAt: 10.7 },
    { event, receivedAt: 12.2 },
  ]);

  assert.deepEqual(
    result.map(({ offsetMs }) => offsetMs),
    [0, 2]
  );
  assert.ok(Number.isInteger(result[1].offsetMs));
});
