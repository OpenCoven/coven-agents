import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_STATUSES, WAVES } from "./beads-project-model";
import {
  type RoadmapProjectItem,
  roadmapSummarySchema,
  sameRoadmapSummary,
  summarizeRoadmap,
} from "./roadmap-status-model";

function item(
  beadId: string,
  overrides: Partial<RoadmapProjectItem> = {}
): RoadmapProjectItem {
  return {
    beadId,
    blocked: "No",
    status: "Todo",
    wave: "1 - Now",
    ...overrides,
  };
}

test("summarizes status, wave, and blocked counts deterministically", () => {
  const items = [
    item("coven-agents-product.1", {
      blocked: "Yes",
      status: "In Progress",
      wave: "1 - Now",
    }),
    item("coven-agents-product.2", {
      status: "Done",
      wave: "0 - Delivered",
    }),
    item("coven-agents-product.3", {
      blocked: "Yes",
      status: "In review",
      wave: "1 - Now",
    }),
    item("coven-agents-product.4", {
      status: "Todo",
      wave: "4 - Platform",
    }),
  ] satisfies RoadmapProjectItem[];

  const summary = summarizeRoadmap(items, items.length);
  const reversedSummary = summarizeRoadmap([...items].reverse(), items.length);

  assert.deepEqual(summary, reversedSummary);
  assert.deepEqual(Object.keys(summary.byStatus), [...PROJECT_STATUSES]);
  assert.deepEqual(Object.keys(summary.byWave), [...WAVES]);
  assert.deepEqual(summary.byStatus, {
    Done: 1,
    "In Progress": 1,
    "In review": 1,
    Todo: 1,
  });
  assert.equal(summary.blocked, 2);
  assert.equal(summary.total, 4);
  assert.deepEqual(summary.byWave["1 - Now"], {
    blocked: 2,
    byStatus: {
      Done: 0,
      "In Progress": 1,
      "In review": 1,
      Todo: 0,
    },
    total: 2,
  });
  assert.deepEqual(summary.byWave["4 - Platform"], {
    blocked: 0,
    byStatus: {
      Done: 0,
      "In Progress": 0,
      "In review": 0,
      Todo: 1,
    },
    total: 1,
  });
});

test("rejects duplicate bead IDs", () => {
  assert.throws(
    () =>
      summarizeRoadmap(
        [
          item("coven-agents-product.1"),
          item("coven-agents-product.1", { status: "Done" }),
        ],
        2
      ),
    /duplicate roadmap bead ID: coven-agents-product\.1/i
  );
});

test("rejects an unexpected item count", () => {
  assert.throws(
    () => summarizeRoadmap([item("coven-agents-product.1")]),
    /expected 60 roadmap items, received 1/i
  );
});

test("rejects an invalid bead ID", () => {
  assert.throws(
    () => summarizeRoadmap([item("invalid-id")], 1),
    /invalid roadmap bead ID: invalid-id/i
  );
});

test("retains zero-valued status and wave buckets", () => {
  const summary = summarizeRoadmap(
    [item("coven-agents-product.1", { status: "Done" })],
    1
  );

  assert.deepEqual(summary.byStatus, {
    Done: 1,
    "In Progress": 0,
    "In review": 0,
    Todo: 0,
  });
  assert.deepEqual(Object.keys(summary.byWave), [...WAVES]);

  for (const wave of WAVES) {
    if (wave === "1 - Now") {
      continue;
    }

    assert.deepEqual(summary.byWave[wave], {
      blocked: 0,
      byStatus: {
        Done: 0,
        "In Progress": 0,
        "In review": 0,
        Todo: 0,
      },
      total: 0,
    });
  }
});

test("compares summaries structurally", () => {
  const left = summarizeRoadmap([item("coven-agents-product.1")], 1);
  const equal = structuredClone(left);
  const different = structuredClone(left);
  different.byWave["1 - Now"].blocked = 1;
  different.blocked = 1;

  assert.equal(sameRoadmapSummary(left, equal), true);
  assert.equal(sameRoadmapSummary(left, different), false);
});

test("exports a strict roadmap summary schema", () => {
  const summary = summarizeRoadmap([item("coven-agents-product.1")], 1);

  assert.throws(() =>
    roadmapSummarySchema.parse({
      ...summary,
      unexpected: true,
    })
  );
});
