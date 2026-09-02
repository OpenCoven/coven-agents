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
  CANONICAL_UUID_PATTERN,
  canonicalUuidSchema,
  commandEvidenceSchema,
  compareAgentTimestamps,
  createAgentInputSchema,
  currentAgentDefinitionSchema,
  fileEvidenceSchema,
  githubToolRequestSchema,
  isCanonicalUuid,
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

test("accepts the v1 cloud deployment class with a harness runtime", () => {
  const result = createAgentInputSchema.safeParse({
    backend: "cloud",
    description: "Ships code in an isolated sandbox.",
    instructions: "Inspect, implement, and verify.",
    model: "auto",
    name: "Cody",
    runtime: "copilot",
  });

  assert.equal(result.success, true);
});

test("definition schemas accept only the supported runtime set", () => {
  const definition = {
    backend: "cloud",
    createdAt: "2026-08-20T17:00:00.000Z",
    description: "",
    id: "11111111-2222-4333-8444-555555555555",
    instructions: "Current agent.",
    lastRunAt: null,
    model: "auto",
    name: "Current",
    owner: { kind: "standalone" as const },
    runtime: "copilot" as const,
    status: "idle",
    updatedAt: "2026-08-20T17:00:00.000Z",
    warm: {
      status: "not_started" as const,
      updatedAt: "2026-08-20T17:00:00.000Z",
    },
  };

  for (const schema of [
    agentDefinitionSchema,
    currentAgentDefinitionSchema,
    storedAgentDefinitionSchema,
  ]) {
    assert.equal(schema.safeParse(definition).success, true);
    assert.equal(
      schema.safeParse({ ...definition, runtime: "unsupported" }).success,
      false
    );
  }
});

test("public agent definitions require explicit ownership", () => {
  const result = agentDefinitionSchema.safeParse({
    backend: "cloud",
    createdAt: "2026-08-20T17:00:00.000Z",
    description: "",
    id: "11111111-2222-4333-8444-555555555555",
    instructions: "Current agent.",
    lastRunAt: null,
    model: "auto",
    name: "Current",
    runtime: "copilot",
    status: "idle",
    updatedAt: "2026-08-20T17:00:00.000Z",
    warm: {
      status: "not_started",
      updatedAt: "2026-08-20T17:00:00.000Z",
    },
  });

  assert.equal(result.success, false);
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

test("GitHub operation IDs require canonical lowercase hyphenated UUIDs", () => {
  const operation = {
    issueNumber: "42",
    kind: "issue.get",
    owner: "OpenCoven",
    repo: "coven-agents",
  };
  const canonical = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
  assert.equal(
    githubToolRequestSchema.safeParse({
      operation,
      operationId: canonical,
    }).success,
    true
  );
  assert.equal(canonicalUuidSchema.safeParse(canonical).success, true);
  assert.equal(isCanonicalUuid(canonical), true);
  assert.equal(CANONICAL_UUID_PATTERN.test(canonical), true);
  for (const operationId of [
    canonical.toUpperCase(),
    canonical.replaceAll("-", ""),
    `{${canonical}}`,
    "53af1a29-4e98-63d6-ac5b-3b9dcba5e730",
    "53af1a29-4e98-43d6-7c5b-3b9dcba5e730",
    "00000000-0000-0000-0000-000000000000",
  ]) {
    assert.equal(
      githubToolRequestSchema.safeParse({ operation, operationId }).success,
      false,
      operationId
    );
    assert.equal(canonicalUuidSchema.safeParse(operationId).success, false);
    assert.equal(isCanonicalUuid(operationId), false);
  }
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

test("normalizes missing owner and warm on stored definitions", () => {
  const result = createAgentInputSchema.parse({
    backend: "cloud",
    instructions: "Run in Daytona.",
    model: "auto",
    name: "Standalone",
    runtime: "copilot",
  });

  assert.equal("owner" in result, false);
  const stored = storedAgentDefinitionSchema.parse({
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
  });

  assert.deepEqual(stored.owner, { kind: "standalone" });
  assert.deepEqual(stored.warm, {
    status: "not_started",
    updatedAt: "2026-08-20T19:00:00.000Z",
  });
});

test("agent workspaces cannot escape the sandbox workspace root", () => {
  for (const workspace of ["../../etc", "/etc", "/workspace/../etc"]) {
    assert.equal(
      createAgentInputSchema.safeParse({
        backend: "cloud",
        instructions: "Run in Daytona.",
        model: "auto",
        name: "Escaping workspace",
        runtime: "copilot",
        workspace,
      }).success,
      false,
      workspace
    );
  }
  assert.equal(
    createAgentInputSchema.safeParse({
      backend: "cloud",
      instructions: "Run in Daytona.",
      model: "auto",
      name: "Bounded workspace",
      runtime: "copilot",
      workspace: "repo/../project",
    }).success,
    true
  );
});

test("refuses non-v1 deployment-class backend values", () => {
  for (const backend of ["daytona", "unsupported"]) {
    assert.equal(
      createAgentInputSchema.safeParse({
        backend,
        instructions: "Run the task.",
        model: "auto",
        name: "Orphan",
        runtime: "copilot",
      }).success,
      false
    );
  }
});

test("rejects unknown fields on agent definitions", () => {
  const result = agentDefinitionSchema.safeParse({
    backend: "cloud",
    createdAt: "2026-08-20T19:00:00.000Z",
    description: "Run in Daytona.",
    id: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
    instructions: "Run in Daytona.",
    lastRunAt: null,
    model: "auto",
    name: "Strict",
    owner: { kind: "standalone" },
    runtime: "copilot",
    status: "idle",
    unexpected: true,
    updatedAt: "2026-08-20T19:00:00.000Z",
    warm: {
      status: "not_started",
      updatedAt: "2026-08-20T19:00:00.000Z",
    },
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
      mode: "cloud",
    }).success,
    true
  );
  assert.equal(
    agentRunnerHealthSchema.safeParse({
      apiVersion: "0.9",
      capabilities: [],
      minimumClientVersion: "1.0.0",
      mode: "cloud",
    }).success,
    false
  );
  assert.equal(
    agentRunnerHealthSchema.safeParse({
      apiVersion: "1.0",
      capabilities: [...AGENT_RUNNER_CAPABILITIES],
      minimumClientVersion: "1.0.0",
      mode: "daytona",
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

test("the owner union accepts every server-supported ownership kind", () => {
  // Ownership projection switches exhaustively over these, so a kind that
  // stops parsing here would strand existing definitions.
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
