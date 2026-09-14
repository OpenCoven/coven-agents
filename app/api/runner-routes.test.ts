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
  runLiveViewEnvelopeSchema,
  runSnapshotEnvelopeSchema,
} from "@opencoven/agent-contracts";
import { harnessesEnvelopeSchema } from "@opencoven/harness";
import type { RunnerAuthenticatedSubscriber } from "@/lib/runner/auth";
import {
  createRunnerHttpHandlers,
  type RunnerHttpHandlers,
} from "@/lib/runner/http";
import { type RunnerService, RunnerServiceError } from "@/lib/runner/service";

const fixtureMode = process.env.RUNNER_ROUTES_FIXTURE;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const TENANT = "u_9c8589018a57479181fe4c455b099bc9";
const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const RUN_ID = "22222222-3333-4444-8555-666666666666";
const OPERATION_ID = "33333333-4444-4555-8666-777777777777";
const NativeRequest = globalThis.Request;

class Request extends NativeRequest {
  constructor(
    input: ConstructorParameters<typeof NativeRequest>[0],
    init: RequestInit = {}
  ) {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (method === "POST" || method === "PUT" || method === "DELETE") {
      if (!headers.has("origin")) {
        headers.set("origin", new URL(String(input)).origin);
      }
      if (init.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    }
    super(input, { ...init, headers });
  }
}

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
    familiarId: "auto",
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

function service(overrides: Partial<RunnerService> = {}): RunnerService {
  return {
    createAgent: async () => ({ agent: definition(), kind: "created" }),
    deleteAgent: async () => ({ kind: "deleted" }),
    diagnoseSandbox: async () => ({
      exitCode: 0,
      ok: true,
      output: "coven-agents",
      snapshot: {
        name: "coven-agents-copilot-2",
        resources: { cpu: 2, disk: 10, memory: 4 },
        target: "us",
      },
    }),
    dispatchClaim: async (claimed) => ({
      kind: "started",
      runId: claimed.run.id,
    }),
    getAgent: async () => ({ agent: definition(), kind: "found" }),
    getRun: async () => ({ kind: "found", run: run() }),
    getRunLiveView: async () => ({
      kind: "unavailable",
      reason: "not_configured",
    }),
    inventoryResources: async () => ({
      ambiguityReasons: {
        configurationDrift: 0,
        databaseBounded: 0,
        duplicateIdentity: 0,
        duplicateProviderId: 0,
        multipleMappings: 0,
        pendingLifecycle: 0,
        unresolved: 0,
      },
      ambiguous: 0,
      appOwnedMappings: 0,
      configurationDrift: [],
      databaseCapped: false,
      examined: 0,
      kind: "available",
      matched: 0,
      providerCapped: false,
      states: { active: 0, archived: 0, other: 0, stopped: 0 },
      status: "complete",
      unowned: 0,
      version: 1,
    }),
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
      deferred: 7,
      dispatched: 1,
      execution: "executed",
      expiredScanned: 0,
      failures: 0,
      logEvents: 0,
      requeued: 0,
      sandboxRecovered: 0,
      terminalCleaned: 0,
      terminalized: 0,
      terminalLeaseCleaned: 0,
    }),
    repairResources: async () => ({
      appOwnedMappings: 0,
      batchCapped: false,
      databaseCapped: false,
      deferred: 0,
      eligible: 0,
      examined: 0,
      failures: 0,
      kind: "available",
      providerCapped: false,
      refused: 0,
      repaired: 0,
      status: "complete",
      unchanged: 0,
      version: 1,
    }),
    startRun: async () => ({
      admission: "duplicate",
      kind: "accepted",
      run: run(),
    }),
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
    ...overrides,
  };
}

type RouteFixtureState = {
  diagnosticAbuseCalls: number;
  diagnosticAuthorizationCalls: number;
  diagnosticMode: "failure" | "success";
  diagnosticProviderCalls: number;
  stopMode: "stale" | "success";
  updateCalls: number;
};

function testHandlers(state: RouteFixtureState): RunnerHttpHandlers {
  const runner = service({
    stopRun: () =>
      Promise.resolve(
        state.stopMode === "stale"
          ? { kind: "stale_version" as const }
          : {
              kind: "stopped" as const,
              run: run({
                completedAt: "2026-08-28T15:01:00.000Z",
                status: "cancelled",
              }),
              scheduleReconciliation: true as const,
            }
      ),
    updateAgent: () => {
      state.updateCalls += 1;
      return Promise.resolve(
        state.updateCalls > 1
          ? { kind: "busy" }
          : {
              agent: definition({ name: "Updated" }),
              kind: "updated",
            }
      );
    },
  });
  return createRunnerHttpHandlers({
    auth: {
      authorizeDiagnostic: (request) => {
        state.diagnosticAuthorizationCalls += 1;
        const decision = request.headers.get("x-test-authorization");
        return decision === "unauthorized" || decision === "unavailable"
          ? { kind: decision }
          : { kind: "allowed" };
      },
      authorizeReconcile: () => ({ kind: "allowed" }),
      authorizeSubscriber: async () => subscriber,
    },
    createDiagnosticName: () => "coven-diagnostic-route-precomputed",
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
    diagnoseSandbox: (name) => {
      assert.equal(name, "coven-diagnostic-route-precomputed");
      state.diagnosticProviderCalls += 1;
      if (state.diagnosticMode === "failure") {
        throw new RunnerServiceError(
          "diagnostic_unavailable",
          "provider=private-detail sandbox-id=private"
        );
      }
      return runner.diagnoseSandbox();
    },
    enforceAbuse: (input) => {
      if (input.route !== "runner_diagnostic") {
        return Promise.resolve({ kind: "allowed" });
      }
      state.diagnosticAbuseCalls += 1;
      return Promise.resolve(
        input.ip === "rate-limited"
          ? {
              kind: "denied",
              responseStatus: 429,
              retryAfterSeconds: 7,
            }
          : { kind: "allowed" }
      );
    },
    ipAddress: (request) => request.headers.get("x-test-ip") ?? "203.0.113.10",
  });
}

const verbs = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;

function exportedVerbs(module: Record<string, unknown>): string[] {
  return verbs.filter((verb) => typeof module[verb] === "function");
}

function assertMetadata(module: Record<string, unknown>): void {
  assert.equal("runtime" in module, false);
  assert.equal("dynamic" in module, false);
  assert.equal(module.maxDuration, 300);
}

async function executeFixture(): Promise<void> {
  const state: RouteFixtureState = {
    diagnosticAbuseCalls: 0,
    diagnosticAuthorizationCalls: 0,
    diagnosticMode: "success",
    diagnosticProviderCalls: 0,
    stopMode: "success",
    updateCalls: 0,
  };
  const handlers = testHandlers(state);
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
    liveView,
    stop,
    prewarm,
    diagnostic,
    reconcile,
    inventory,
    repair,
  ] = await Promise.all([
    import("./health/route"),
    import("./harnesses/route"),
    import("./agents/route"),
    import("./agents/[id]/route"),
    import("./agents/[id]/runs/route"),
    import("./runs/[id]/route"),
    import("./runs/[id]/events/route"),
    import("./runs/[id]/live-view/route"),
    import("./runs/[id]/stop/route"),
    import("./tenant/prewarm/route"),
    import("./diagnostics/sandbox/route"),
    import("./internal/runner-reconcile/route"),
    import("./internal/runner-resource-inventory/route"),
    import("./internal/runner-resource-repair/route"),
  ]);

  for (const route of [
    health,
    harnesses,
    agents,
    agent,
    agentRuns,
    runRead,
    events,
    liveView,
    stop,
    prewarm,
    diagnostic,
    reconcile,
    inventory,
    repair,
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
  assert.deepEqual(exportedVerbs(liveView), ["GET"]);
  assert.deepEqual(exportedVerbs(stop), ["POST"]);
  assert.deepEqual(exportedVerbs(prewarm), ["POST"]);
  assert.deepEqual(exportedVerbs(diagnostic), ["POST"]);
  assert.deepEqual(exportedVerbs(reconcile), ["GET", "POST"]);
  assert.deepEqual(exportedVerbs(inventory), ["GET", "POST"]);

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

  const crossOriginResponse = await agents.POST(
    new Request("https://app.test/api/agents", {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Runner",
        runtime: "copilot",
      }),
      headers: {
        "content-type": "application/json",
        origin: "https://sibling.app.test",
      },
      method: "POST",
    })
  );
  assert.equal(crossOriginResponse.status, 403);
  assert.equal(
    runErrorEnvelopeSchema.parse(await crossOriginResponse.json()).error.code,
    "origin_rejected"
  );

  const wrongMediaTypeResponse = await agents.POST(
    new Request("https://app.test/api/agents", {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Runner",
        runtime: "copilot",
      }),
      headers: {
        "content-type": "text/plain",
        origin: "https://app.test",
      },
      method: "POST",
    })
  );
  assert.equal(wrongMediaTypeResponse.status, 400);
  assert.equal(
    runErrorEnvelopeSchema.parse(await wrongMediaTypeResponse.json()).error
      .code,
    "unsupported_media_type"
  );

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

  const busyUpdateResponse = await agent.PUT(
    new Request(`https://app.test/api/agents/${AGENT_ID}`, {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Blocked",
        runtime: "copilot",
      }),
      method: "PUT",
    }),
    context
  );
  assert.equal(busyUpdateResponse.status, 409);
  assert.equal(
    runErrorEnvelopeSchema.parse(await busyUpdateResponse.json()).error.code,
    "busy"
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

  const liveViewResponse = await liveView.GET(
    new Request(`https://app.test/api/runs/${RUN_ID}/live-view`),
    runContext
  );
  assert.equal(liveViewResponse.status, 200);
  assert.equal(liveViewResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(
    runLiveViewEnvelopeSchema.parse(await liveViewResponse.json()).view,
    { kind: "unavailable", reason: "not_configured" }
  );

  const stopResponse = await stop.POST(
    new Request(`https://app.test/api/runs/${RUN_ID}/stop`, { method: "POST" }),
    runContext
  );
  assert.equal(stopResponse.status, 200);
  runSnapshotEnvelopeSchema.parse(await stopResponse.json());

  state.stopMode = "stale";
  const staleStopResponse = await stop.POST(
    new Request(`https://app.test/api/runs/${RUN_ID}/stop`, { method: "POST" }),
    runContext
  );
  assert.equal(staleStopResponse.status, 409);
  const staleStop = runErrorEnvelopeSchema.parse(
    await staleStopResponse.json()
  );
  assert.equal(staleStop.error.code, "stale_version");
  assert.equal(staleStop.error.retryable, true);

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
    snapshot: {
      name: "coven-agents-copilot-2",
      resources: { cpu: 2, disk: 10, memory: 4 },
      target: "us",
    },
  });
  assert.equal(state.diagnosticAbuseCalls, 1);
  assert.equal(state.diagnosticAuthorizationCalls, 1);
  assert.equal(state.diagnosticProviderCalls, 1);

  const unauthorizedDiagnostic = await diagnostic.POST(
    new Request("https://app.test/api/diagnostics/sandbox", {
      headers: { "x-test-authorization": "unauthorized" },
      method: "POST",
    })
  );
  assert.equal(unauthorizedDiagnostic.status, 401);
  assert.equal(
    runErrorEnvelopeSchema.parse(await unauthorizedDiagnostic.json()).error
      .code,
    "unauthorized"
  );
  assert.equal(state.diagnosticAbuseCalls, 2);
  assert.equal(state.diagnosticAuthorizationCalls, 2);
  assert.equal(state.diagnosticProviderCalls, 1);

  const rateLimitedDiagnostic = await diagnostic.POST(
    new Request("https://app.test/api/diagnostics/sandbox", {
      headers: {
        "x-test-authorization": "unauthorized",
        "x-test-ip": "rate-limited",
      },
      method: "POST",
    })
  );
  assert.equal(rateLimitedDiagnostic.status, 429);
  assert.equal(rateLimitedDiagnostic.headers.get("retry-after"), "7");
  assert.equal(
    runErrorEnvelopeSchema.parse(await rateLimitedDiagnostic.json()).error.code,
    "rate_limited"
  );
  assert.equal(state.diagnosticAbuseCalls, 3);
  assert.equal(state.diagnosticAuthorizationCalls, 2);
  assert.equal(state.diagnosticProviderCalls, 1);

  state.diagnosticMode = "failure";
  const failedDiagnostic = await diagnostic.POST(
    new Request("https://app.test/api/diagnostics/sandbox", { method: "POST" })
  );
  assert.equal(failedDiagnostic.status, 503);
  const failedDiagnosticBody = runErrorEnvelopeSchema.parse(
    await failedDiagnostic.json()
  );
  assert.equal(failedDiagnosticBody.error.code, "diagnostic_unavailable");
  assert.equal(failedDiagnosticBody.error.retryable, true);
  assert.equal(JSON.stringify(failedDiagnosticBody).includes("private"), false);
  assert.equal(
    JSON.stringify(failedDiagnosticBody).includes("sandbox-id"),
    false
  );
  assert.equal(state.diagnosticAbuseCalls, 4);
  assert.equal(state.diagnosticAuthorizationCalls, 3);
  assert.equal(state.diagnosticProviderCalls, 2);

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
      const result = (await response.json()) as {
        deferred: number;
        dispatched: number;
        execution: string;
      };
      assert.equal(result.deferred, 7);
      assert.equal(result.dispatched, 1);
      assert.equal(result.execution, "executed");
    })
  );

  const inventoryResponse = await inventory.POST(
    new Request("https://app.test/api/internal/runner-resource-inventory", {
      method: "POST",
    })
  );
  assert.equal(inventoryResponse.status, 200);
  assert.equal(inventoryResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await inventoryResponse.json(), {
    ambiguityReasons: {
      configurationDrift: 0,
      databaseBounded: 0,
      duplicateIdentity: 0,
      duplicateProviderId: 0,
      multipleMappings: 0,
      pendingLifecycle: 0,
      unresolved: 0,
    },
    ambiguous: 0,
    appOwnedMappings: 0,
    configurationDrift: [],
    databaseCapped: false,
    examined: 0,
    matched: 0,
    providerCapped: false,
    states: { active: 0, archived: 0, other: 0, stopped: 0 },
    status: "complete",
    unowned: 0,
    version: 1,
  });

  const repairResponse = await repair.POST(
    new Request("https://app.test/api/internal/runner-resource-repair", {
      method: "POST",
    })
  );
  assert.equal(repairResponse.status, 200);
  assert.equal(repairResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await repairResponse.json(), {
    appOwnedMappings: 0,
    batchCapped: false,
    databaseCapped: false,
    deferred: 0,
    eligible: 0,
    examined: 0,
    failures: 0,
    providerCapped: false,
    refused: 0,
    repaired: 0,
    status: "complete",
    unchanged: 0,
    version: 1,
  });

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
  test("actual runner route modules import and invoke with supported metadata", () => {
    assert.deepEqual(runFixture(), { ok: true });
  });
}
