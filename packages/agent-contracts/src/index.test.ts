import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDefinitionSchema,
  createAgentInputSchema,
  runAgentInputSchema,
} from "./index.js";

test("accepts a cloud agent that selects a harness runtime", () => {
  const result = createAgentInputSchema.safeParse({
    backend: "cloud",
    description: "Ships code in an isolated sandbox.",
    instructions: "Inspect, implement, and verify.",
    model: "auto",
    name: "Cody Cloud",
    runtime: "copilot",
  });

  assert.equal(result.success, true);
});

test("rejects the retired provider-key cloud runtime on either backend", () => {
  for (const backend of ["cloud", "local"] as const) {
    const result = createAgentInputSchema.safeParse({
      backend,
      description: "",
      instructions: "Run something.",
      model: "auto",
      name: "Invalid",
      runtime: "cloud",
    });
    assert.equal(result.success, false, `${backend} must reject cloud runtime`);
  }
});

test("a stored definition using the retired runtime still parses", () => {
  // Tightening a create-time rule must not strand an agent already written to
  // durable state, so the definition schema does not inherit the refinement.
  const result = agentDefinitionSchema.safeParse({
    backend: "cloud",
    createdAt: "2026-08-20T17:00:00.000Z",
    description: "",
    id: "11111111-2222-4333-8444-555555555555",
    instructions: "Legacy agent.",
    lastRunAt: null,
    model: "gpt-5.1",
    name: "Legacy",
    runtime: "cloud",
    status: "idle",
    updatedAt: "2026-08-20T17:00:00.000Z",
  });

  assert.equal(result.success, true);
});

test("rejects empty tasks", () => {
  assert.equal(runAgentInputSchema.safeParse({ task: "   " }).success, false);
});
