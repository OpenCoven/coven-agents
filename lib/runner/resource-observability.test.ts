import assert from "node:assert/strict";
import test from "node:test";
import {
  observeRunnerResourceOperation,
  type RunnerResourceOperationObservation,
  runnerResourceProviderSignal,
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

test("a provider rejection reports a bounded status and error name", () => {
  const rejection = Object.assign(new Error("sandbox refused"), {
    name: "DaytonaBadRequestError",
    statusCode: 400,
  });

  assert.deepEqual(runnerResourceProviderSignal(rejection), {
    providerErrorName: "DaytonaBadRequestError",
    providerStatus: 400,
  });
});

test("provider signals never carry unbounded or non-numeric provider detail", () => {
  assert.deepEqual(runnerResourceProviderSignal("not an error"), {});
  assert.deepEqual(runnerResourceProviderSignal(new Error("plain")), {
    providerErrorName: "Error",
  });
  assert.deepEqual(
    runnerResourceProviderSignal(
      Object.assign(new Error("odd"), {
        name: "sandbox coven-agents-tenant-42 refused",
        statusCode: "400",
      })
    ),
    {}
  );
});

test("observations forward only the finite provider signal", () => {
  const observed: unknown[] = [];

  observeRunnerResourceOperation((observation) => observed.push(observation), {
    operation: "create",
    outcome: "provider_rejected",
    ...runnerResourceProviderSignal(
      Object.assign(new Error("refused"), {
        name: "DaytonaUnprocessableEntityError",
        statusCode: 422,
      })
    ),
  });

  assert.deepEqual(observed, [
    {
      operation: "create",
      outcome: "provider_rejected",
      providerErrorName: "DaytonaUnprocessableEntityError",
      providerStatus: 422,
    },
  ]);
});
