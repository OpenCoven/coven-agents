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

test("a provider rejection reports the provider's own wire fields", () => {
  const rejection = Object.assign(new Error("sandbox refused"), {
    code: "SANDBOX_RESOURCES_NOT_ALLOWED",
    source: "DAYTONA_API",
    statusCode: 400,
  });

  assert.deepEqual(runnerResourceProviderSignal(rejection), {
    providerCode: "SANDBOX_RESOURCES_NOT_ALLOWED",
    providerSource: "DAYTONA_API",
    providerStatus: 400,
  });
});

test("provider signals survive the minification that renames error classes", () => {
  // A production build renames the SDK's error classes, so the class name is
  // "e" or similar exactly when the diagnostic is needed; the wire fields are
  // values the server sent and are unaffected.
  const minified = Object.assign(new Error("refused"), {
    code: "SANDBOX_INVALID_REQUEST",
    statusCode: 422,
  });
  minified.name = "e";

  assert.deepEqual(runnerResourceProviderSignal(minified), {
    providerCode: "SANDBOX_INVALID_REQUEST",
    providerStatus: 422,
  });
});

test("provider signals never carry unbounded or non-numeric provider detail", () => {
  assert.deepEqual(runnerResourceProviderSignal("not an error"), {});
  assert.deepEqual(runnerResourceProviderSignal(new Error("plain")), {});
  assert.deepEqual(
    runnerResourceProviderSignal(
      Object.assign(new Error("odd"), {
        code: "sandbox coven-agents-tenant-42 refused",
        source: 12,
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
        code: "SANDBOX_RESOURCES_NOT_ALLOWED",
        message: "sandbox coven-agents-tenant-42 was refused",
        source: "DAYTONA_API",
        statusCode: 422,
      })
    ),
  });

  assert.deepEqual(observed, [
    {
      operation: "create",
      outcome: "provider_rejected",
      providerCode: "SANDBOX_RESOURCES_NOT_ALLOWED",
      providerSource: "DAYTONA_API",
      providerStatus: 422,
    },
  ]);
});

test("provider signals reject identifiers dressed as codes", () => {
  // A hyphenated token is a name, not a machine-readable code, and this
  // module promises to carry no identifiers at all.
  assert.deepEqual(
    runnerResourceProviderSignal(
      Object.assign(new Error("refused"), {
        code: "coven-agents-tenant-42",
        source: "coven-agents-tenant-42",
        statusCode: 400,
      })
    ),
    { providerStatus: 400 }
  );
  assert.deepEqual(
    runnerResourceProviderSignal(
      Object.assign(new Error("refused"), { source: "SOMEWHERE_ELSE" })
    ),
    {}
  );
});
