import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNNER_API_VERSION,
  type AgentDefinition,
  agentEnvelopeSchema,
  agentRunnerHealthSchema,
  agentsEnvelopeSchema,
  okEnvelopeSchema,
  type RunSnapshot,
  runErrorEnvelopeSchema,
  runListEnvelopeSchema,
  runSnapshotEnvelopeSchema,
} from "@opencoven/agent-contracts";
import { harnessesEnvelopeSchema } from "@opencoven/harness";
import type { RunnerAuthenticatedSubscriber } from "@/lib/runner/auth";
import {
  createRunnerHttpHandlers,
  type RunnerHttpHandlers,
} from "@/lib/runner/http";
import type { RunnerService } from "@/lib/runner/service";

const fixtureMode = process.env.RUNNER_ROUTES_FIXTURE;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const TENANT = "u_9c8589018a57479181fe4c455b099bc9";
const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const RUN_ID = "22222222-3333-4444-8555-666666666666";
const OPERATION_ID = "33333333-4444-4555-8666-777777777777";

const subscriber: RunnerAuthenticatedSubscriber = {
  authVersion: 4,
  kind: "allowed",
  principal: { kind: "subscriber", tenant: TENANT, userId: USER_ID },
  session: { kind: "subscriber", tenant: TENANT, userId: USER_ID },
  userId: USER_ID,
};

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    backend: "cloud",
    createdAt: "2026-08-28T15:00:00.000Z",
    description: "",
    id: AGENT_ID,
    instructions: "Do the thing.",
    lastRunAt: null,
    model: "auto",
    name: "Runner",
    owner: { kind: "tenant", tenantId: TENANT },
    runtime: "copilot",
    status: "idle",
    updatedAt: "2026-08-28T15:00:00.000Z",
    warm: {
      status: "ready",
      updatedAt: "2026-08-28T15:00:00.000Z",
    },
    ...overrides,
  };
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    agentId: AGENT_ID,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [],
    completedAt: null,
    createdAt: "2026-08-28T15:00:00.000Z",
    fileEvidence: [],
    id: RUN_ID,
    operationId: OPERATION_ID,
    output: "",
    startedAt: null,
    status: "queued",
    task: "Do the thing.",
    ...overrides,
  };
}

function service(): RunnerService {
  return {
    createAgent: async () => ({ agent: definition(), kind: "created" }),
    deleteAgent: async () => ({ kind: "deleted" }),
    diagnoseSandbox: async () => ({
      exitCode: 0,
      ok: true,
      output: "coven-agents",
    }),
    getAgent: async () => ({ agent: definition(), kind: "found" }),
    getRun: async () => ({ kind: "found", run: run() }),
    listAgentRuns: async () => ({ kind: "found", runs: [run()] }),
    listAgents: async () => [definition()],
    listHarnesses: async () => [
      {
        detail: "Installed and driven through its own CLI sign-in.",
        id: "copilot",
        installed: true,
        label: "GitHub Copilot CLI",
        streams: true,
        supported: true,
        version: "1.0.80",
      },
    ],
    prewarmMostRecent: async () => ({
      agentId: AGENT_ID,
      kind: "ready",
      warm: definition().warm,
    }),
    readRunEvents: async () => ({
      events: [],
      kind: "found",
      terminal: true,
    }),
    reconcileAndDispatch: async () => ({
      adopted: 0,
      deferred: 0,
      dispatched: 1,
      expiredScanned: 0,
      failures: 0,
      logEvents: 0,
      requeued: 0,
      sandboxRecovered: 0,
      terminalCleaned: 0,
      terminalized: 0,
    }),
    startRun: async () => ({ kind: "accepted", run: run() }),
    stopRun: async () => ({
      kind: "stopped",
      run: run({
        completedAt: "2026-08-28T15:01:00.000Z",
        status: "cancelled",
      }),
      scheduleReconciliation: true,
    }),
    updateAgent: async () => ({
      agent: definition({ name: "Updated" }),
      kind: "updated",
    }),
    warmAgent: async () => ({ kind: "ready", warm: definition().warm }),
  };
}

function testHandlers(): RunnerHttpHandlers {
  const runner = service();
  return createRunnerHttpHandlers({
    auth: {
      authorizeDiagnostic: () => ({ kind: "allowed" }),
      authorizeReconcile: () => ({ kind: "allowed" }),
      authorizeSubscriber: async () => subscriber,
    },
    createEventStream: () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(": ready\n\n"));
          controller.close();
        },
      }),
    createOperatorService: () => runner,
    createRequestId: () => "44444444-5555-4666-8777-888888888888",
    createService: () => runner,
    enforceAbuse: async () => ({ kind: "allowed" }),
    ipAddress: () => "203.0.113.10",
  });
}

const verbs = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;

function exportedVerbs(module: Record<string, unknown>): string[] {
  return verbs.filter((verb) => typeof module[verb] === "function");
}

function assertMetadata(module: Record<string, unknown>): void {
  assert.equal(module.runtime, "nodejs");
  assert.equal("dynamic" in module, false);
  assert.equal(module.maxDuration, 300);
}

async function executeFixture(): Promise<void> {
  const handlers = testHandlers();
  await mock.module("@/lib/runner/route-dependencies", {
    namedExports: {
      productionRunnerHttpHandlers: () => handlers,
    },
  });

  const [
    health,
    harnesses,
    agents,
    agent,
    agentRuns,
    runRead,
    events,
    stop,
    prewarm,
    diagnostic,
    reconcile,
  ] = await Promise.all([
    import("./health/route"),
    import("./harnesses/route"),
    import("./agents/route"),
    import("./agents/[id]/route"),
    import("./agents/[id]/runs/route"),
    import("./runs/[id]/route"),
    import("./runs/[id]/events/route"),
    import("./runs/[id]/stop/route"),
    import("./tenant/prewarm/route"),
    import("./diagnostics/sandbox/route"),
    import("./internal/runner-reconcile/route"),
  ]);

  for (const route of [
    health,
    harnesses,
    agents,
    agent,
    agentRuns,
    runRead,
    events,
    stop,
    prewarm,
    diagnostic,
    reconcile,
  ]) {
    assertMetadata(route);
  }
  assert.deepEqual(exportedVerbs(health), ["GET"]);
  assert.deepEqual(exportedVerbs(harnesses), ["GET"]);
  assert.deepEqual(exportedVerbs(agents), ["GET", "POST"]);
  assert.deepEqual(exportedVerbs(agent), ["DELETE", "GET", "PUT"]);
  assert.deepEqual(exportedVerbs(agentRuns), ["GET", "POST"]);
  assert.deepEqual(exportedVerbs(runRead), ["GET"]);
  assert.deepEqual(exportedVerbs(events), ["GET"]);
  assert.deepEqual(exportedVerbs(stop), ["POST"]);
  assert.deepEqual(exportedVerbs(prewarm), ["POST"]);
  assert.deepEqual(exportedVerbs(diagnostic), ["POST"]);
  assert.deepEqual(exportedVerbs(reconcile), ["GET", "POST"]);

  const context = { params: Promise.resolve({ id: AGENT_ID }) };
  const runContext = { params: Promise.resolve({ id: RUN_ID }) };

  const healthResponse = await health.GET(
    new Request("https://app.test/api/health")
  );
  assert.equal(healthResponse.status, 200);
  agentRunnerHealthSchema.parse(await healthResponse.json());

  const harnessResponse = await harnesses.GET(
    new Request("https://app.test/api/harnesses")
  );
  assert.equal(harnessResponse.status, 200);
  harnessesEnvelopeSchema.parse(await harnessResponse.json());

  const listResponse = await agents.GET(
    new Request("https://app.test/api/agents")
  );
  assert.equal(listResponse.status, 200);
  agentsEnvelopeSchema.parse(await listResponse.json());

  const createResponse = await agents.POST(
    new Request("https://app.test/api/agents", {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Runner",
        runtime: "copilot",
      }),
      method: "POST",
    })
  );
  assert.equal(createResponse.status, 201);
  agentEnvelopeSchema.parse(await createResponse.json());

  const getResponse = await agent.GET(
    new Request(`https://app.test/api/agents/${AGENT_ID}`),
    context
  );
  assert.equal(getResponse.status, 200);
  agentEnvelopeSchema.parse(await getResponse.json());

  const invalidGetResponse = await agent.GET(
    new Request("https://app.test/api/agents/not-an-id"),
    { params: Promise.resolve({ id: "not-an-id" }) }
  );
  assert.equal(invalidGetResponse.status, 400);
  assert.equal(
    runErrorEnvelopeSchema.parse(await invalidGetResponse.json()).error.code,
    "invalid_request"
  );

  const updateResponse = await agent.PUT(
    new Request(`https://app.test/api/agents/${AGENT_ID}`, {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Updated",
        runtime: "copilot",
      }),
      method: "PUT",
    }),
    context
  );
  assert.equal(updateResponse.status, 200);
  assert.equal(
    agentEnvelopeSchema.parse(await updateResponse.json()).agent.name,
    "Updated"
  );

  const deleteResponse = await agent.DELETE(
    new Request(`https://app.test/api/agents/${AGENT_ID}`, {
      method: "DELETE",
    }),
    context
  );
  assert.equal(deleteResponse.status, 200);
  okEnvelopeSchema.parse(await deleteResponse.json());

  const runsResponse = await agentRuns.GET(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`),
    context
  );
  assert.equal(runsResponse.status, 200);
  runListEnvelopeSchema.parse(await runsResponse.json());

  const startResponse = await agentRuns.POST(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      method: "POST",
    }),
    context
  );
  assert.equal(startResponse.status, 202);
  runSnapshotEnvelopeSchema.parse(await startResponse.json());

  const readResponse = await runRead.GET(
    new Request(`https://app.test/api/runs/${RUN_ID}`),
    runContext
  );
  assert.equal(readResponse.status, 200);
  runSnapshotEnvelopeSchema.parse(await readResponse.json());

  const eventsResponse = await events.GET(
    new Request(`https://app.test/api/runs/${RUN_ID}/events`),
    runContext
  );
  assert.equal(eventsResponse.status, 200);
  assert.equal(
    eventsResponse.headers.get("content-type"),
    "text/event-stream; charset=utf-8"
  );

  const stopResponse = await stop.POST(
    new Request(`https://app.test/api/runs/${RUN_ID}/stop`, { method: "POST" }),
    runContext
  );
  assert.equal(stopResponse.status, 200);
  runSnapshotEnvelopeSchema.parse(await stopResponse.json());

  const prewarmResponse = await prewarm.POST(
    new Request("https://app.test/api/tenant/prewarm", { method: "POST" })
  );
  assert.equal(prewarmResponse.status, 202);
  assert.deepEqual(await prewarmResponse.json(), {
    agentId: AGENT_ID,
    warm: definition().warm,
  });

  const diagnosticResponse = await diagnostic.POST(
    new Request("https://app.test/api/diagnostics/sandbox", { method: "POST" })
  );
  assert.equal(diagnosticResponse.status, 200);
  assert.deepEqual(await diagnosticResponse.json(), {
    exitCode: 0,
    ok: true,
    output: "coven-agents",
  });

  await Promise.all(
    [
      { invoke: reconcile.GET, method: "GET" },
      { invoke: reconcile.POST, method: "POST" },
    ].map(async ({ invoke, method }) => {
      const response = await invoke(
        new Request("https://app.test/api/internal/runner-reconcile", {
          method,
        })
      );
      assert.equal(response.status, 200);
      assert.equal(
        ((await response.json()) as { dispatched: number }).dispatched,
        1
      );
    })
  );

  process.stdout.write(JSON.stringify({ ok: true }));
}

function runFixture(): { ok: boolean } {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-test-module-mocks",
      "--conditions=react-server",
      "--import",
      "tsx",
      fileURLToPath(import.meta.url),
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, RUNNER_ROUTES_FIXTURE: "1" },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { ok: boolean };
}

if (fixtureMode) {
  executeFixture().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
} else {
  test("actual runner route modules preserve methods, metadata, params, and envelopes", () => {
    assert.deepEqual(runFixture(), { ok: true });
  });
}
