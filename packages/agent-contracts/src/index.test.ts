import assert from "node:assert/strict";
import test from "node:test";
import { createAgentInputSchema, runAgentInputSchema } from "./index.js";

test("accepts an isolated cloud agent", () => {
  const result = createAgentInputSchema.safeParse({
    backend: "cloud",
    description: "Ships code in an isolated sandbox.",
    instructions: "Inspect, implement, and verify.",
    model: "gpt-5.1",
    name: "Cody Cloud",
    runtime: "cloud",
  });

  assert.equal(result.success, true);
});

test("rejects a cloud runtime on a local backend", () => {
  const result = createAgentInputSchema.safeParse({
    backend: "local",
    description: "",
    instructions: "Run locally.",
    model: "auto",
    name: "Invalid",
    runtime: "cloud",
  });

  assert.equal(result.success, false);
});

test("rejects empty tasks", () => {
  assert.equal(runAgentInputSchema.safeParse({ task: "   " }).success, false);
});
