import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  type AgentDefinition,
  type RunEvent,
  type RunSnapshot,
} from "@opencoven/agent-contracts";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import type {
  RunnerAuth,
  RunnerAuthenticatedSubscriber,
  RunnerSecretAuthorization,
} from "./auth";
import { createRunnerHttpHandlers, type RunnerHttpHandlers } from "./http";
import { type RunnerService, RunnerServiceError } from "./service";
import type { RunnerClaimedDispatch, RunnerDispatchAuthority } from "./types";

const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const TENANT = "u_9c8589018a57479181fe4c455b099bc9";
const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const RUN_ID = "22222222-3333-4444-8555-666666666666";
const OPERATION_ID = "33333333-4444-4555-8666-777777777777";
const REQUEST_ID = "44444444-5555-4666-8777-888888888888";
const DIAGNOSTIC_NAME = "coven-diagnostic-precomputed-http-name";
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
      status: "not_started",
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

function counts() {
  return {
    adopted: 0,
    deferred: 0,
    dispatched: 1,
    execution: "executed" as const,
    expiredScanned: 0,
    failures: 0,
    logEvents: 0,
    requeued: 0,
    sandboxRecovered: 0,
    terminalCleaned: 0,
    terminalized: 0,
    terminalLeaseCleaned: 0,
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
    }),
    dispatchClaim: async (claimed) => ({
      kind: "started",
      runId: claimed.run.id,
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
      warm: {
        status: "ready",
        updatedAt: "2026-08-28T15:00:00.000Z",
      },
    }),
    readRunEvents: async () => ({
      events: [],
      kind: "found",
      terminal: true,
    }),
    reconcileAndDispatch: async () => counts(),
    startRun: async () => ({
      admission: "created",
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
    warmAgent: async () => ({
      kind: "ready",
      warm: {
        status: "ready",
        updatedAt: "2026-08-28T15:00:00.000Z",
      },
    }),
    ...overrides,
  };
}

function authorizedAuth(): RunnerAuth {
  return {
    authorizeDiagnostic: () => ({ kind: "allowed" }),
    authorizeReconcile: () => ({ kind: "allowed" }),
    authorizeSubscriber: async () => subscriber,
  };
}

function handlers(
  options: {
    admission?: AbuseAdmission;
    after?:
      | ((task: Promise<unknown> | (() => void | Promise<void>)) => void)
      | null;
    appOrigin?: string | (() => string | null);
    auth?: RunnerAuth;
    onAbuse?: (input: AbuseEnforcementInput) => void;
    service?: RunnerService;
  } = {}
) {
  const after: (() => void | Promise<void>)[] = [];
  const admissions: AbuseEnforcementInput[] = [];
  const diagnosticNames: string[] = [];
  const logs: unknown[] = [];
  let diagnosticRequests = 0;
  let serviceRequests = 0;
  let operatorRequests = 0;
  const runner = options.service ?? service();
  const result = createRunnerHttpHandlers({
    ...(options.after === null
      ? {}
      : {
          after:
            options.after ??
            ((task) => {
              after.push(
                typeof task === "function"
                  ? task
                  : async () => {
                      await task;
                    }
              );
            }),
        }),
    ...(Object.hasOwn(options, "appOrigin")
      ? { appOrigin: options.appOrigin }
      : {}),
    auth: options.auth ?? authorizedAuth(),
    createDiagnosticName: () => DIAGNOSTIC_NAME,
    createOperatorService: () => {
      operatorRequests += 1;
      return runner;
    },
    createRequestId: () => REQUEST_ID,
    createService: () => {
      serviceRequests += 1;
      return runner;
    },
    diagnoseSandbox: (name) => {
      diagnosticRequests += 1;
      diagnosticNames.push(name);
      return runner.diagnoseSandbox();
    },
    enforceAbuse: (input) => {
      options.onAbuse?.(input);
      admissions.push(input);
      return Promise.resolve(options.admission ?? { kind: "allowed" });
    },
    ipAddress: () => "203.0.113.10",
    logger: {
      error: (_message, details) => {
        logs.push(details);
      },
    },
  });
  return {
    admissions,
    after,
    diagnosticNames,
    diagnosticRequests: () => diagnosticRequests,
    handlers: result,
    logs,
    operatorRequests: () => operatorRequests,
    serviceRequests: () => serviceRequests,
  };
}

function validDefinitionBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    backend: "cloud",
    instructions: "Do the thing.",
    model: "auto",
    name: "Runner",
    runtime: "copilot",
    ...overrides,
  });
}

const operatorRouteCases: readonly {
  abuseRoute: "runner_diagnostic" | "runner_reconcile";
  invoke: (handlers: RunnerHttpHandlers, request: Request) => Promise<Response>;
  name: string;
}[] = [
  {
    abuseRoute: "runner_diagnostic",
    invoke: (runnerHandlers, request) =>
      runnerHandlers.diagnoseSandbox(request),
    name: "diagnostics",
  },
  {
    abuseRoute: "runner_reconcile",
    invoke: (runnerHandlers, request) => runnerHandlers.reconcile(request),
    name: "reconcile",
  },
];

function orderedOperatorRequest(events: string[]): Request {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{}"));
      controller.close();
    },
  });
  const body = {
    getReader() {
      events.push("body");
      return stream.getReader();
    },
  };

  return {
    body,
    headers: new Headers(),
  } as unknown as Request;
}

function orderedOperatorHandlers(
  events: string[],
  abuseRoute: "runner_diagnostic" | "runner_reconcile",
  authorization: RunnerSecretAuthorization,
  admission: AbuseAdmission
): RunnerHttpHandlers {
  const runner = service({
    diagnoseSandbox: () => {
      events.push("provider");
      return Promise.resolve({
        exitCode: 0,
        ok: true,
        output: "coven-agents",
      });
    },
    reconcileAndDispatch: () => {
      events.push("provider");
      return Promise.resolve(counts());
    },
  });

  return createRunnerHttpHandlers({
    auth: {
      authorizeDiagnostic: () => {
        events.push("secret");
        return authorization;
      },
      authorizeReconcile: () => {
        events.push("secret");
        return authorization;
      },
      authorizeSubscriber: async () => subscriber,
    },
    createDiagnosticName: () => {
      events.push("name");
      return DIAGNOSTIC_NAME;
    },
    createOperatorService: () => {
      events.push("service");
      return runner;
    },
    createRequestId: () => REQUEST_ID,
    createService: () => {
      events.push("subscriber-service");
      return runner;
    },
    diagnoseSandbox: () => {
      events.push("service");
      return runner.diagnoseSandbox();
    },
    enforceAbuse: (input) => {
      events.push("abuse");
      assert.deepEqual(input, {
        failClosed: true,
        ip: "203.0.113.10",
        route: abuseRoute,
      });
      return Promise.resolve(admission);
    },
    ipAddress: () => "203.0.113.10",
  });
}

test("health is the exact unauthenticated v1 descriptor under its IP policy", async () => {
  const fixture = handlers();
  const response = await fixture.handlers.health(
    new Request("https://app.test/api/health")
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    apiVersion: AGENT_RUNNER_API_VERSION,
    capabilities: [...AGENT_RUNNER_CAPABILITIES],
    minimumClientVersion: "1.0.0",
    mode: "cloud",
  });
  assert.deepEqual(fixture.admissions, [
    {
      failClosed: true,
      ip: "203.0.113.10",
      route: "runner_public_read",
    },
  ]);
  assert.equal(fixture.serviceRequests(), 0);
});

test("subscriber failures fail closed before abuse admission or service construction", async () => {
  const fixture = handlers({
    auth: {
      authorizeDiagnostic: () => ({ kind: "unauthorized" }),
      authorizeReconcile: () => ({ kind: "unauthorized" }),
      authorizeSubscriber: async () => ({ kind: "subscription_required" }),
    },
  });

  const response = await fixture.handlers.listAgents(
    new Request("https://app.test/api/agents")
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    apiVersion: AGENT_RUNNER_API_VERSION,
    error: {
      code: "subscription_required",
      message: "An active subscription is required.",
      retryable: false,
    },
    requestId: REQUEST_ID,
  });
  assert.equal(fixture.admissions.length, 0);
  assert.equal(fixture.serviceRequests(), 0);
});

test("cookie mutations reject invalid origins before auth with zero side effects", async () => {
  let authorizations = 0;
  const cases: {
    body?: string;
    origin?: string;
    invoke: (runner: RunnerHttpHandlers, request: Request) => Promise<Response>;
    method: string;
    url: string;
  }[] = [
    {
      body: validDefinitionBody(),
      invoke: (runner: RunnerHttpHandlers, request: Request) =>
        runner.createAgent(request),
      method: "POST",
      origin: "https://sibling.app.test",
      url: "https://app.test/api/agents",
    },
    {
      body: validDefinitionBody({ name: "Updated" }),
      invoke: (runner: RunnerHttpHandlers, request: Request) =>
        runner.updateAgent(request, AGENT_ID),
      method: "PUT",
      origin: "",
      url: `https://app.test/api/agents/${AGENT_ID}`,
    },
    {
      invoke: (runner: RunnerHttpHandlers, request: Request) =>
        runner.deleteAgent(request, AGENT_ID),
      method: "DELETE",
      origin: "not-an-origin",
      url: `https://app.test/api/agents/${AGENT_ID}`,
    },
    {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      invoke: (runner: RunnerHttpHandlers, request: Request) =>
        runner.startAgentRun(request, AGENT_ID),
      method: "POST",
      origin: "https://sibling.app.test",
      url: `https://app.test/api/agents/${AGENT_ID}/runs`,
    },
    {
      invoke: (runner: RunnerHttpHandlers, request: Request) =>
        runner.stopRun(request, RUN_ID),
      method: "POST",
      origin: "",
      url: `https://app.test/api/runs/${RUN_ID}/stop`,
    },
    {
      invoke: (runner: RunnerHttpHandlers, request: Request) =>
        runner.prewarmTenant(request),
      method: "POST",
      origin: "not-an-origin",
      url: "https://app.test/api/tenant/prewarm",
    },
  ];

  await Promise.all(
    cases.map(async (testCase) => {
      const fixture = handlers({
        auth: {
          authorizeDiagnostic: () => ({ kind: "allowed" }),
          authorizeReconcile: () => ({ kind: "allowed" }),
          authorizeSubscriber: () => {
            authorizations += 1;
            return Promise.resolve(subscriber);
          },
        },
      });
      const request = new NativeRequest(testCase.url, {
        body: testCase.body,
        headers: {
          ...(testCase.body ? { "content-type": "application/json" } : {}),
          ...(testCase.origin ? { origin: testCase.origin } : {}),
        },
        method: testCase.method,
      });

      const response = await testCase.invoke(fixture.handlers, request);

      assert.equal(response.status, 403);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        "origin_rejected"
      );
      assert.equal(request.bodyUsed, false);
      assert.equal(fixture.admissions.length, 0);
      assert.equal(fixture.serviceRequests(), 0);
      assert.equal(fixture.after.length, 0);
    })
  );
  assert.equal(authorizations, 0);
});

test("cookie JSON mutations reject non-JSON media types before auth, abuse, or parsing", async () => {
  let authorizations = 0;
  const fixture = handlers({
    auth: {
      authorizeDiagnostic: () => ({ kind: "allowed" }),
      authorizeReconcile: () => ({ kind: "allowed" }),
      authorizeSubscriber: () => {
        authorizations += 1;
        return Promise.resolve(subscriber);
      },
    },
  });
  const request = new Request("https://app.test/api/agents", {
    body: validDefinitionBody(),
    headers: {
      "content-type": "text/plain",
      origin: "https://app.test",
    },
    method: "POST",
  });

  const response = await fixture.handlers.createAgent(request);

  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "unsupported_media_type"
  );
  assert.equal(request.bodyUsed, false);
  assert.equal(authorizations, 0);
  assert.equal(fixture.admissions.length, 0);
  assert.equal(fixture.serviceRequests(), 0);
  assert.equal(fixture.after.length, 0);
});

test("cookie mutations fail closed when the configured application origin is unavailable", async () => {
  let authorizations = 0;
  const fixture = handlers({
    appOrigin: () => null,
    auth: {
      authorizeDiagnostic: () => ({ kind: "allowed" }),
      authorizeReconcile: () => ({ kind: "allowed" }),
      authorizeSubscriber: () => {
        authorizations += 1;
        return Promise.resolve(subscriber);
      },
    },
  });
  const request = new Request("https://app.test/api/agents", {
    body: validDefinitionBody(),
    headers: {
      "content-type": "application/json",
      origin: "https://app.test",
    },
    method: "POST",
  });

  const response = await fixture.handlers.createAgent(request);

  assert.equal(response.status, 403);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "origin_rejected"
  );
  assert.equal(request.bodyUsed, false);
  assert.equal(authorizations, 0);
  assert.equal(fixture.admissions.length, 0);
  assert.equal(fixture.serviceRequests(), 0);
});

test("subscriber GET and SSE reads do not require an Origin header", async () => {
  const fixture = handlers();

  const [agentResponse, eventsResponse] = await Promise.all([
    fixture.handlers.getAgent(
      new Request(`https://app.test/api/agents/${AGENT_ID}`),
      AGENT_ID
    ),
    fixture.handlers.getRunEvents(
      new Request(`https://app.test/api/runs/${RUN_ID}/events`),
      RUN_ID
    ),
  ]);

  assert.equal(agentResponse.status, 200);
  assert.equal(eventsResponse.status, 200);
  assert.match(
    eventsResponse.headers.get("content-type") ?? "",
    /^text\/event-stream/u
  );
});

test("abuse refusal happens before body parsing and returns v1 retry metadata", async () => {
  const events: string[] = [];
  const fixture = handlers({
    admission: {
      kind: "denied",
      responseStatus: 429,
      retryAfterSeconds: 42,
    },
    auth: {
      authorizeDiagnostic: () => ({ kind: "allowed" }),
      authorizeReconcile: () => ({ kind: "allowed" }),
      authorizeSubscriber: () => {
        events.push("auth");
        return Promise.resolve(subscriber);
      },
    },
    onAbuse: () => {
      events.push("abuse");
    },
  });
  const request = new Request("https://app.test/api/agents", {
    body: "not-json",
    method: "POST",
  });

  const response = await fixture.handlers.createAgent(request);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.equal(request.bodyUsed, false);
  assert.deepEqual(events, ["auth", "abuse"]);
  assert.equal(fixture.admissions.length, 1);
  assert.equal(fixture.serviceRequests(), 0);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "rate_limited"
  );
});

test("unauthenticated cookie mutations stop after one auth lookup", async () => {
  const events: string[] = [];
  const fixture = handlers({
    auth: {
      authorizeDiagnostic: () => ({ kind: "allowed" }),
      authorizeReconcile: () => ({ kind: "allowed" }),
      authorizeSubscriber: () => {
        events.push("auth");
        return Promise.resolve({ kind: "unauthorized" });
      },
    },
  });
  const request = new Request("https://app.test/api/agents", {
    body: validDefinitionBody(),
    method: "POST",
  });

  const response = await fixture.handlers.createAgent(request);

  assert.equal(response.status, 401);
  assert.deepEqual(events, ["auth"]);
  assert.equal(request.bodyUsed, false);
  assert.equal(fixture.admissions.length, 0);
  assert.equal(fixture.serviceRequests(), 0);
  assert.equal(fixture.after.length, 0);
});

test("valid subscriber writes preserve preflight, auth, abuse, body, service, provider ordering", async () => {
  const events: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(validDefinitionBody()));
      controller.close();
    },
  });
  const request = {
    body: {
      getReader() {
        events.push("body");
        return stream.getReader();
      },
    },
    headers: {
      get(name: string) {
        if (name === "origin" || name === "content-type") {
          events.push(name);
        }
        if (name === "origin") {
          return "https://app.test";
        }
        if (name === "content-type") {
          return "application/json";
        }
        return null;
      },
    } as Headers,
    method: "POST",
    url: "https://app.test/api/agents",
  } as unknown as Request;
  const runner = service({
    createAgent: () => {
      events.push("provider");
      return Promise.resolve({ agent: definition(), kind: "created" });
    },
  });
  const runnerHandlers = createRunnerHttpHandlers({
    auth: {
      authorizeDiagnostic: () => ({ kind: "allowed" }),
      authorizeReconcile: () => ({ kind: "allowed" }),
      authorizeSubscriber: () => {
        events.push("identity");
        return Promise.resolve(subscriber);
      },
    },
    createOperatorService: () => runner,
    createService: () => {
      events.push("service");
      return runner;
    },
    diagnoseSandbox: () => runner.diagnoseSandbox(),
    enforceAbuse: () => {
      events.push("abuse");
      return Promise.resolve({ kind: "allowed" });
    },
    ipAddress: () => "203.0.113.10",
  });

  const response = await runnerHandlers.createAgent(request);

  assert.equal(response.status, 201);
  assert.deepEqual(events, [
    "origin",
    "content-type",
    "identity",
    "abuse",
    "body",
    "service",
    "provider",
  ]);
});

test("create rejects malformed, oversized, unknown, and owner-injected inputs", async () => {
  let creates = 0;
  const fixture = handlers({
    service: service({
      createAgent: () => {
        creates += 1;
        return Promise.resolve({
          agent: definition(),
          kind: "created" as const,
        });
      },
    }),
  });

  const malformedResponses = await Promise.all(
    [
      "{",
      validDefinitionBody({ owner: { kind: "tenant", tenantId: "other" } }),
      validDefinitionBody({ unexpected: true }),
    ].map(async (body) => {
      const response = await fixture.handlers.createAgent(
        new Request("https://app.test/api/agents", { body, method: "POST" })
      );
      return {
        body: (await response.json()) as { error: { code: string } },
        status: response.status,
      };
    })
  );
  for (const response of malformedResponses) {
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_request");
  }
  const response = await fixture.handlers.createAgent(
    new Request("https://app.test/api/agents", {
      body: "x".repeat(64_001),
      headers: { "content-length": "64001" },
      method: "POST",
    })
  );
  assert.equal(response.status, 413);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "body_too_large"
  );
  assert.equal(creates, 0);
  assert.equal(fixture.serviceRequests(), 0);
});

test("create returns the stamped agent and schedules bounded warm/reconcile work", async () => {
  let warmed = 0;
  let reconciled = 0;
  const fixture = handlers({
    service: service({
      reconcileAndDispatch: () => {
        reconciled += 1;
        return Promise.resolve(counts());
      },
      warmAgent: () => {
        warmed += 1;
        return Promise.resolve({
          kind: "ready",
          warm: {
            status: "ready",
            updatedAt: "2026-08-28T15:00:00.000Z",
          },
        });
      },
    }),
  });

  const response = await fixture.handlers.createAgent(
    new Request("https://app.test/api/agents", {
      body: validDefinitionBody(),
      method: "POST",
    })
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { agent: definition() });
  assert.equal(warmed, 0);
  assert.equal(reconciled, 0);
  assert.equal(fixture.after.length, 1);
  await fixture.after[0]();
  assert.equal(warmed, 1);
  assert.equal(reconciled, 1);
});

test("update schedules bounded warm and reconciliation work", async () => {
  let warmed = 0;
  let reconciled = 0;
  const fixture = handlers({
    service: service({
      reconcileAndDispatch: () => {
        reconciled += 1;
        return Promise.resolve(counts());
      },
      warmAgent: () => {
        warmed += 1;
        return Promise.resolve({
          kind: "ready",
          warm: {
            status: "ready",
            updatedAt: "2026-08-28T15:00:00.000Z",
          },
        });
      },
    }),
  });

  const response = await fixture.handlers.updateAgent(
    new Request(`https://app.test/api/agents/${AGENT_ID}`, {
      body: validDefinitionBody({ name: "Updated" }),
      method: "PUT",
    }),
    AGENT_ID
  );

  assert.equal(response.status, 200);
  assert.equal(warmed, 0);
  assert.equal(reconciled, 0);
  assert.equal(fixture.after.length, 1);
  await fixture.after[0]();
  assert.equal(warmed, 1);
  assert.equal(reconciled, 1);
});

test("scheduled update warming observes failures without rejection or provider leakage", async () => {
  let reconciled = 0;
  const typedFailure = handlers({
    service: service({
      reconcileAndDispatch: () => {
        reconciled += 1;
        return Promise.resolve(counts());
      },
      warmAgent: () =>
        Promise.resolve({ kind: "unavailable", source: "provider" }),
    }),
  });
  const rejectedWarm = handlers({
    service: service({
      warmAgent: () =>
        Promise.reject(new Error("provider=sensitive sandbox=private")),
    }),
  });

  await Promise.all(
    [typedFailure, rejectedWarm].map(async (fixture) => {
      const response = await fixture.handlers.updateAgent(
        new Request(`https://app.test/api/agents/${AGENT_ID}`, {
          body: validDefinitionBody({ name: "Updated" }),
          method: "PUT",
        }),
        AGENT_ID
      );
      assert.equal(response.status, 200);
      assert.equal(
        JSON.stringify(await response.json()).includes("sensitive"),
        false
      );
      assert.equal(fixture.after.length, 1);
      await fixture.after[0]();
      assert.deepEqual(fixture.logs, []);
    })
  );
  assert.equal(reconciled, 1);
});

test("agent, run, and harness reads preserve their v1 envelopes", async () => {
  const fixture = handlers();
  const [agents, agent, updated, deleted, runs, runRead, harnesses] =
    await Promise.all([
      fixture.handlers.listAgents(new Request("https://app.test/api/agents")),
      fixture.handlers.getAgent(
        new Request(`https://app.test/api/agents/${AGENT_ID}`),
        AGENT_ID
      ),
      fixture.handlers.updateAgent(
        new Request(`https://app.test/api/agents/${AGENT_ID}`, {
          body: validDefinitionBody({ name: "Updated" }),
          method: "PUT",
        }),
        AGENT_ID
      ),
      fixture.handlers.deleteAgent(
        new Request(`https://app.test/api/agents/${AGENT_ID}`, {
          method: "DELETE",
        }),
        AGENT_ID
      ),
      fixture.handlers.listAgentRuns(
        new Request(`https://app.test/api/agents/${AGENT_ID}/runs`),
        AGENT_ID
      ),
      fixture.handlers.getRun(
        new Request(`https://app.test/api/runs/${RUN_ID}`),
        RUN_ID
      ),
      fixture.handlers.getHarnesses(
        new Request("https://app.test/api/harnesses")
      ),
    ]);

  for (const response of [
    agents,
    agent,
    updated,
    deleted,
    runs,
    runRead,
    harnesses,
  ]) {
    assert.equal(response.status, 200);
  }
  assert.deepEqual(await agents.json(), { agents: [definition()] });
  assert.deepEqual(await agent.json(), { agent: definition() });
  assert.deepEqual(await updated.json(), {
    agent: definition({ name: "Updated" }),
  });
  assert.deepEqual(await deleted.json(), { ok: true });
  assert.deepEqual(await runs.json(), {
    apiVersion: AGENT_RUNNER_API_VERSION,
    runs: [run()],
  });
  assert.deepEqual(await runRead.json(), {
    apiVersion: AGENT_RUNNER_API_VERSION,
    run: run(),
  });
  assert.deepEqual(await harnesses.json(), {
    harnesses: [
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
  });
});

test("live event reads start reconciliation before the stream closes", async () => {
  let reconciled = 0;
  const live = run({ status: "running" });
  const fixture = handlers({
    service: service({
      getRun: async () => ({ kind: "found", run: live }),
      listAgentRuns: async () => ({ kind: "found", runs: [live] }),
      readRunEvents: async () => ({
        events: [],
        kind: "found",
        terminal: false,
      }),
      reconcileAndDispatch: () => {
        reconciled += 1;
        return Promise.resolve(counts());
      },
    }),
  });

  await fixture.handlers.getRun(
    new Request(`https://app.test/api/runs/${RUN_ID}`),
    RUN_ID
  );
  await fixture.handlers.listAgentRuns(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`),
    AGENT_ID
  );
  const eventResponse = await fixture.handlers.getRunEvents(
    new Request(`https://app.test/api/runs/${RUN_ID}/events`),
    RUN_ID
  );

  assert.equal(fixture.after.length, 3);
  await Promise.resolve();
  assert.equal(reconciled, 1);
  await Promise.all(fixture.after.map((callback) => callback()));
  assert.equal(reconciled, 3);
  await eventResponse.body?.cancel();

  const terminalRun = run({
    completedAt: "2026-08-28T15:01:00.000Z",
    status: "completed",
  });
  const terminal = handlers({
    service: service({
      getRun: async () => ({ kind: "found", run: terminalRun }),
      listAgentRuns: async () => ({ kind: "found", runs: [terminalRun] }),
      readRunEvents: async () => ({
        events: [],
        kind: "found",
        terminal: true,
      }),
    }),
  });

  await terminal.handlers.getRun(
    new Request(`https://app.test/api/runs/${RUN_ID}`),
    RUN_ID
  );
  await terminal.handlers.listAgentRuns(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`),
    AGENT_ID
  );
  const terminalEventResponse = await terminal.handlers.getRunEvents(
    new Request(`https://app.test/api/runs/${RUN_ID}/events`),
    RUN_ID
  );

  assert.equal(terminal.after.length, 0);
  await terminalEventResponse.body?.cancel();
});

test("agent and run IDs reject malformed values without reaching service methods", async () => {
  let reads = 0;
  const fixture = handlers({
    service: service({
      getAgent: () => {
        reads += 1;
        return Promise.resolve({ agent: definition(), kind: "found" as const });
      },
    }),
  });

  const response = await fixture.handlers.getAgent(
    new Request("https://app.test/api/agents/not-an-id"),
    "not-an-id"
  );

  assert.equal(response.status, 400);
  assert.equal(reads, 0);
});

test("cross-tenant/missing resources remain nondisclosing 404s", async () => {
  let stops = 0;
  const fixture = handlers({
    service: service({
      deleteAgent: async () => ({ kind: "not_found" }),
      getAgent: async () => ({ kind: "not_found" }),
      getRun: async () => ({ kind: "not_found" }),
      listAgentRuns: async () => ({ kind: "not_found" }),
      readRunEvents: async () => ({ kind: "not_found" }),
      stopRun: () => {
        stops += 1;
        return Promise.resolve({ kind: "not_found" as const });
      },
      updateAgent: async () => ({ kind: "not_found" }),
    }),
  });

  const [agent, updated, deleted, runs, runRead, events, stop] =
    await Promise.all([
      fixture.handlers.getAgent(
        new Request(`https://app.test/api/agents/${AGENT_ID}`),
        AGENT_ID
      ),
      fixture.handlers.updateAgent(
        new Request(`https://app.test/api/agents/${AGENT_ID}`, {
          body: validDefinitionBody(),
          method: "PUT",
        }),
        AGENT_ID
      ),
      fixture.handlers.deleteAgent(
        new Request(`https://app.test/api/agents/${AGENT_ID}`, {
          method: "DELETE",
        }),
        AGENT_ID
      ),
      fixture.handlers.listAgentRuns(
        new Request(`https://app.test/api/agents/${AGENT_ID}/runs`),
        AGENT_ID
      ),
      fixture.handlers.getRun(
        new Request(`https://app.test/api/runs/${RUN_ID}`),
        RUN_ID
      ),
      fixture.handlers.getRunEvents(
        new Request(`https://app.test/api/runs/${RUN_ID}/events`),
        RUN_ID
      ),
      fixture.handlers.stopRun(
        new Request(`https://app.test/api/runs/${RUN_ID}/stop`, {
          method: "POST",
        }),
        RUN_ID
      ),
    ]);

  for (const response of [
    agent,
    updated,
    deleted,
    runs,
    runRead,
    events,
    stop,
  ]) {
    assert.equal(response.status, 404);
  }
  assert.equal(
    ((await agent.json()) as { error: { code: string } }).error.code,
    "not_found"
  );
  assert.equal(
    ((await updated.json()) as { error: { code: string } }).error.code,
    "not_found"
  );
  assert.equal(
    ((await deleted.json()) as { error: { code: string } }).error.code,
    "not_found"
  );
  assert.equal(
    ((await runs.json()) as { error: { code: string } }).error.code,
    "not_found"
  );
  assert.equal(
    ((await runRead.json()) as { error: { code: string } }).error.code,
    "run_not_found"
  );
  assert.equal(
    ((await events.json()) as { error: { code: string } }).error.code,
    "run_not_found"
  );
  assert.equal(
    ((await stop.json()) as { error: { code: string } }).error.code,
    "run_not_found"
  );
  assert.equal(stops, 1);
});

test("run start returns 202 and schedules bounded recovery for a created run", async () => {
  let reconciled = 0;
  const fixture = handlers({
    service: service({
      reconcileAndDispatch: () => {
        reconciled += 1;
        return Promise.resolve(counts());
      },
    }),
  });
  const response = await fixture.handlers.startAgentRun(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      method: "POST",
    }),
    AGENT_ID
  );

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    apiVersion: AGENT_RUNNER_API_VERSION,
    run: run(),
  });
  assert.equal(fixture.after.length, 1);
  await fixture.after[0]();
  assert.equal(reconciled, 1);
  assert.equal(fixture.admissions.at(-1)?.route, "runner_run_start");
});

test("run start returns 202 without scheduling duplicate results", async () => {
  let reconciled = 0;
  const fixture = handlers({
    service: service({
      reconcileAndDispatch: () => {
        reconciled += 1;
        return Promise.resolve(counts());
      },
      startRun: () =>
        Promise.resolve({
          admission: "duplicate",
          kind: "accepted",
          run: run({
            id: "55555555-6666-4777-8888-999999999999",
          }),
        }),
    }),
  });

  const response = await fixture.handlers.startAgentRun(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      method: "POST",
    }),
    AGENT_ID
  );

  assert.equal(response.status, 202);
  assert.equal(
    ((await response.json()) as { run: { id: string } }).run.id,
    "55555555-6666-4777-8888-999999999999"
  );
  assert.equal(fixture.after.length, 0);
  assert.equal(reconciled, 0);
});

test("run start returns before a pending claimed dispatch and hides scheduling authority", async () => {
  const authority = {
    expectedVersion: 1,
    leaseToken: "opaque-http-claim",
    runId: RUN_ID,
  } as RunnerDispatchAuthority;
  const claimed = {
    authority,
    run: { id: RUN_ID },
  } as unknown as RunnerClaimedDispatch;
  let dispatches = 0;
  let resolveDispatch: (() => void) | undefined;
  const dispatchPending = new Promise<void>((resolve) => {
    resolveDispatch = resolve;
  });
  let scheduled: void | Promise<void> = Promise.resolve();
  const fixture = handlers({
    after: (task) => {
      scheduled =
        typeof task === "function" ? task() : task.then(() => undefined);
    },
    service: service({
      dispatchClaim: (value) => {
        dispatches += 1;
        assert.equal(value, claimed);
        assert.equal(value.authority, authority);
        return dispatchPending.then(() => ({
          kind: "started" as const,
          runId: RUN_ID,
        }));
      },
      reconcileAndDispatch: () =>
        Promise.reject(new Error("claimed run must not reconcile")),
      startRun: () =>
        Promise.resolve({
          admission: "claimed" as const,
          claimed,
          kind: "accepted" as const,
          run: run(),
        }),
    }),
  });

  const response = await fixture.handlers.startAgentRun(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      method: "POST",
    }),
    AGENT_ID
  );

  assert.equal(response.status, 202);
  assert.equal(dispatches, 1);
  const json = await response.json();
  assert.deepEqual(json, {
    apiVersion: AGENT_RUNNER_API_VERSION,
    run: run(),
  });
  assert.equal(JSON.stringify(json).includes("authority"), false);
  assert.equal(JSON.stringify(json).includes("scheduling"), false);
  assert.equal(JSON.stringify(json).includes("admission"), false);
  assert.equal(JSON.stringify(json).includes("opaque-http-claim"), false);

  resolveDispatch?.();
  await scheduled;
});

test("run start passes only the trusted authenticated auth version to the service", async () => {
  let startArguments: unknown[] = [];
  const fixture = handlers({
    service: service({
      startRun: ((...arguments_: unknown[]) => {
        startArguments = arguments_;
        return Promise.resolve({
          admission: "duplicate",
          kind: "accepted",
          run: run(),
        });
      }) as RunnerService["startRun"],
    }),
  });

  const response = await fixture.handlers.startAgentRun(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
      body: JSON.stringify({
        authVersion: 999,
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      method: "POST",
    }),
    AGENT_ID
  );

  assert.equal(response.status, 400);
  assert.equal(startArguments.length, 0);

  const accepted = await fixture.handlers.startAgentRun(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      method: "POST",
    }),
    AGENT_ID
  );

  assert.equal(accepted.status, 202);
  assert.equal(startArguments[1], subscriber.authVersion);
  assert.equal(startArguments.includes(999), false);
});

test("delete preserves busy, stale version, and permanent provider failures", async () => {
  const outcomes = [
    [{ kind: "busy" }, 409, "busy", true],
    [{ kind: "stale_version" }, 409, "stale_version", true],
    [
      { kind: "unavailable", source: "provider" },
      503,
      "provider_unavailable",
      true,
    ],
    [
      { kind: "unavailable", source: "database" },
      503,
      "runner_unavailable",
      true,
    ],
    [{ kind: "provider_rejected" }, 422, "provider_rejected", false],
  ] as const;

  await Promise.all(
    outcomes.map(async ([outcome, status, code, retryable]) => {
      const fixture = handlers({
        service: service({
          deleteAgent: () => Promise.resolve(outcome as never),
        }),
      });
      const response = await fixture.handlers.deleteAgent(
        new Request(`https://app.test/api/agents/${AGENT_ID}`, {
          method: "DELETE",
        }),
        AGENT_ID
      );
      const body = (await response.json()) as {
        error: { code: string; retryable: boolean };
      };

      assert.equal(response.status, status);
      assert.equal(body.error.code, code);
      assert.equal(body.error.retryable, retryable);
    })
  );
});

test("create and update map retryable database failures without exposing details", async () => {
  const fixture = handlers({
    service: service({
      createAgent: async () => ({
        kind: "unavailable",
        source: "database",
      }),
      updateAgent: async () => ({
        kind: "unavailable",
        source: "database",
      }),
    }),
  });

  const [created, updated] = await Promise.all([
    fixture.handlers.createAgent(
      new Request("https://app.test/api/agents", {
        body: validDefinitionBody(),
        method: "POST",
      })
    ),
    fixture.handlers.updateAgent(
      new Request(`https://app.test/api/agents/${AGENT_ID}`, {
        body: validDefinitionBody(),
        method: "PUT",
      }),
      AGENT_ID
    ),
  ]);

  const responses = await Promise.all(
    [created, updated].map(async (response) => ({
      body: await response.json(),
      status: response.status,
    }))
  );
  for (const response of responses) {
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      apiVersion: AGENT_RUNNER_API_VERSION,
      error: {
        code: "runner_unavailable",
        message: "Runner service is temporarily unavailable. Try again later.",
        retryable: true,
      },
      requestId: REQUEST_ID,
    });
  }
});

test("update preserves a stale version conflict", async () => {
  const fixture = handlers({
    service: service({
      updateAgent: async () => ({ kind: "stale_version" }) as never,
    }),
  });
  const response = await fixture.handlers.updateAgent(
    new Request(`https://app.test/api/agents/${AGENT_ID}`, {
      body: validDefinitionBody(),
      method: "PUT",
    }),
    AGENT_ID
  );

  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "stale_version"
  );
});

test("update maps an active-run conflict to the stable busy response", async () => {
  const fixture = handlers({
    service: service({
      updateAgent: async () => ({ kind: "busy" }),
    }),
  });
  const response = await fixture.handlers.updateAgent(
    new Request(`https://app.test/api/agents/${AGENT_ID}`, {
      body: validDefinitionBody(),
      method: "PUT",
    }),
    AGENT_ID
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    apiVersion: AGENT_RUNNER_API_VERSION,
    error: {
      code: "busy",
      message: "The agent is busy. Try again later.",
      retryable: true,
    },
    requestId: REQUEST_ID,
  });
});

test("run start maps operation, capacity, lifecycle, and admission failures", async () => {
  const expected = [
    ["operation_conflict", 409, "operation_conflict"],
    ["busy", 409, "busy"],
    ["lifecycle_conflict", 409, "agent_decommissioning"],
    ["admission_unavailable", 503, "admission_unavailable"],
  ] as const;
  await Promise.all(
    expected.map(async ([code, status, responseCode]) => {
      const fixture = handlers({
        service: service({
          startRun: () =>
            Promise.resolve({
              code,
              kind: "refused" as const,
              retryable: code !== "operation_conflict",
            }),
        }),
      });
      const response = await fixture.handlers.startAgentRun(
        new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
          body: JSON.stringify({
            operationId: OPERATION_ID,
            task: "Do the thing.",
          }),
          method: "POST",
        }),
        AGENT_ID
      );
      assert.equal(response.status, status);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        responseCode
      );
    })
  );
});

test("run start maps an unsupported harness fence to the public error", async () => {
  const fixture = handlers({
    service: service({
      startRun: async () => ({ kind: "unsupported_harness" }) as never,
    }),
  });
  const response = await fixture.handlers.startAgentRun(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      method: "POST",
    }),
    AGENT_ID
  );

  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "harness_unsupported"
  );
  assert.equal(fixture.after.length, 0);
});

test("SSE validates cursors, resumes without duplicates, and uses exact headers", async () => {
  const first: RunEvent = {
    at: "2026-08-28T15:00:00.000Z",
    id: 1,
    operationId: OPERATION_ID,
    runId: RUN_ID,
    type: "accepted",
  };
  const second: RunEvent = {
    at: "2026-08-28T15:00:01.000Z",
    id: 2,
    status: "running",
    type: "status",
  };
  const fixture = handlers({
    service: service({
      readRunEvents: async (_principal, _runId, cursor) => ({
        events: [first, second].filter((event) => event.id > cursor),
        kind: "found",
        terminal: true,
      }),
    }),
  });

  const invalid = await fixture.handlers.getRunEvents(
    new Request(`https://app.test/api/runs/${RUN_ID}/events`, {
      headers: { "last-event-id": "-1" },
    }),
    RUN_ID
  );
  assert.equal(invalid.status, 400);
  assert.equal(
    ((await invalid.json()) as { error: { code: string } }).error.code,
    "invalid_event_cursor"
  );

  const response = await fixture.handlers.getRunEvents(
    new Request(`https://app.test/api/runs/${RUN_ID}/events`, {
      headers: { "last-event-id": "1" },
    }),
    RUN_ID
  );
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8"
  );
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.equal(response.headers.get("connection"), "keep-alive");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const body = await response.text();
  assert.match(body, /id: 2/);
  assert.doesNotMatch(body, /id: 1/);
  assert.equal((body.match(/id: 2/g) ?? []).length, 1);
});

test("stop accepts an empty body, returns its snapshot, and defers reconciliation", async () => {
  let reconciled = 0;
  const fixture = handlers({
    service: service({
      reconcileAndDispatch: () => {
        reconciled += 1;
        return Promise.resolve(counts());
      },
    }),
  });

  const response = await fixture.handlers.stopRun(
    new Request(`https://app.test/api/runs/${RUN_ID}/stop`, { method: "POST" }),
    RUN_ID
  );

  assert.equal(response.status, 200);
  assert.equal(
    ((await response.json()) as { run: { status: string } }).run.status,
    "cancelled"
  );
  assert.equal(fixture.after.length, 1);
  await fixture.after[0]();
  assert.equal(reconciled, 1);
});

test("stop maps accepted, stale, cleanup, and unavailable outcomes explicitly", async () => {
  const outcomes = [
    [
      {
        kind: "in_progress",
        run: run(),
        scheduleReconciliation: true,
      },
      202,
      null,
    ],
    [{ kind: "stale_version" }, 409, "stale_version"],
    [{ kind: "unavailable", source: "database" }, 503, "runner_unavailable"],
    [{ kind: "unavailable", source: "provider" }, 503, "provider_unavailable"],
    [
      { kind: "cleanup_required", scheduleReconciliation: true },
      503,
      "cleanup_required",
    ],
    [
      { kind: "sandbox_reset_required", scheduleReconciliation: true },
      503,
      "cleanup_required",
    ],
  ] as const;

  await Promise.all(
    outcomes.map(async ([outcome, status, code]) => {
      const fixture = handlers({
        service: service({
          stopRun: async () => outcome as never,
        }),
      });
      const response = await fixture.handlers.stopRun(
        new Request(`https://app.test/api/runs/${RUN_ID}/stop`, {
          method: "POST",
        }),
        RUN_ID
      );
      assert.equal(response.status, status);
      const body = (await response.json()) as {
        error?: { code: string; retryable: boolean };
        run?: { id: string; status: string };
      };
      if (code) {
        assert.equal(body.error?.code, code);
        assert.equal(body.error?.retryable, true);
      } else {
        assert.equal(body.run?.id, RUN_ID);
        assert.equal(body.run?.status, "queued");
      }
    })
  );
});

test("tenant prewarm returns 204 with no agent and 202 without credential data", async () => {
  const none = handlers({
    service: service({ prewarmMostRecent: async () => ({ kind: "none" }) }),
  });
  const empty = await none.handlers.prewarmTenant(
    new Request("https://app.test/api/tenant/prewarm", { method: "POST" })
  );
  assert.equal(empty.status, 204);

  const warmed = handlers();
  const response = await warmed.handlers.prewarmTenant(
    new Request("https://app.test/api/tenant/prewarm", { method: "POST" })
  );
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    agentId: AGENT_ID,
    warm: {
      status: "ready",
      updatedAt: "2026-08-28T15:00:00.000Z",
    },
  });
});

test("tenant prewarm maps concurrent, stale, provider, and database outcomes", async () => {
  const outcomes = [
    [
      {
        agentId: AGENT_ID,
        kind: "in_progress",
        warm: {
          status: "provisioning",
          updatedAt: "2026-08-28T15:00:00.000Z",
        },
      },
      202,
      null,
    ],
    [{ kind: "not_found" }, 204, null],
    [{ kind: "stale_version" }, 409, "stale_version"],
    [{ kind: "unavailable", source: "provider" }, 503, "provider_unavailable"],
    [{ kind: "unavailable", source: "database" }, 503, "runner_unavailable"],
    [{ kind: "provider_rejected" }, 422, "provider_rejected"],
  ] as const;

  await Promise.all(
    outcomes.map(async ([outcome, status, code]) => {
      const fixture = handlers({
        service: service({
          prewarmMostRecent: async () => outcome as never,
        }),
      });
      const response = await fixture.handlers.prewarmTenant(
        new Request("https://app.test/api/tenant/prewarm", { method: "POST" })
      );
      assert.equal(response.status, status);
      if (code) {
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          code
        );
      } else if (status === 202) {
        assert.deepEqual(await response.json(), {
          agentId: AGENT_ID,
          warm: {
            status: "provisioning",
            updatedAt: "2026-08-28T15:00:00.000Z",
          },
        });
      }
    })
  );
});

test("tenant prewarm maps an unsupported harness fence to the public error", async () => {
  const fixture = handlers({
    service: service({
      prewarmMostRecent: async () => ({ kind: "unsupported_harness" }) as never,
    }),
  });
  const response = await fixture.handlers.prewarmTenant(
    new Request("https://app.test/api/tenant/prewarm", { method: "POST" })
  );

  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "harness_unsupported"
  );
  assert.equal(fixture.after.length, 0);
});

test("diagnostics and reconciliation use only their operator service and safe outputs", async () => {
  const fixture = handlers();
  const diagnostic = await fixture.handlers.diagnoseSandbox(
    new Request("https://app.test/api/diagnostics/sandbox", { method: "POST" })
  );
  const reconcile = await fixture.handlers.reconcile(
    new Request("https://app.test/api/internal/runner-reconcile", {
      method: "POST",
    })
  );

  assert.equal(diagnostic.status, 200);
  assert.deepEqual(await diagnostic.json(), {
    exitCode: 0,
    ok: true,
    output: "coven-agents",
  });
  assert.equal(reconcile.status, 200);
  assert.deepEqual(await reconcile.json(), counts());
  assert.equal(fixture.diagnosticRequests(), 1);
  assert.deepEqual(fixture.diagnosticNames, [DIAGNOSTIC_NAME]);
  assert.deepEqual(fixture.logs, []);
  assert.equal(fixture.operatorRequests(), 1);
  assert.equal(fixture.serviceRequests(), 0);
});

test("reconciliation returns validated overlap skips and does not depend on after", async () => {
  await Promise.all(
    [
      null,
      () => {
        throw new Error("after unavailable");
      },
    ].flatMap((after) =>
      ["GET", "POST"].map(async (method) => {
        const fixture = handlers({
          after,
          service: service({
            reconcileAndDispatch: () =>
              Promise.resolve({
                ...counts(),
                dispatched: 0,
                execution: "skipped",
                reason: "overlap",
              }),
          }),
        });

        const response = await fixture.handlers.reconcile(
          new Request("https://app.test/api/internal/runner-reconcile", {
            method,
          })
        );

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), {
          ...counts(),
          dispatched: 0,
          execution: "skipped",
          reason: "overlap",
        });
      })
    )
  );
});

test("overlapping GET and POST execute exactly one leased reconciliation", async () => {
  const { runLeasedReconciliation } = await import("./runtime");
  let activeLease: Readonly<{
    expiresAt: Date;
    fence: number;
    ownerToken: string;
  }> | null = null;
  let owner = 0;
  let reconcileCalls = 0;
  let finishFirst: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const store = {
    acquireReconciliationLease: (
      _operator: unknown,
      input: { ownerToken: string }
    ) => {
      if (activeLease) {
        return Promise.resolve({ kind: "held" as const });
      }
      activeLease = {
        expiresAt: new Date("2026-08-28T21:40:00.000Z"),
        fence: owner,
        ownerToken: input.ownerToken,
      };
      return Promise.resolve({
        kind: "acquired" as const,
        lease: activeLease,
      });
    },
    releaseReconciliationLease: (
      _operator: unknown,
      lease: Readonly<{ fence: number; ownerToken: string }>
    ) => {
      if (
        activeLease?.ownerToken !== lease.ownerToken ||
        activeLease.fence !== lease.fence
      ) {
        return Promise.resolve({ kind: "stale" as const });
      }
      activeLease = null;
      return Promise.resolve({ kind: "released" as const });
    },
  };
  const runner = service({
    reconcileAndDispatch: () =>
      runLeasedReconciliation({
        ownerToken: () => {
          owner += 1;
          return `request-${owner}`;
        },
        reconcile: async () => {
          reconcileCalls += 1;
          signalStarted?.();
          await finish;
          return counts();
        },
        store,
      }),
  });
  const fixture = handlers({ service: runner });

  const get = fixture.handlers.reconcile(
    new Request("https://app.test/api/internal/runner-reconcile", {
      method: "GET",
    })
  );
  await started;
  const post = await fixture.handlers.reconcile(
    new Request("https://app.test/api/internal/runner-reconcile", {
      method: "POST",
    })
  );
  finishFirst?.();
  const getResponse = await get;

  assert.equal(reconcileCalls, 1);
  assert.equal(getResponse.status, 200);
  assert.equal(post.status, 200);
  assert.equal(
    ((await getResponse.json()) as { execution: string }).execution,
    "executed"
  );
  assert.deepEqual(await post.json(), {
    ...counts(),
    dispatched: 0,
    execution: "skipped",
    reason: "overlap",
  });
});

test("GET and POST apply abuse enforcement before reconciliation secrets", async () => {
  await Promise.all(
    ["GET", "POST"].map(async (method) => {
      const events: string[] = [];
      const runner = service({
        reconcileAndDispatch: () =>
          Promise.reject(new Error("reconciliation must not run")),
      });
      const runnerHandlers = createRunnerHttpHandlers({
        auth: {
          authorizeDiagnostic: () => ({ kind: "unauthorized" }),
          authorizeReconcile: () => {
            events.push("secret");
            return { kind: "unauthorized" };
          },
          authorizeSubscriber: async () => subscriber,
        },
        createOperatorService: () => runner,
        createService: () => runner,
        diagnoseSandbox: () => runner.diagnoseSandbox(),
        enforceAbuse: () => {
          events.push("abuse");
          return Promise.resolve({ kind: "allowed" });
        },
        ipAddress: () => "203.0.113.10",
      });

      const response = await runnerHandlers.reconcile(
        new Request("https://app.test/api/internal/runner-reconcile", {
          method,
        })
      );

      assert.equal(response.status, 401);
      assert.deepEqual(events, ["abuse", "secret"]);
    })
  );
});

test("reconciliation errors never serialize provider or database causes", async () => {
  await Promise.all(
    ["provider=private-detail", "database=private-detail"].map(
      async (cause) => {
        const fixture = handlers({
          service: service({
            reconcileAndDispatch: () =>
              Promise.reject(
                new RunnerServiceError(
                  "reconcile_unavailable",
                  "Runner reconciliation is unavailable.",
                  true,
                  { cause: new Error(cause) }
                )
              ),
          }),
        });
        const response = await fixture.handlers.reconcile(
          new Request("https://app.test/api/internal/runner-reconcile", {
            method: "POST",
          })
        );
        const serialized = JSON.stringify(await response.json());

        assert.equal(response.status, 503);
        assert.equal(serialized.includes(cause), false);
        assert.equal(serialized.includes("private-detail"), false);
      }
    )
  );
});

test("diagnostic construction failure is isolated from health, CRUD, runs, and reconciliation", async () => {
  let diagnosticRequests = 0;
  const runner = service();
  const runnerHandlers = createRunnerHttpHandlers({
    auth: authorizedAuth(),
    createOperatorService: () => runner,
    createRequestId: () => REQUEST_ID,
    createService: () => runner,
    diagnoseSandbox: () => {
      diagnosticRequests += 1;
      throw new RunnerServiceError(
        "diagnostic_unavailable",
        "Daytona diagnostic is unavailable."
      );
    },
    enforceAbuse: () => Promise.resolve({ kind: "allowed" }),
    ipAddress: () => "203.0.113.10",
  });

  const diagnostic = await runnerHandlers.diagnoseSandbox(
    new Request("https://app.test/api/diagnostics/sandbox", { method: "POST" })
  );
  const health = await runnerHandlers.health(
    new Request("https://app.test/api/health")
  );
  const created = await runnerHandlers.createAgent(
    new Request("https://app.test/api/agents", {
      body: validDefinitionBody(),
      method: "POST",
    })
  );
  const started = await runnerHandlers.startAgentRun(
    new Request(`https://app.test/api/agents/${AGENT_ID}/runs`, {
      body: JSON.stringify({
        operationId: OPERATION_ID,
        task: "Do the thing.",
      }),
      method: "POST",
    }),
    AGENT_ID
  );
  const reconciled = await runnerHandlers.reconcile(
    new Request("https://app.test/api/internal/runner-reconcile", {
      method: "POST",
    })
  );

  assert.equal(diagnostic.status, 503);
  assert.equal(health.status, 200);
  assert.equal(created.status, 201);
  assert.equal(started.status, 202);
  assert.equal(reconciled.status, 200);
  assert.equal(diagnosticRequests, 1);
});

test("invalid operator bearer probes consume abuse budget before secret validation", async (context) => {
  await Promise.all(
    operatorRouteCases.map((route) =>
      context.test(route.name, async () => {
        const events: string[] = [];
        const response = await route.invoke(
          orderedOperatorHandlers(
            events,
            route.abuseRoute,
            { kind: "unauthorized" },
            { kind: "allowed" }
          ),
          orderedOperatorRequest(events)
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), {
          apiVersion: AGENT_RUNNER_API_VERSION,
          error: {
            code: "unauthorized",
            message: "Operator token was rejected.",
            retryable: false,
          },
          requestId: REQUEST_ID,
        });
        assert.deepEqual(events, ["abuse", "secret"]);
      })
    )
  );
});

test("rate-limited invalid operator probes stop before secret validation", async (context) => {
  await Promise.all(
    operatorRouteCases.map((route) =>
      context.test(route.name, async () => {
        const events: string[] = [];
        const response = await route.invoke(
          orderedOperatorHandlers(
            events,
            route.abuseRoute,
            { kind: "unauthorized" },
            {
              kind: "denied",
              responseStatus: 429,
              retryAfterSeconds: 7,
            }
          ),
          orderedOperatorRequest(events)
        );

        assert.equal(response.status, 429);
        assert.equal(response.headers.get("retry-after"), "7");
        assert.deepEqual(events, ["abuse"]);
      })
    )
  );
});

test("valid operator requests perform authorized work only after abuse and secret checks", async (context) => {
  await Promise.all(
    operatorRouteCases.map((route) =>
      context.test(route.name, async () => {
        const events: string[] = [];
        const response = await route.invoke(
          orderedOperatorHandlers(
            events,
            route.abuseRoute,
            { kind: "allowed" },
            { kind: "allowed" }
          ),
          orderedOperatorRequest(events)
        );

        assert.equal(response.status, 200);
        assert.deepEqual(events, [
          "abuse",
          "secret",
          "body",
          ...(route.abuseRoute === "runner_diagnostic" ? ["name"] : []),
          "service",
          "provider",
        ]);
      })
    )
  );
});

test("secret operator authentication and unavailable abuse fail without provider access", async () => {
  const auth: RunnerAuth = {
    authorizeDiagnostic: () => ({ kind: "unauthorized" }),
    authorizeReconcile: () => ({ kind: "unavailable" }),
    authorizeSubscriber: async () => subscriber,
  };
  const fixture = handlers({ auth });
  const unauthorized = await fixture.handlers.diagnoseSandbox(
    new Request("https://app.test/api/diagnostics/sandbox", { method: "POST" })
  );
  const unavailable = await fixture.handlers.reconcile(
    new Request("https://app.test/api/internal/runner-reconcile", {
      method: "POST",
    })
  );

  assert.equal(unauthorized.status, 401);
  assert.equal(unavailable.status, 503);
  assert.equal(fixture.diagnosticRequests(), 0);
  assert.equal(fixture.operatorRequests(), 0);

  const abuse = handlers({
    admission: { kind: "unavailable", responseStatus: 503 },
  });
  const response = await abuse.handlers.getHarnesses(
    new Request("https://app.test/api/harnesses")
  );
  assert.equal(response.status, 503);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "abuse_control_unavailable"
  );
});

test("operator abuse refusal happens before parsing or constructing its service", async () => {
  const fixture = handlers({
    admission: {
      kind: "denied",
      responseStatus: 429,
      retryAfterSeconds: 7,
    },
  });
  const request = new Request("https://app.test/api/diagnostics/sandbox", {
    body: "not-json",
    method: "POST",
  });

  const response = await fixture.handlers.diagnoseSandbox(request);

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "7");
  assert.equal(request.bodyUsed, false);
  assert.equal(fixture.diagnosticRequests(), 0);
  assert.equal(fixture.operatorRequests(), 0);
  assert.deepEqual(fixture.admissions, [
    {
      failClosed: true,
      ip: "203.0.113.10",
      route: "runner_diagnostic",
    },
  ]);
});

test("reconciliation exposes validated counts only and hides malformed values", async () => {
  const fixture = handlers({
    service: service({
      reconcileAndDispatch: () =>
        Promise.resolve({
          ...counts(),
          terminalLeaseCleaned: Number.NaN,
        }),
    }),
  });

  const response = await fixture.handlers.reconcile(
    new Request("https://app.test/api/internal/runner-reconcile", {
      method: "POST",
    })
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    apiVersion: AGENT_RUNNER_API_VERSION,
    error: {
      code: "reconcile_unavailable",
      message: "Please try again later.",
      retryable: true,
    },
    requestId: REQUEST_ID,
  });
});

test("unrecognized failures are sanitized in their response and logs", async () => {
  const secret = "credential=do-not-log";
  const fixture = handlers({
    service: service({
      listAgents: () => Promise.reject(new Error(secret)),
    }),
  });

  const response = await fixture.handlers.listAgents(
    new Request("https://app.test/api/agents")
  );
  const serialized = JSON.stringify(await response.json());

  assert.equal(response.status, 500);
  assert.equal(serialized.includes(secret), false);
  assert.equal(JSON.stringify(fixture.logs).includes(secret), false);
  assert.deepEqual(fixture.logs, [{ name: "Error" }]);
});
