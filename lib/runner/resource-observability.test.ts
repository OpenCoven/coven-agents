import assert from "node:assert/strict";
import test from "node:test";
import {
  observeRunnerResourceOperation,
  type RunnerResourceOperationObservation,
} from "./resource-observability";

test("resource operation observability permits only identifier-free categories", () => {
  const observations: RunnerResourceOperationObservation[] = [];
  observeRunnerResourceOperation(
    (observation) => {
      observations.push(observation);
    },
    { operation: "inventory", outcome: "deferred" }
  );
  observeRunnerResourceOperation(undefined, {
    operation: "delete",
    outcome: "deleted",
  });

  assert.deepEqual(observations, [
    { operation: "inventory", outcome: "deferred" },
  ]);
  assert.deepEqual(Object.keys(observations[0] ?? {}).sort(), [
    "operation",
    "outcome",
  ]);
});
