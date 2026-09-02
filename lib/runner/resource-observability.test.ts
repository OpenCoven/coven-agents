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

test("resource operation observability discards untyped provider data", () => {
  const observations: unknown[] = [];
  const privateIdentifier = "daytona-resource-observability-id";
  const providerMessage = "provider=manual-reconcile-service-bearer";
  const untypedObservation = {
    identifier: privateIdentifier,
    message: providerMessage,
    operation: "inventory" as const,
    outcome: "deferred" as const,
  };

  observeRunnerResourceOperation((observation) => {
    observations.push(observation);
  }, untypedObservation);

  const serialized = JSON.stringify(observations);
  assert.equal(serialized.includes(privateIdentifier), false);
  assert.equal(serialized.includes(providerMessage), false);
  assert.deepEqual(observations, [
    { operation: "inventory", outcome: "deferred" },
  ]);
});
