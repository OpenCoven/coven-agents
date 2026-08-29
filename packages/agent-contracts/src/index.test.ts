import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  AGENT_RUNNER_LIMITS,
  agentDefinitionSchema,
  agentOwnerSchema,
  agentRunnerHealthSchema,
  commandEvidenceSchema,
  compareAgentTimestamps,
  createAgentInputSchema,
  fileEvidenceSchema,
  runErrorEnvelopeSchema,
  runEventSchema,
  runEventsSchema,
  runResultSchema,
  runSnapshotEnvelopeSchema,
  runSnapshotSchema,
  runStatusSchema,
  startRunInputSchema,
  storedAgentDefinitionSchema,
} from "./index";

const contractFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../fixtures/agent-runner-v1.json", import.meta.url)),
    "utf8"
  )
) as {
  apiVersion: string;
  capabilities: string[];
  eventTypes: string[];
  limits: Record<string, number>;
  routes: Array<{ method: string; path: string }>;
  statuses: string[];
};

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

test("a stored definition using the retired runtime and no warm state still parses", () => {
  // Tightening a create-time rule must not strand an agent already written to
  // durable state, so the stored schema owns legacy compatibility.
  const result = storedAgentDefinitionSchema.safeParse({
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
  assert.deepEqual(result.success && result.data.warm, {
    status: "not_started",
    updatedAt: "2026-08-20T17:00:00.000Z",
  });
});

test("public agent definitions require warm state", () => {
  const result = agentDefinitionSchema.safeParse({
    backend: "cloud",
    createdAt: "2026-08-20T17:00:00.000Z",
    description: "",
    id: "11111111-2222-4333-8444-555555555555",
    instructions: "Current agent.",
    lastRunAt: null,
    model: "auto",
    name: "Current",
    owner: { kind: "tenant", tenantId: "acct_42" },
    runtime: "copilot",
    status: "idle",
    updatedAt: "2026-08-20T17:00:00.000Z",
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

test("publishes the full Agent Runner v1 route inventory", () => {
  assert.deepEqual(contractFixture.routes, [
    { method: "GET", path: "/api/health" },
    { method: "GET", path: "/api/agents" },
    { method: "POST", path: "/api/agents" },
    { method: "PUT", path: "/api/agents/:id" },
    { method: "GET", path: "/api/agents/:id" },
    { method: "DELETE", path: "/api/agents/:id" },
    { method: "POST", path: "/api/agents/:id/runs" },
    { method: "GET", path: "/api/runs/:id" },
    { method: "GET", path: "/api/runs/:id/events" },
    { method: "POST", path: "/api/runs/:id/stop" },
  ]);
});

test("keeps the exported contract values aligned with the fixture", async () => {
  const contract = (await import("./index.js")) as Record<string, unknown>;

  assert.equal(contractFixture.apiVersion, contract.AGENT_RUNNER_API_VERSION);
  assert.deepEqual(
    contractFixture.capabilities,
    contract.AGENT_RUNNER_CAPABILITIES
  );
  assert.deepEqual(
    contractFixture.eventTypes,
    contract.AGENT_RUNNER_EVENT_TYPES
  );
  assert.deepEqual(contractFixture.limits, contract.AGENT_RUNNER_LIMITS);
  assert.deepEqual(contractFixture.routes, contract.AGENT_RUNNER_ROUTES);
  assert.deepEqual(contractFixture.statuses, contract.AGENT_RUNNER_STATUSES);
});

test("defaults legacy stored agent definitions to standalone ownership", () => {
  const result = createAgentInputSchema.parse({
    backend: "cloud",
    instructions: "Run in the cloud.",
    model: "auto",
    name: "Standalone",
    runtime: "copilot",
  });

  // Create input carries no owner at all — the server assigns it — so the
  // default belongs to the definition schema, which is what has to keep
  // parsing records stored before ownership existed.
  assert.equal("owner" in result, false);
  assert.deepEqual(
    storedAgentDefinitionSchema.parse({
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

test("refuses a local agent, because nothing can execute one", () => {
  // The local runner is gone. Keeping `local` parseable would let a client
  // store a definition that no runner will ever pick up: the cloud worker
  // refused it even while the local runner existed, so it would fail at run
  // time instead of at creation, after the agent already appeared in the list.
  assert.equal(
    createAgentInputSchema.safeParse({
      backend: "local",
      instructions: "Run locally.",
      model: "auto",
      name: "Orphan",
      runtime: "copilot",
    }).success,
    false
  );
});

test("rejects unknown fields on agent definitions", () => {
  const result = agentDefinitionSchema.safeParse({
    backend: "cloud",
    createdAt: "2026-08-20T19:00:00.000Z",
    description: "Run in the cloud.",
    id: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    instructions: "Run in the cloud.",
    lastRunAt: null,
    model: "auto",
    name: "Strict",
    owner: { kind: "standalone" },
    runtime: "copilot",
    status: "idle",
    unexpected: true,
    updatedAt: "2026-08-20T19:00:00.000Z",
  });

  assert.equal(result.success, false);
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

test("orders equivalent timestamp formats by epoch value", () => {
  assert.equal(
    compareAgentTimestamps(
      "2026-08-20T19:00:00.000Z",
      "2026-08-20T19:00:00.00Z"
    ),
    0
  );
  assert.equal(
    commandEvidenceSchema.safeParse({
      command: "pnpm test",
      completedAt: "2026-08-20T19:00:00.000Z",
      exitCode: 0,
      startedAt: "2026-08-20T19:00:00.00Z",
      stderr: "",
      stdout: "ok",
    }).success,
    true
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

test("bounds command and file evidence arrays in snapshots and legacy results", () => {
  const expectedLimit = 256;
  assert.equal(AGENT_RUNNER_LIMITS.maxCommandResults, expectedLimit);
  assert.equal(AGENT_RUNNER_LIMITS.maxFileOperations, expectedLimit);

  const commandEvidence = {
    command: "pnpm test",
    exitCode: 0,
    stderr: "",
    stdout: "ok",
  };
  const fileEvidence = {
    operation: "modify",
    path: "src/index.ts",
  };
  const snapshot = (count: number) => ({
    agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    apiVersion: "1.0",
    commandEvidence: Array.from({ length: count }, () => commandEvidence),
    createdAt: "2026-08-20T19:00:00.000Z",
    fileEvidence: Array.from({ length: count }, () => fileEvidence),
    id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    operationId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    output: "",
    startedAt: null,
    status: "queued",
    task: "Run the tests.",
  });
  const result = (count: number) => ({
    agentId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    commandResults: Array.from({ length: count }, () => ({
      command: "pnpm test",
      exitCode: 0,
    })),
    completedAt: "2026-08-20T19:00:01.000Z",
    fileOperations: Array.from({ length: count }, () => ({
      operation: "modify",
      path: "src/index.ts",
    })),
    id: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
    output: "ok",
    startedAt: "2026-08-20T19:00:00.000Z",
    status: "completed",
  });

  for (const count of [20, expectedLimit]) {
    assert.equal(runSnapshotSchema.safeParse(snapshot(count)).success, true);
    assert.equal(runResultSchema.safeParse(result(count)).success, true);
  }
  assert.equal(
    runSnapshotSchema.safeParse(snapshot(expectedLimit + 1)).success,
    false
  );
  assert.equal(
    runResultSchema.safeParse(result(expectedLimit + 1)).success,
    false
  );
});

test("the owner union accepts every kind the worker resolves a tenant for", () => {
  // tenantOf switches exhaustively over these, so a kind that stops parsing
  // here would strand definitions the worker still has to authorise.
  const owners = [
    { kind: "standalone" },
    { kind: "tenant", tenantId: "acct_42" },
    {
      caveInstanceId: "cave_1",
      familiarId: "familiar_9",
      kind: "cave-familiar",
      sourceRevision: "abc123",
    },
  ];

  for (const owner of owners) {
    assert.equal(
      agentOwnerSchema.safeParse(owner).success,
      true,
      `${JSON.stringify(owner)} must parse`
    );
  }
  assert.equal(agentOwnerSchema.safeParse({ kind: "nope" }).success, false);
});

test("a client cannot name its own owner when creating an agent", () => {
  // Ownership is a claim the server makes about the caller. Accepting one from
  // the request would let a caller create an agent inside another tenant.
  const result = createAgentInputSchema.safeParse({
    backend: "cloud",
    description: "",
    instructions: "Do the thing.",
    model: "auto",
    name: "Impostor",
    owner: { kind: "tenant", tenantId: "someone_else" },
    runtime: "copilot",
  });

  assert.equal(result.success, false);
});
