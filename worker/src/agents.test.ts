import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@opencoven/agent-contracts";
import {
  createQueuedRun,
  safeRunText,
  validateCloudWorkspace,
} from "./run-state.js";

const agent: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-20T20:00:00.000Z",
  description: "Cloud test profile",
  id: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
  instructions: "Work in the sandbox.",
  lastRunAt: null,
  model: "gpt-5.1",
  name: "Cloud runner",
  owner: {
    caveInstanceId: "cave-1",
    familiarId: "familiar-1",
    kind: "cave-familiar",
    sourceRevision: "revision-1",
  },
  runtime: "cloud",
  status: "idle",
  updatedAt: "2026-08-20T20:00:00.000Z",
  workspace: "/workspace",
};

test("rejects host and Git workspaces for Cave-managed cloud profiles", () => {
  assert.equal(validateCloudWorkspace(agent), "/workspace");
  assert.throws(
    () =>
      validateCloudWorkspace({ ...agent, workspace: "/Users/operator/code" }),
    /scratch sandbox/
  );
  assert.throws(
    () =>
      validateCloudWorkspace({
        ...agent,
        workspace: "git@github.com:org/repo.git",
      }),
    /scratch sandbox/
  );
});

test("creates an accepted queued cloud run with its first event", () => {
  const run = createQueuedRun(
    agent.id,
    "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    "Inspect the sandbox.",
    "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    "2026-08-20T20:01:00.000Z"
  );

  assert.equal(run.run.status, "queued");
  assert.deepEqual(run.events, [
    {
      at: "2026-08-20T20:01:00.000Z",
      id: 1,
      operationId: "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
      runId: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
      type: "accepted",
    },
  ]);
});

test("redacts bearer credentials and environment dumps from cloud evidence", () => {
  assert.equal(
    safeRunText("authorization: Bearer cloud-secret"),
    "authorization: Bearer [REDACTED]"
  );
  assert.equal(
    safeRunText("PATH=/bin\nHOME=/root\nOPENAI_API_KEY=secret"),
    "[environment output redacted]"
  );
});
