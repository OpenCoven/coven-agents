import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  agentDefinitionSchema,
  agentOwnerSchema,
  agentRunnerHealthSchema,
  commandEvidenceSchema,
  createAgentInputSchema,
  fileEvidenceSchema,
  runErrorEnvelopeSchema,
  runEventSchema,
  runEventsSchema,
  runSnapshotEnvelopeSchema,
  runSnapshotSchema,
  runStatusSchema,
  startRunInputSchema,
} from "./index.js";

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
  assert.equal(
    startRunInputSchema.safeParse({
      operationId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
      task: "   ",
    }).success,
    false
  );
  assert.equal(
    startRunInputSchema.safeParse({ task: "Run the tests." }).success,
    false
  );
});

test("publishes the version and exact runner capabilities", () => {
  assert.equal(AGENT_RUNNER_API_VERSION, "1.0");
  assert.deepEqual(
    [...AGENT_RUNNER_CAPABILITIES],
    [
      "agent-profiles",
      "async-runs",
      "idempotent-runs",
      "run-events",
      "run-cancel",
      "command-evidence",
      "file-evidence",
    ]
  );
});

test("defaults new and legacy agent definitions to standalone ownership", () => {
  const result = createAgentInputSchema.parse({
    backend: "local",
    instructions: "Run locally.",
    model: "auto",
    name: "Standalone",
    runtime: "copilot",
  });

  assert.deepEqual(result.owner, { kind: "standalone" });
  assert.deepEqual(
    agentDefinitionSchema.parse({
      backend: result.backend,
      createdAt: "2026-08-20T19:00:00.000Z",
      description: result.description,
      id: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
      instructions: result.instructions,
      lastRunAt: null,
      model: result.model,
      name: result.name,
      runtime: result.runtime,
      status: "idle",
      updatedAt: "2026-08-20T19:00:00.000Z",
      workspace: result.workspace,
    }).owner,
    { kind: "standalone" }
  );
});

test("requires a source revision for cave-managed profiles", () => {
  const caveOwner = {
    caveInstanceId: "cave-123",
    familiarId: "familiar-123",
    kind: "cave-familiar",
    sourceRevision: " ",
  };

  assert.equal(agentOwnerSchema.safeParse(caveOwner).success, false);
  assert.equal(
    agentOwnerSchema.safeParse({
      ...caveOwner,
      sourceRevision: "rev-2026-08-20",
    }).success,
    true
  );
});

test("validates the versioned health response", () => {
  assert.equal(
    agentRunnerHealthSchema.safeParse({
      apiVersion: "1.0",
      capabilities: [...AGENT_RUNNER_CAPABILITIES],
      minimumClientVersion: "1.0.0",
      mode: "local",
    }).success,
    true
  );
  assert.equal(
    agentRunnerHealthSchema.safeParse({
      apiVersion: "0.9",
      capabilities: [],
      minimumClientVersion: "1.0.0",
      mode: "local",
    }).success,
    false
  );
});

test("accepts strict command and file evidence", () => {
  assert.equal(
    commandEvidenceSchema.safeParse({
      command: "pnpm test",
      completedAt: "2026-08-20T19:00:01.000Z",
      exitCode: 0,
      startedAt: "2026-08-20T19:00:00.000Z",
      stderr: "",
      stdout: "ok",
    }).success,
    true
  );
  assert.equal(
    commandEvidenceSchema.safeParse({
      command: "pnpm test",
      exitCode: 0,
      stderr: "",
      stdout: "ok",
      unexpected: true,
    }).success,
    false
  );
  assert.equal(
    fileEvidenceSchema.safeParse({
      byteLength: 12,
      occurredAt: "2026-08-20T19:00:00.000Z",
      operation: "modify",
      path: "src/index.ts",
    }).success,
    true
  );
  assert.equal(
    fileEvidenceSchema.safeParse({
      byteLength: -1,
      operation: "delete",
      path: "src/index.ts",
    }).success,
    false
  );
});

test("validates ordered run events and snapshots", () => {
  const accepted = {
    at: "2026-08-20T19:00:00.000Z",
    id: 1,
    operationId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    runId: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    type: "accepted",
  };
  const status = {
    at: "2026-08-20T19:00:01.000Z",
    id: 2,
    status: "running",
    type: "status",
  };

  assert.equal(runEventSchema.safeParse(accepted).success, true);
  assert.equal(runEventSchema.safeParse(status).success, true);
  assert.equal(
    runEventSchema.safeParse({
      at: "2026-08-20T19:00:02.000Z",
      id: 3,
      output: "Working.",
      type: "output",
    }).success,
    true
  );
  assert.equal(
    runEventSchema.safeParse({
      at: "2026-08-20T19:00:03.000Z",
      evidence: {
        command: "pnpm test",
        exitCode: 0,
        stderr: "",
        stdout: "ok",
      },
      id: 4,
      type: "command",
    }).success,
    true
  );
  assert.equal(
    runEventSchema.safeParse({
      at: "2026-08-20T19:00:04.000Z",
      evidence: {
        operation: "modify",
        path: "src/index.ts",
      },
      id: 5,
      type: "file",
    }).success,
    true
  );
  assert.equal(runEventsSchema.safeParse([accepted, status]).success, true);
  assert.equal(runEventsSchema.safeParse([status, accepted]).success, false);

  const snapshot = {
    agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    apiVersion: "1.0",
    commandEvidence: [],
    createdAt: "2026-08-20T19:00:00.000Z",
    fileEvidence: [],
    id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    operationId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    output: "",
    startedAt: null,
    status: "queued",
    task: "Run the tests.",
  };
  assert.equal(runStatusSchema.safeParse("cancelled").success, true);
  assert.equal(runSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(
    runEventSchema.safeParse({
      at: "2026-08-20T19:00:05.000Z",
      id: 6,
      run: snapshot,
      type: "completed",
    }).success,
    true
  );
  assert.equal(
    runEventSchema.safeParse({
      at: "2026-08-20T19:00:06.000Z",
      error: {
        code: "runner_failed",
        message: "The runner failed.",
        retryable: true,
      },
      id: 7,
      type: "failed",
    }).success,
    true
  );
  assert.equal(
    runSnapshotEnvelopeSchema.safeParse({ apiVersion: "1.0", run: snapshot })
      .success,
    true
  );
});

test("uses a stable bounded versioned error envelope", () => {
  assert.equal(
    runErrorEnvelopeSchema.safeParse({
      apiVersion: "1.0",
      error: {
        code: "run_not_found",
        details: "The requested run does not exist.",
        message: "Run was not found.",
        retryable: false,
      },
      requestId: "request-123",
    }).success,
    true
  );
  assert.equal(
    runErrorEnvelopeSchema.safeParse({
      apiVersion: "1.0",
      error: {
        code: "bad",
        message: "bad",
        retryable: false,
        unexpected: true,
      },
      requestId: "request-123",
    }).success,
    false
  );
});
