import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_SANDBOX_BINDING_CONTRACT_VERSION,
  RUN_SANDBOX_BINDING_REFUSAL_CODE,
  RUN_SANDBOX_BINDING_REFUSAL_REASONS,
  runErrorSchema,
  runSandboxBindingRefusalSchema,
  runSandboxBindingSchema,
  startRunInputSchema,
} from "./index";

const operationId = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
const binding = { expectedGeneration: 3, expectedSandboxId: "sandbox-abc_1.2" };

test("a start request without a binding parses exactly as before", () => {
  const parsed = startRunInputSchema.parse({ operationId, task: "Run it." });
  assert.deepEqual(parsed, { operationId, task: "Run it." });
  assert.equal(Object.hasOwn(parsed, "sandboxBinding"), false);
});

test("a start request may carry one strict sandbox binding", () => {
  assert.deepEqual(
    startRunInputSchema.parse({
      operationId,
      sandboxBinding: binding,
      task: "Run it.",
    }).sandboxBinding,
    binding
  );
  for (const sandboxBinding of [
    null,
    {},
    { expectedSandboxId: "sandbox" },
    { expectedGeneration: 1 },
    { ...binding, name: "by-name" },
    { ...binding, labels: { tenant: "other" } },
    { ...binding, expectedGeneration: -1 },
    { ...binding, expectedGeneration: 1.5 },
    { ...binding, expectedGeneration: "3" },
    { ...binding, expectedSandboxId: "" },
    { ...binding, expectedSandboxId: "../other" },
    { ...binding, expectedSandboxId: " padded" },
    { ...binding, expectedSandboxId: "x".repeat(129) },
  ]) {
    assert.equal(
      startRunInputSchema.safeParse({
        operationId,
        sandboxBinding,
        task: "Run it.",
      }).success,
      false,
      JSON.stringify(sandboxBinding)
    );
  }
  assert.equal(runSandboxBindingSchema.safeParse(binding).success, true);
});

test("a binding refusal is an ordinary non-retryable run error", () => {
  assert.equal(RUN_SANDBOX_BINDING_CONTRACT_VERSION, 1);
  for (const details of RUN_SANDBOX_BINDING_REFUSAL_REASONS) {
    const refusal = {
      code: RUN_SANDBOX_BINDING_REFUSAL_CODE,
      details,
      message: "The run's sandbox binding was refused.",
      retryable: false,
    };
    assert.deepEqual(runSandboxBindingRefusalSchema.parse(refusal), refusal);
    assert.deepEqual(runErrorSchema.parse(refusal), refusal);
  }
  for (const refusal of [
    { code: "dispatch_failed", details: "destroyed", retryable: false },
    { code: RUN_SANDBOX_BINDING_REFUSAL_CODE, details: "created" },
    {
      code: RUN_SANDBOX_BINDING_REFUSAL_CODE,
      details: "destroyed",
      retryable: true,
    },
  ]) {
    assert.equal(
      runSandboxBindingRefusalSchema.safeParse({
        message: "refused",
        retryable: false,
        ...refusal,
      }).success,
      false
    );
  }
});
