import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@opencoven/agent-contracts";
import { buildInvocation, resolveWorkspace } from "./runtime.js";

const agent: AgentDefinition = {
  backend: "local",
  createdAt: "2026-08-20T12:00:00.000Z",
  description: "Code familiar",
  id: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
  instructions: "Implement with evidence.",
  lastRunAt: null,
  model: "auto",
  name: "Cody",
  owner: { kind: "standalone" },
  runtime: "copilot",
  status: "idle",
  updatedAt: "2026-08-20T12:00:00.000Z",
  workspace: "project",
};

test("builds an explicit no-approval Copilot invocation", () => {
  const invocation = buildInvocation(agent, "Fix the tests.", "/work");

  assert.equal(invocation.command, "copilot");
  assert.equal(invocation.args.includes("--yolo"), true);
  assert.equal(invocation.args.includes("--no-ask-user"), true);
  assert.equal(invocation.cwd, "/work/project");
});

test("rejects workspaces outside the configured root", () => {
  assert.throws(
    () => resolveWorkspace("/work/projects", "../secrets"),
    /must stay inside/
  );
});
