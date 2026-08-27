import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  type AgentDefinition,
  base64UrlEncode,
  type RunnerClaims,
  type RunSnapshot,
  TOKEN_LIFETIME_SECONDS,
} from "@opencoven/agent-contracts";
import { tenantAdmissionHash } from "./admission";
import {
  type CloudRunnerAgent,
  type CloudRunnerDirectory,
  createCloudRunner,
} from "./routes";
import {
  type AdmissionCleanupGuard,
  AgentDecommissioningError,
  hashOperation,
} from "./run-state";

const TOKEN = "test-token";
const MINE = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const THEIRS = "9c1b7d2f-5a6b-4c90-8f1a-0f4e1f4d4a2e";
const CALLER_TENANT = "tenant_under_test";
/** A run owned by another tenant. */
const RUN_ID = "11111111-2222-4333-8444-555555555555";
/** A run owned by the caller, so the negative tests have a control. */
const MY_RUN_ID = "22222222-3333-4444-8555-666666666666";

class RecordingLimiter {
  readonly keys: string[] = [];
  private readonly result: { success: boolean } | Error;

  constructor(result: { success: boolean } | Error = { success: true }) {
    this.result = result;
  }

  limit(input: { key: string }): Promise<{ success: boolean }> {
    this.keys.push(input.key);
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function mint(
  privateKey: CryptoKey,
  claims: RunnerClaims
): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Key generation and signing are async, so the suite's keypair and minted
 * token are built lazily behind a cached promise rather than at module load
 * (top-level await is unavailable here) or freshly per call (which would
 * make every test mint against a different key/token pair).
 */
let suiteKeyPair: Promise<CryptoKeyPair> | null = null;
function getKeyPair(): Promise<CryptoKeyPair> {
  if (!suiteKeyPair) {
    suiteKeyPair = keyPair();
  }
  return suiteKeyPair;
}

let suiteToken: Promise<string> | null = null;
function identityToken(): Promise<string> {
  if (!suiteToken) {
    suiteToken = getKeyPair().then((pair) =>
      mint(pair.privateKey, {
        exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
        plan: "subscriber",
        sub: "user-1",
        tenant: CALLER_TENANT,
      })
    );
  }
  return suiteToken;
}

let suiteVerifyKey: Promise<string> | null = null;
function verifyKeySpki(): Promise<string> {
  if (!suiteVerifyKey) {
    suiteVerifyKey = getKeyPair().then(async (pair) => {
      const exported = await crypto.subtle.exportKey("spki", pair.publicKey);
      return base64UrlEncode(new Uint8Array(exported));
    });
  }
  return suiteVerifyKey;
}

const environmentPromise = verifyKeySpki().then((spki) => ({
  AGENT_CONTROL_TOKEN: TOKEN,
  ALLOWED_ORIGIN: "*",
  EDGE_ABUSE_KEY_SECRET: "test-edge-abuse-secret",
  EDGE_REQUEST_LIMITER: new RecordingLimiter(),
  RUNNER_VERIFY_KEY: spki,
  TENANT_MUTATION_LIMITER: new RecordingLimiter(),
  TENANT_RUN_LIMITER: new RecordingLimiter(),
}));

function definition(id: string, tenantId: string): AgentDefinition {
  return {
    backend: "cloud",
    createdAt: "2026-08-20T12:00:00.000Z",
    description: "",
    id,
    instructions: "Do the thing.",
    lastRunAt: null,
    model: "auto",
    name: id === MINE ? "Mine" : "Theirs",
    owner: { kind: "tenant", tenantId },
    runtime: "copilot",
    status: "idle",
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
}

/**
 * `THEIRS` is owned by a tenant the caller is not. The caller's tenant comes
 * from the verified identity claim minted above (`CALLER_TENANT`), so `MINE`
 * is reachable and `THEIRS` must not be.
 */
const agents = new Map<string, AgentDefinition>([
  [MINE, definition(MINE, CALLER_TENANT)],
  [THEIRS, definition(THEIRS, "someone_else")],
]);

let decommissioned: string[] = [];
let stopped: string[] = [];
let warmed: string[] = [];
let configureFailure: Error | null = null;

function runner() {
  decommissioned = [];
  stopped = [];
  warmed = [];

  const directory: CloudRunnerDirectory = {
    list: (tenantId) =>
      [...agents.values()].filter(
        (agent) =>
          agent.owner?.kind === "tenant" && agent.owner.tenantId === tenantId
      ),
    // Resolves to a real owner rather than always the other tenant, so the
    // negative tests cannot pass just because every run route 404s.
    lookupRun: (runId) => (runId === MY_RUN_ID ? MINE : THEIRS),
    registerRun: () => true,
    remove: () => undefined,
    unregisterRun: () => undefined,
    upsert: (value) => value,
  };

  const getYoloAgent = (_environment: unknown, agentId: string) =>
    ({
      configure: (value: AgentDefinition) => {
        if (configureFailure) {
          throw configureFailure;
        }
        return value;
      },
      decommission: () => {
        decommissioned.push(agentId);
      },
      getEventStream: () => ({ events: [], terminal: false }),
      // Returns a real run rather than null. With null the route 404s because
      // the run is missing, so the test would pass whether or not ownership is
      // checked — it has to be reachable for the 404 to mean anything.
      getRun: () => ({
        agentId,
        apiVersion: "2026-08-01",
        commandEvidence: [],
        completedAt: "2026-08-20T12:00:05.000Z",
        createdAt: "2026-08-20T12:00:00.000Z",
        fileEvidence: [],
        id: agentId === MINE ? MY_RUN_ID : RUN_ID,
        operationId: MINE,
        output: "done",
        startedAt: "2026-08-20T12:00:01.000Z",
        status: "completed",
        task: "Fix the tests.",
      }),
      listRuns: () => [
        {
          agentId,
          apiVersion: "2026-08-01",
          commandEvidence: [],
          completedAt: "2026-08-20T12:00:05.000Z",
          createdAt: "2026-08-20T12:00:00.000Z",
          fileEvidence: [],
          id: agentId === MINE ? MY_RUN_ID : RUN_ID,
          operationId: MINE,
          output: "done",
          startedAt: "2026-08-20T12:00:01.000Z",
          status: "completed",
          task: "Fix the tests.",
        },
      ],
      snapshot: () => agents.get(agentId) ?? null,
      stop: (runId: string) => {
        stopped.push(runId);
        return null;
      },
      warm: () => {
        warmed.push(agentId);
        return {
          status: "provisioning",
          updatedAt: "2026-08-20T12:00:00.000Z",
        };
      },
    }) as unknown as CloudRunnerAgent;

  return createCloudRunner({
    getDirectory: () => directory,
    getYoloAgent,
  });
}

async function call(path: string, method = "GET"): Promise<Response> {
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  return runner().fetch(
    new Request(`https://runner.test${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method,
    }),
    environment as never
  );
}

test("source floods are refused before deployment-token verification", async () => {
  const environment = await environmentPromise;
  const edge = new RecordingLimiter({ success: false });
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      headers: { "cf-connecting-ip": "203.0.113.10" },
    }),
    { ...environment, EDGE_REQUEST_LIMITER: edge } as never
  );

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("retry-after"), "60");
  const body = (await response.json()) as {
    apiVersion: string;
    error: { code: string; message: string; retryable: boolean };
    requestId: string;
  };
  assert.deepEqual(
    { apiVersion: body.apiVersion, error: body.error },
    {
      apiVersion: AGENT_RUNNER_API_VERSION,
      error: {
        code: "rate_limited",
        message: "Too many requests. Try again later.",
        retryable: true,
      },
    }
  );
  assert.equal(typeof body.requestId, "string");
  assert.equal(edge.keys.length, 1);
});

test("missing Cloudflare IP metadata consumes the shared source bucket", async () => {
  const environment = await environmentPromise;
  const edge = new RecordingLimiter();
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents"),
    { ...environment, EDGE_REQUEST_LIMITER: edge } as never
  );

  assert.equal(response.status, 401);
  assert.equal(edge.keys.length, 1);
});

test("tenant mutations are refused after identity verification and before body parsing", async () => {
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const mutation = new RecordingLimiter({ success: false });
  const run = new RecordingLimiter();
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      body: "not-json",
      headers: {
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.11",
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    {
      ...environment,
      TENANT_MUTATION_LIMITER: mutation,
      TENANT_RUN_LIMITER: run,
    } as never
  );

  assert.equal(response.status, 429);
  assert.equal(mutation.keys.length, 1);
  assert.equal(run.keys.length, 0);
});

test("paid run starts use the stricter tenant run limiter before body parsing", async () => {
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const mutation = new RecordingLimiter();
  const run = new RecordingLimiter({ success: false });
  const response = await runner().fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: "not-json",
      headers: {
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.12",
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    {
      ...environment,
      TENANT_MUTATION_LIMITER: mutation,
      TENANT_RUN_LIMITER: run,
    } as never
  );

  assert.equal(response.status, 429);
  assert.equal(mutation.keys.length, 0);
  assert.equal(run.keys.length, 1);
});

test("tenant reads consume no mutation or run capacity", async () => {
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const mutation = new RecordingLimiter();
  const run = new RecordingLimiter();
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      headers: {
        authorization: `Bearer ${token}`,
        "cf-connecting-ip": "203.0.113.13",
        "x-runner-token": TOKEN,
      },
    }),
    {
      ...environment,
      TENANT_MUTATION_LIMITER: mutation,
      TENANT_RUN_LIMITER: run,
    } as never
  );

  assert.equal(response.status, 200);
  assert.equal(mutation.keys.length, 0);
  assert.equal(run.keys.length, 0);
});

test("limiter outages fail closed without revealing the failed scope", async () => {
  const environment = await environmentPromise;
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      headers: { "cf-connecting-ip": "203.0.113.14" },
    }),
    {
      ...environment,
      EDGE_REQUEST_LIMITER: new RecordingLimiter(new Error("binding down")),
    } as never
  );

  assert.equal(response.status, 503);
  const body = (await response.json()) as {
    error: { code: string; message: string };
  };
  assert.deepEqual(body.error, {
    code: "abuse_control_unavailable",
    message: "Please try again later.",
    retryable: true,
  });
});

test("a listing only contains the caller's own agents", async () => {
  const response = await call("/api/agents");
  const body = (await response.json()) as { agents: AgentDefinition[] };

  assert.deepEqual(
    body.agents.map((agent) => agent.id),
    [MINE]
  );
});

test("another tenant's agent reads as absent, not forbidden", async () => {
  // 404 rather than 403: a 403 would confirm the id exists for someone else.
  const response = await call(`/api/agents/${THEIRS}`);

  assert.equal(response.status, 404);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "not_found"
  );
});

test("the caller's own agent is still reachable", async () => {
  const response = await call(`/api/agents/${MINE}`);

  assert.equal(response.status, 200);
});

test("configure reports a retryable conflict while decommissioning", async () => {
  configureFailure = new AgentDecommissioningError();
  try {
    const [environment, token] = await Promise.all([
      environmentPromise,
      identityToken(),
    ]);
    const response = await runner().fetch(
      new Request(`https://runner.test/api/agents/${MINE}`, {
        body: JSON.stringify({
          backend: "cloud",
          description: "",
          instructions: "Do the thing.",
          model: "auto",
          name: "Updated",
          runtime: "copilot",
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-runner-token": TOKEN,
        },
        method: "PUT",
      }),
      environment as never
    );

    assert.equal(response.status, 409);
    const body = (await response.json()) as {
      error: { code: string; retryable: boolean };
    };
    assert.deepEqual(body.error, {
      code: "agent_decommissioning",
      message: "Agent decommission is still in progress. Try again later.",
      retryable: true,
    });
  } finally {
    configureFailure = null;
  }
});

test("another tenant's agent cannot be deleted", async () => {
  const response = await call(`/api/agents/${THEIRS}`, "DELETE");

  assert.equal(response.status, 404);
  assert.deepEqual(decommissioned, [], "decommission must not be reached");
});

test("an agent's retained runs are listable", async () => {
  const response = await call(`/api/agents/${MINE}/runs`);

  assert.equal(response.status, 200);
  const body = (await response.json()) as { runs: { id: string }[] };
  assert.deepEqual(
    body.runs.map((run) => run.id),
    [MY_RUN_ID]
  );
});

test("another tenant's run history is not listable", async () => {
  const response = await call(`/api/agents/${THEIRS}/runs`);

  assert.equal(response.status, 404);
});

test("another tenant's agent cannot be run", async () => {
  const response = await call(`/api/agents/${THEIRS}/runs`, "POST");

  assert.equal(response.status, 404);
});

/**
 * The run routes resolve an agent from a run id. Without an ownership check
 * there, holding a run id was enough to read, stream or cancel another
 * tenant's run — the agent routes alone did not cover it.
 */
test("a run id belonging to another tenant is not readable", async () => {
  const response = await call(`/api/runs/${RUN_ID}`);

  assert.equal(response.status, 404);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "run_not_found"
  );
});

test("a run id belonging to another tenant cannot be streamed", async () => {
  const response = await call(`/api/runs/${RUN_ID}/events`);

  assert.equal(response.status, 404);
  assert.notEqual(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8"
  );
});

test("a run id belonging to another tenant cannot be stopped", async () => {
  const response = await call(`/api/runs/${RUN_ID}/stop`, "POST");

  assert.equal(response.status, 404);
  assert.deepEqual(stopped, [], "stop must not be reached");
});

/**
 * A control for the negative run-route tests above. Without it, a regression
 * that made every run route 404 — for any reason, not just ownership — would
 * leave all of them passing.
 */
test("a run belonging to the caller is readable", async () => {
  const response = await call(`/api/runs/${MY_RUN_ID}`);

  assert.equal(response.status, 200);
  const body = (await response.json()) as { run: { id: string } };
  assert.equal(body.run.id, MY_RUN_ID);
});

test("a client-supplied owner is rejected at the route, not just the schema", async () => {
  // Guards the invariant end to end: ownership is stamped from the caller, and
  // createAgentInputSchema staying .strict() is what stops a submitted claim
  // from being silently accepted if the spread order ever changes.
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Impostor",
        owner: { kind: "tenant", tenantId: "someone_else" },
        runtime: "copilot",
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );

  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "invalid_request"
  );
});

test("the caller tenant comes from the verified claim, not the runner token", async () => {
  // The whole point of the change: two callers presenting the same deployment
  // gate but different identities must not see the same agents.
  const response = await call("/api/agents");

  assert.equal(response.status, 200);
  const body = (await response.json()) as { agents: AgentDefinition[] };
  assert.deepEqual(
    body.agents.map((agent) => agent.id),
    [MINE]
  );
});

test("a valid runner token without an identity is refused", async () => {
  const environment = await environmentPromise;
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      headers: { "x-runner-token": TOKEN },
    }),
    environment as never
  );

  assert.equal(response.status, 401);
});

test("a valid identity without the deployment gate is refused", async () => {
  const environment = await environmentPromise;
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      headers: { authorization: `Bearer ${await identityToken()}` },
    }),
    environment as never
  );

  assert.equal(response.status, 401);
});

test("a worker with no verify key refuses rather than assuming a tenant", async () => {
  // A misconfigured deployment must fail closed. Without this the request
  // reaches the key import with nothing to import, and the failure mode
  // depends on what happens to throw first — which is not a security
  // guarantee, it is an accident.
  const environment = await environmentPromise;
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      headers: {
        authorization: `Bearer ${await identityToken()}`,
        "x-runner-token": TOKEN,
      },
    }),
    { ...environment, RUNNER_VERIFY_KEY: undefined } as never
  );

  assert.equal(response.status, 401);
});

test("a demo claim cannot start a run", async () => {
  // Expiring the plan inside the token achieves nothing unless something
  // enforces it. A lapsed subscriber is issued a fresh `demo` claim for the
  // same tenant; without this the run starts and either fails late for a
  // missing credential, or succeeds outright on one still stored.
  const pair = await getKeyPair();
  const demoToken = await mint(pair.privateKey, {
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
    plan: "demo",
    sub: "user-1",
    tenant: CALLER_TENANT,
  });
  const environment = await environmentPromise;

  const response = await runner().fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({
        operationId: "44444444-5555-4666-8777-888888888888",
        task: "do the thing",
      }),
      headers: {
        authorization: `Bearer ${demoToken}`,
        "content-type": "application/json",
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );

  assert.equal(response.status, 403);
});

/**
 * The fallback handler is the only place an unrecognised failure is ever seen,
 * so what it logs is the whole diagnosis.
 *
 * It used to log a bare sentence and drop the error, which made every unhandled
 * throw in the worker produce one indistinguishable line — a run reached the
 * worker, returned 500, and the log said nothing about why. This asserts the
 * error survives into the log, because the defect it caused is invisible to any
 * test of the response: the 500 was always correct.
 */
test("an unrecognised failure is logged with the error, not just a sentence", async () => {
  const boom = new Error("sandbox refused the container");
  boom.name = "SandboxError";

  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  let response: Response;
  try {
    response = await failingRunner(boom);
  } finally {
    console.error = original;
  }

  assert.equal(response.status, 500);

  const entry = logged.find(
    (args) => args[0] === "Cloud runner request failed."
  );
  assert.ok(entry, "the fallback must log under its known message");

  const detail = entry?.[1] as { message: string; name: string };
  assert.equal(detail.name, "SandboxError");
  assert.equal(detail.message, "sandbox refused the container");
});

test("a credential in a thrown message does not reach the log", async () => {
  // A failed fetch stringifies its request, and a harness token travels in an
  // Authorization header. Logging the error verbatim would put it in the log.
  const leak = new Error(
    "fetch failed: authorization: Bearer ghp_notarealtoken"
  );

  const logged: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };

  try {
    await failingRunner(leak);
  } finally {
    console.error = original;
  }

  const entry = logged.find(
    (args) => args[0] === "Cloud runner request failed."
  );
  const detail = entry?.[1] as { message: string };
  assert.ok(
    !detail.message.includes("ghp_notarealtoken"),
    `the token survived redaction: ${detail.message}`
  );
});

/**
 * A runner whose directory throws something the route does not recognise, so
 * the request falls through to the catch-all rather than to a typed branch.
 */
async function failingRunner(error: Error): Promise<Response> {
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);

  const directory: CloudRunnerDirectory = {
    list: () => {
      throw error;
    },
    lookupRun: () => MINE,
    registerRun: () => true,
    remove: () => undefined,
    unregisterRun: () => undefined,
    upsert: (value) => value,
  };

  return createCloudRunner({
    getDirectory: () => directory,
    getYoloAgent: () => ({}) as unknown as CloudRunnerAgent,
  }).fetch(
    new Request("https://runner.test/api/agents", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
    }),
    environment as never
  );
}

test("a DO-thrown AlreadyRunningError still maps to 409, not the 500 catch-all", async () => {
  // The YoloAgent throws inside a Durable Object, and the RPC boundary
  // preserves an error's name and message but strips its prototype chain —
  // `instanceof AlreadyRunningError` is false for every real production
  // throw. This error is deliberately a plain Error wearing the name, which
  // is exactly what arrives across the boundary.
  const crossed = new Error("An agent already has an active run.");
  crossed.name = "AlreadyRunningError";

  const response = await failingRunner(crossed);
  assert.equal(response.status, 409);

  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "already_running");
});

test("a DO-thrown AgentBusyError still maps to the typed conflict response", async () => {
  const crossed = new Error("An agent already has an active run.");
  crossed.name = "AgentBusyError";

  const response = await failingRunner(crossed);
  assert.equal(response.status, 409);

  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "already_running");
});

test("creating an agent triggers its warm-up for a subscriber", async () => {
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Warmed",
        runtime: "copilot",
      }),
      headers: {
        authorization: `Bearer ${await identityToken()}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    (await environmentPromise) as never
  );

  assert.equal(response.status, 201);
  assert.equal(warmed.length, 1);
});

test("a demo claim creates without warming", async () => {
  // Creation is allowed — the profile is configuration — but a demo tenant
  // cannot run, so booting a container for one would spend capacity on
  // nothing.
  const pair = await getKeyPair();
  const demoToken = await mint(pair.privateKey, {
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
    plan: "demo",
    sub: "user-1",
    tenant: CALLER_TENANT,
  });

  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Cold",
        runtime: "copilot",
      }),
      headers: {
        authorization: `Bearer ${demoToken}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    (await environmentPromise) as never
  );

  assert.equal(response.status, 201);
  assert.deepEqual(warmed, []);
});

test("tenant prewarm boots the most recently used agent", async () => {
  const response = await call("/api/tenant/prewarm", "POST");

  assert.equal(response.status, 202);
  const body = (await response.json()) as { agentId: string };
  assert.equal(body.agentId, MINE);
  assert.deepEqual(warmed, [MINE]);
});

test("tenant prewarm with no agents warms nothing", async () => {
  const pair = await getKeyPair();
  const token = await mint(pair.privateKey, {
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
    plan: "subscriber",
    sub: "user-2",
    tenant: "t_no_agents",
  });

  const response = await runner().fetch(
    new Request("https://runner.test/api/tenant/prewarm", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    (await environmentPromise) as never
  );

  assert.equal(response.status, 204);
  assert.deepEqual(warmed, []);
});

test("a demo claim cannot prewarm", async () => {
  const pair = await getKeyPair();
  const demoToken = await mint(pair.privateKey, {
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
    plan: "demo",
    sub: "user-1",
    tenant: CALLER_TENANT,
  });

  const response = await runner().fetch(
    new Request("https://runner.test/api/tenant/prewarm", {
      headers: {
        authorization: `Bearer ${demoToken}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    (await environmentPromise) as never
  );

  assert.equal(response.status, 403);
  assert.deepEqual(warmed, []);
});

function queuedRun(
  agentId: string,
  runId: string,
  operationId: string
): RunSnapshot {
  return {
    agentId,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [],
    completedAt: null,
    createdAt: "2026-08-26T00:00:00.000Z",
    fileEvidence: [],
    id: runId,
    operationId,
    output: "",
    startedAt: null,
    status: "queued",
    task: "Run the tests.",
  };
}

test("run admission happens before dispatch and receives only a tenant hash", async () => {
  const operationId = "33333333-4444-4555-8666-777777777777";
  const runId = "44444444-5555-4666-8777-888888888888";
  const calls: string[] = [];
  const admissionRequests: {
    mode?: string;
    tenantHash?: string;
  }[] = [];
  const run = queuedRun(MINE, runId, operationId);
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => undefined,
    enqueue: (
      _input: unknown,
      _runId: string,
      _requestHash: string,
      _identityToken: string
    ) => {
      calls.push("enqueue");
      return { created: true, run };
    },
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => run,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const directory: CloudRunnerDirectory = {
    list: (tenantId) =>
      [...agents.values()].filter(
        (candidate) =>
          candidate.owner?.kind === "tenant" &&
          candidate.owner.tenantId === tenantId
      ),
    lookupRun: () => null,
    registerRun: () => {
      calls.push("register");
      return true;
    },
    remove: () => undefined,
    unregisterRun: () => undefined,
    upsert: (value) => value,
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: (input) => {
        calls.push("admit");
        admissionRequests.push(input);
        return {
          kind: "queued" as const,
          position: 1,
          runId,
        };
      },
      release: () => false,
    }),
    getDirectory: () => directory,
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: "Run the tests." }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "queue" } as never
  );

  assert.equal(response.status, 202);
  assert.deepEqual(calls, ["enqueue", "admit", "register"]);
  assert.equal(admissionRequests.length, 1);
  assert.equal(admissionRequests[0]?.mode, "queue");
  assert.notEqual(admissionRequests[0]?.tenantHash, CALLER_TENANT);
  assert.match(admissionRequests[0]?.tenantHash ?? "", /^v1:[0-9a-f]{64}$/);
  assert.equal(
    String(admissionRequests[0]?.tenantHash).includes(CALLER_TENANT),
    false
  );
});

test("run admission passes its durable capability directly to confirmation", async () => {
  const operationId = "33333333-aaaa-4555-8666-777777777777";
  const runId = "44444444-bbbb-4666-8777-888888888888";
  const run = queuedRun(MINE, runId, operationId);
  const capability = {
    admissionSequence: 7,
    agentId: MINE,
    operationId,
    requestHash: "request-hash",
    runId,
  };
  const confirmedCapabilities: unknown[] = [];
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    confirmAdmission: (_runId, _operationId, _requestHash, received) => {
      confirmedCapabilities.push(received);
      return { kind: "confirmed" };
    },
    decommission: () => undefined,
    discardRun: () => undefined,
    enqueue: () => ({ created: true, run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => run,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);

  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () =>
        ({
          admissionCapability: capability,
          kind: "active",
          runId,
        }) as never,
      release: () => false,
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => null,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: run.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "queue" } as never
  );

  assert.equal(response.status, 202);
  assert.deepEqual(confirmedCapabilities, [capability]);
});

test("a terminal duplicate reconciles stale admission before returning the terminal run", async () => {
  const operationId = "33333333-aaaa-4555-8666-777777777777";
  const runId = "44444444-bbbb-4666-8777-888888888888";
  const calls: string[] = [];
  const terminalRun: RunSnapshot = {
    ...queuedRun(MINE, runId, operationId),
    completedAt: "2026-08-26T00:00:01.000Z",
    status: "completed",
  };
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => undefined,
    enqueue: () => ({ created: false, run: terminalRun }),
    getEventStream: () => ({ events: [], terminal: true }),
    getRun: () => terminalRun,
    listRuns: () => [terminalRun],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => terminalRun,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const terminalRequestHash = await hashOperation(MINE, terminalRun.task);
  const terminalTenantHash = await tenantAdmissionHash(
    "test-edge-abuse-secret",
    CALLER_TENANT
  );
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () => {
        throw new Error("a terminal duplicate must not admit again");
      },
      getByOperationId: () => {
        calls.push("lookup-admission");
        return {
          agentId: MINE,
          enqueuedAt: terminalRun.createdAt,
          operationId,
          requestHash: terminalRequestHash,
          runId,
          state: "active",
          tenantHash: terminalTenantHash,
        };
      },
      getCleanupCapability: () => ({
        admissionSequence: 1,
        agentId: MINE,
        operationId,
        requestHash: terminalRequestHash,
        runId,
      }),
      release: (releasedRunId) => {
        calls.push(`release:${releasedRunId}`);
        return true;
      },
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => MINE,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: terminalRun.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );

  assert.equal(response.status, 202);
  assert.deepEqual(calls, ["lookup-admission", `release:${runId}`]);
  assert.deepEqual((await response.json()) as { run: RunSnapshot }, {
    apiVersion: AGENT_RUNNER_API_VERSION,
    run: terminalRun,
  });
});

test("concurrent identical requests reconcile a shared preparation without discarding it", async () => {
  const operationId = "33333333-cccc-4555-8666-777777777777";
  const runId = "44444444-dddd-4666-8777-888888888888";
  const run = queuedRun(MINE, runId, operationId);
  const requestHash = await hashOperation(MINE, run.task);
  const tenantHash = await tenantAdmissionHash(
    "test-edge-abuse-secret",
    CALLER_TENANT
  );
  const calls: string[] = [];
  let enqueueCount = 0;
  let admissionStarted = false;
  let releaseFirstAdmission: (() => void) | undefined;
  const firstAdmission = new Promise<{
    kind: "active";
    runId: string;
  }>((resolve) => {
    releaseFirstAdmission = () => resolve({ kind: "active", runId });
  });
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => {
      calls.push("discard");
      return false;
    },
    enqueue: () => {
      enqueueCount += 1;
      return enqueueCount === 1
        ? { created: true, prepareOwner: "creator", run }
        : { created: false, run };
    },
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    prepareOwnerMatches: () => true,
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => null,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const admission = {
    admit: () => {
      admissionStarted = true;
      return firstAdmission;
    },
    getByOperationId: () => ({
      agentId: MINE,
      enqueuedAt: run.createdAt,
      operationId,
      requestHash,
      runId,
      state: "active" as const,
      tenantHash,
    }),
    release: () => {
      calls.push("release");
      return true;
    },
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const runnerInstance = createCloudRunner({
    getAdmission: () => admission,
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => MINE,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  });
  const request = () =>
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: run.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    });
  const responses = Promise.all([
    runnerInstance.fetch(request(), { ...environment } as never),
    runnerInstance.fetch(request(), { ...environment } as never),
  ]);
  while (!admissionStarted) {
    // biome-ignore lint/performance/noAwaitInLoops: Wait for the concurrent request to reach admission.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  releaseFirstAdmission?.();
  const [firstResponse, secondResponse] = await responses;

  assert.equal(firstResponse.status, 202);
  assert.equal(secondResponse.status, 202);
  assert.equal(calls.includes("discard"), false);
  assert.equal(calls.includes("release"), false);
});

test("a cross-tenant duplicate cannot return or release a foreign admission", async () => {
  const operationId = "99999999-aaaa-4111-8222-333333333333";
  const localRunId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const foreignRunId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const localRun = queuedRun(MINE, localRunId, operationId);
  let releaseCalls = 0;
  let directoryLookups = 0;
  const localAgent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => undefined,
    enqueue: () => ({ created: false, run: localRun }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => localRun,
    listRuns: () => [localRun],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => localRun,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const foreignAdmission = {
    agentId: THEIRS,
    enqueuedAt: localRun.createdAt,
    operationId,
    requestHash: await hashOperation(THEIRS, "Foreign work."),
    runId: foreignRunId,
    state: "active" as const,
    tenantHash: await tenantAdmissionHash(
      "test-edge-abuse-secret",
      "someone_else"
    ),
  };
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () => {
        throw new Error("a duplicate must not admit again");
      },
      getByOperationId: () => foreignAdmission,
      release: () => {
        releaseCalls += 1;
        return true;
      },
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => {
        directoryLookups += 1;
        return THEIRS;
      },
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: (_environment, agentId) => {
      if (agentId !== MINE) {
        throw new Error("foreign agent must not be loaded");
      }
      return localAgent;
    },
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: localRun.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );

  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "operation_conflict"
  );
  assert.equal(releaseCalls, 0);
  assert.equal(directoryLookups, 0);
});

test("a stale local duplicate cannot release a different run with the same operation id", async () => {
  const operationId = "cccccccc-dddd-4eee-8fff-000000000000";
  const localRunId = "dddddddd-eeee-4fff-8000-111111111111";
  const staleRunId = "eeeeeeee-ffff-4000-8111-222222222222";
  const localRun = queuedRun(MINE, localRunId, operationId);
  let releaseCalls = 0;
  let directoryLookups = 0;
  const localAgent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => undefined,
    enqueue: () => ({ created: false, run: localRun }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => localRun,
    listRuns: () => [localRun],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => localRun,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const staleAdmission = {
    agentId: MINE,
    enqueuedAt: localRun.createdAt,
    operationId,
    requestHash: await hashOperation(MINE, localRun.task),
    runId: staleRunId,
    state: "active" as const,
    tenantHash: await tenantAdmissionHash(
      "test-edge-abuse-secret",
      CALLER_TENANT
    ),
  };
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () => {
        throw new Error("a duplicate must not admit again");
      },
      getByOperationId: () => staleAdmission,
      release: () => {
        releaseCalls += 1;
        return true;
      },
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => {
        directoryLookups += 1;
        return MINE;
      },
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => localAgent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: localRun.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );

  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "operation_conflict"
  );
  assert.equal(releaseCalls, 0);
  assert.equal(directoryLookups, 0);
});

test("an orphan queued duplicate resumes admission with its existing run", async () => {
  const operationId = "77777777-8888-4999-9000-111111111111";
  const runId = "88888888-9999-4000-8111-222222222222";
  const run = queuedRun(MINE, runId, operationId);
  let lookedUp = 0;
  let admittedRunId = "";
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => undefined,
    enqueue: () => ({ created: false, run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => run,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: (input: { runId: string }) => {
        admittedRunId = input.runId;
        return { kind: "queued" as const, position: 1, runId };
      },
      getByOperationId: () => {
        lookedUp += 1;
        return null;
      },
      release: () => false,
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => MINE,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: run.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "queue" } as never
  );

  assert.equal(response.status, 202);
  assert.equal(lookedUp, 1);
  assert.equal(admittedRunId, runId);
});

test("duplicate retries repair missing directory mappings for every run state", async () => {
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const cases = [
    {
      admissionState: "queued" as const,
      operationId: "11111111-aaaa-4111-8222-333333333331",
      runId: "22222222-bbbb-4222-8333-444444444441",
      status: "queued" as const,
    },
    {
      admissionState: "active" as const,
      operationId: "33333333-cccc-4333-8444-555555555551",
      runId: "44444444-dddd-4444-8555-666666666661",
      status: "running" as const,
    },
    {
      admissionState: "terminal" as const,
      operationId: "55555555-eeee-4555-8666-777777777771",
      runId: "66666666-ffff-4666-8777-888888888881",
      status: "completed" as const,
    },
  ];
  const tenantHash = await tenantAdmissionHash(
    "test-edge-abuse-secret",
    CALLER_TENANT
  );
  const preparedCases = await Promise.all(
    cases.map(async (candidate) => {
      const run: RunSnapshot = {
        ...queuedRun(MINE, candidate.runId, candidate.operationId),
        completedAt:
          candidate.status === "completed" ? "2026-08-26T00:00:01.000Z" : null,
        startedAt:
          candidate.status === "queued" ? null : "2026-08-26T00:00:00.500Z",
        status: candidate.status,
      };
      return {
        candidate,
        requestHash: await hashOperation(MINE, run.task),
        run,
      };
    })
  );

  const verifyDuplicateCase = async ({
    candidate,
    requestHash,
    run,
  }: (typeof preparedCases)[number]) => {
    const { operationId, runId } = candidate;
    let mappedAgentId: string | null = null;
    const registeredStatuses: string[] = [];
    const directory: CloudRunnerDirectory = {
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => mappedAgentId,
      markRunStatus: (_runId, agentId, status) => {
        if (mappedAgentId !== agentId) {
          return false;
        }
        registeredStatuses.push(status);
        return true;
      },
      registerRun: (_runId, agentId, status = "active") => {
        if (mappedAgentId && mappedAgentId !== agentId) {
          return false;
        }
        mappedAgentId = agentId;
        registeredStatuses.push(status);
        return true;
      },
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value) => value,
    };
    const agent: CloudRunnerAgent = {
      configure: (value: AgentDefinition) => value,
      decommission: () => undefined,
      discardRun: () => undefined,
      enqueue: () => ({ created: false, run }),
      getEventStream: () => ({
        events: [],
        terminal: candidate.status === "completed",
      }),
      getRun: () => run,
      listRuns: () => [run],
      snapshot: () => agents.get(MINE) ?? null,
      stop: () => run,
      warm: () => ({
        status: "provisioning" as const,
        updatedAt: "2026-08-26T00:00:00.000Z",
      }),
    };
    const runnerInstance = createCloudRunner({
      getAdmission: () => ({
        admit: () => {
          throw new Error("a duplicate must not admit again");
        },
        getByOperationId: () => ({
          agentId: MINE,
          enqueuedAt: run.createdAt,
          operationId,
          requestHash,
          runId,
          state: candidate.admissionState,
          tenantHash,
        }),
        release: () => true,
      }),
      getDirectory: () => directory,
      getYoloAgent: () => agent,
    });
    const post = await runnerInstance.fetch(
      new Request(`https://runner.test/api/agents/${MINE}/runs`, {
        body: JSON.stringify({ operationId, task: run.task }),
        headers: {
          authorization: `Bearer ${token}`,
          "x-runner-token": TOKEN,
        },
        method: "POST",
      }),
      environment as never
    );

    assert.equal(post.status, 202);
    assert.equal(mappedAgentId, MINE);
    assert.equal(
      registeredStatuses[0],
      candidate.status === "completed"
        ? "terminal"
        : candidate.status === "queued"
          ? "queued"
          : "active"
    );

    const headers = {
      authorization: `Bearer ${token}`,
      "x-runner-token": TOKEN,
    };
    const get = await runnerInstance.fetch(
      new Request(`https://runner.test/api/runs/${runId}`, { headers }),
      environment as never
    );
    assert.equal(get.status, 200);
    const events = await runnerInstance.fetch(
      new Request(`https://runner.test/api/runs/${runId}/events`, { headers }),
      environment as never
    );
    assert.equal(events.status, 200);
    const stop = await runnerInstance.fetch(
      new Request(`https://runner.test/api/runs/${runId}/stop`, {
        headers,
        method: "POST",
      }),
      environment as never
    );
    assert.equal(stop.status, 200);
  };
  await Promise.all(preparedCases.map(verifyDuplicateCase));
});

test("reject mode preflights local contention without creating a provisional run", async () => {
  const operationId = "77777777-aaaa-4777-8888-999999999991";
  const activeRun = {
    ...queuedRun(
      MINE,
      "88888888-bbbb-4888-8999-000000000001",
      "11111111-2222-4333-8444-555555555555"
    ),
    startedAt: "2026-08-26T00:00:00.500Z",
    status: "running" as const,
  };
  let allowQueued: boolean | undefined;
  let admissionCalls = 0;
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => undefined,
    enqueue: (
      _input,
      _runId,
      _requestHash,
      _identityToken,
      requestedAllowQueued
    ) => {
      allowQueued = requestedAllowQueued;
      return { created: false, run: activeRun };
    },
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => activeRun,
    listRuns: () => [activeRun],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => activeRun,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () => {
        admissionCalls += 1;
        return { kind: "refused" as const, reason: "global_busy" as const };
      },
      release: () => false,
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => null,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: "Another run." }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "reject" } as never
  );

  assert.equal(response.status, 409);
  assert.equal(allowQueued, false);
  assert.equal(admissionCalls, 0);
});

test("reject mode refuses an unhealthy admission object without bypassing it", async () => {
  const operationId = "55555555-6666-4777-8888-999999999999";
  const runId = "66666666-7777-4888-8999-000000000000";
  let discarded = false;
  const run = queuedRun(MINE, runId, operationId);
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => {
      discarded = true;
    },
    enqueue: () => ({ created: true, prepareOwner: "prepare-owner", run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => run,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () => Promise.reject(new Error("admission unavailable")),
      release: () => false,
    }),
    getDirectory: () => ({
      list: () => {
        const storedAgent = agents.get(MINE);
        return storedAgent ? [storedAgent] : [];
      },
      lookupRun: () => null,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: "Run the tests." }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "reject" } as never
  );

  assert.equal(response.status, 409);
  assert.equal(discarded, true);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "busy");
});

test("reject mode does not clean up an unexpected queued decision", async () => {
  const operationId = "77777777-9999-4000-8111-222222222222";
  const runId = "88888888-aaaa-4111-8222-333333333333";
  const calls: string[] = [];
  const run = queuedRun(MINE, runId, operationId);
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => {
      calls.push("discard");
    },
    enqueue: () => ({ created: true, prepareOwner: "prepare-owner", run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => run,
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () => {
        calls.push("admit");
        return { kind: "queued" as const, position: 1, runId };
      },
      release: () => {
        calls.push("release");
        throw new Error("release unavailable");
      },
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => null,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: run.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "reject" } as never
  );

  assert.equal(response.status, 503);
  assert.deepEqual(calls, ["admit"]);
});

test("reject mode does not race cleanup for an unexpected queued decision", async () => {
  const operationId = "77777777-aaaa-4000-8111-222222222222";
  const runId = "88888888-bbbb-4111-8222-333333333333";
  const calls: string[] = [];
  const run = queuedRun(MINE, runId, operationId);
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => {
      calls.push("discard");
      return false;
    },
    enqueue: () => ({ created: true, prepareOwner: "prepare-owner", run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    prepareOwnerMatches: () => true,
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => {
      calls.push("stop");
      return { ...run, status: "cancelled" as const };
    },
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () => {
        calls.push("admit");
        return { kind: "queued" as const, position: 1, runId };
      },
      release: () => {
        calls.push("release");
        return true;
      },
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => null,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: run.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "reject" } as never
  );

  assert.equal(response.status, 503);
  assert.deepEqual(calls, ["admit"]);
});

test("reject mode does not schedule cleanup for an unexpected queued decision", async () => {
  const operationId = "77777777-cccc-4000-8111-222222222222";
  const calls: string[] = [];
  let occupied = false;
  let cleanupReady = false;
  let retryCleanup: (() => Promise<void>) | undefined;
  const runs = new Map<string, RunSnapshot>();
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => {
      calls.push("discard");
      throw new Error("discard unavailable");
    },
    enqueue: (input: unknown, runId: string) => {
      const { operationId: id } = input as { operationId: string };
      const run = queuedRun(MINE, runId, id);
      runs.set(runId, run);
      return { created: true, prepareOwner: "prepare-owner", run };
    },
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: (runId) => runs.get(runId) ?? null,
    listRuns: () => [...runs.values()],
    prepareOwnerMatches: () => true,
    snapshot: () => agents.get(MINE) ?? null,
    stop: (runId) => {
      calls.push("stop");
      if (!cleanupReady) {
        throw new Error("stop unavailable");
      }
      const run = runs.get(runId);
      return run ? { ...run, status: "cancelled" as const } : null;
    },
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const admission = {
    admit: (input: { runId: string }) => {
      calls.push(`admit:${input.runId}`);
      if (occupied) {
        return { kind: "refused" as const, reason: "global_busy" as const };
      }
      occupied = true;
      return { kind: "queued" as const, position: 1, runId: input.runId };
    },
    enqueueCleanup: (agentId: string, runId: string) => {
      assert.equal(agentId, MINE);
      retryCleanup = async () => {
        await agent.stop(runId);
        occupied = false;
      };
      return Promise.resolve();
    },
    release: (runId: string) => {
      calls.push(`release:${runId}`);
      occupied = false;
      return Promise.resolve(true);
    },
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const runnerInstance = createCloudRunner({
    getAdmission: () => admission,
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => null,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  });

  const first = await runnerInstance.fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: "Prepare this." }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "reject" } as never
  );
  assert.equal(first.status, 503);
  assert.equal(retryCleanup, undefined);
  assert.equal(calls.length, 1);
  assert.match(calls[0] ?? "", /^admit:/);

  cleanupReady = true;
  const second = await runnerInstance.fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({
        operationId: "88888888-dddd-4000-8111-222222222222",
        task: "Reuse capacity.",
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );
  assert.equal(second.status, 500);
});

test("a failed provisional cleanup keeps local owner cleanup armed without admission state", async () => {
  const operationId = "77777777-dddd-4000-8111-222222222222";
  const runId = "88888888-dddd-4111-8222-333333333333";
  const calls: string[] = [];
  let localCleanupArmed = false;
  const run = queuedRun(MINE, runId, operationId);
  const agent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => {
      calls.push("discard");
      return false;
    },
    enqueue: () => ({ created: true, prepareOwner: "prepare-owner", run }),
    ensurePendingAdmissionCleanup: () => {
      calls.push("ensure-local-cleanup");
      localCleanupArmed = true;
      return Promise.resolve(true);
    },
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    prepareOwnerMatches: () => true,
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => {
      calls.push("stop");
      throw new Error("stop must not bypass provisional ownership");
    },
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  } as CloudRunnerAgent & {
    ensurePendingAdmissionCleanup: () => Promise<boolean>;
  };
  let cleanupEnqueues = 0;
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);

  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: () => Promise.reject(new Error("admission unavailable")),
      enqueueCleanup: () => {
        cleanupEnqueues += 1;
        return Promise.resolve();
      },
      release: () => false,
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => null,
      registerRun: () => true,
      remove: () => undefined,
      unregisterRun: () => undefined,
      upsert: (value: AgentDefinition) => value,
    }),
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({ operationId, task: run.task }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    { ...environment, RUN_ADMISSION_MODE: "reject" } as never
  );

  assert.equal(response.status, 409);
  assert.deepEqual(calls, ["discard", "ensure-local-cleanup"]);
  assert.equal(localCleanupArmed, true);
  assert.equal(cleanupEnqueues, 0);
});

test("registerRun failure stops the run, releases admission, and allows reuse", async () => {
  const calls: string[] = [];
  const admittedRunIds: string[] = [];
  let registerAttempts = 0;
  let released = false;
  let confirmed = false;
  let cleanupGuard: AdmissionCleanupGuard | undefined;
  const mappings = new Map<string, string>();
  const runs = new Map<string, RunSnapshot>();
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    confirmAdmission: () => {
      confirmed = true;
      return { kind: "confirmed" };
    },
    decommission: () => undefined,
    discardRun: (runId) => {
      calls.push(`discard:${runId}`);
      return false;
    },
    enqueue: (input: unknown, runId: string) => {
      const { operationId } = input as { operationId: string };
      const run = queuedRun(MINE, runId, operationId);
      runs.set(runId, run);
      return { created: true, prepareOwner: "prepare-owner", run };
    },
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: (runId) => runs.get(runId) ?? null,
    listRuns: () => [...runs.values()],
    prepareOwnerMatches: () => !confirmed,
    snapshot: () => agents.get(MINE) ?? null,
    stop: (runId, _dispatchToken, _reason, guard) => {
      calls.push(`stop:${runId}`);
      cleanupGuard = guard;
      const run = runs.get(runId);
      return run ? { ...run, status: "cancelled" as const } : null;
    },
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const directory: CloudRunnerDirectory = {
    list: () => [agents.get(MINE) as AgentDefinition],
    lookupRun: () => null,
    registerRun: (runId) => {
      calls.push(`register:${runId}`);
      registerAttempts += 1;
      if (registerAttempts === 1) {
        mappings.set(runId, MINE);
        return false;
      }
      mappings.set(runId, MINE);
      return true;
    },
    remove: () => undefined,
    unregisterRun: (runId, agentId) => {
      calls.push(`unregister:${runId}`);
      if (mappings.get(runId) !== agentId) {
        return false;
      }
      mappings.delete(runId);
      return true;
    },
    upsert: (value) => value,
  };
  const admission = {
    admit: (input: { runId: string }) => {
      admittedRunIds.push(input.runId);
      calls.push(`admit:${input.runId}`);
      return {
        kind: "active" as const,
        runId: input.runId,
      };
    },
    getCleanupCapability: (candidate: string) => ({
      admissionSequence: 1,
      agentId: MINE,
      operationId: "99999999-aaaa-4111-8222-333333333333",
      requestHash: "request-hash",
      runId: candidate,
    }),
    release: (runId: string) => {
      calls.push(`release:${runId}`);
      released = true;
      return true;
    },
    validateCleanup: () => true,
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const runnerInstance = createCloudRunner({
    getAdmission: () => admission,
    getDirectory: () => directory,
    getYoloAgent: () => agent,
  });

  const first = await runnerInstance.fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({
        operationId: "99999999-aaaa-4111-8222-333333333333",
        task: "Run the tests.",
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );
  assert.equal(first.status, 500);
  assert.equal(released, true);
  const [firstRunId] = admittedRunIds;
  assert.deepEqual(cleanupGuard, {
    admissionSequence: 1,
    agentId: MINE,
    operationId: "99999999-aaaa-4111-8222-333333333333",
    queuedOnly: false,
    requestHash: "request-hash",
    runId: firstRunId,
  });
  assert.match(firstRunId ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.slice(0, 5), [
    `admit:${firstRunId}`,
    `register:${firstRunId}`,
    `unregister:${firstRunId}`,
    `discard:${firstRunId}`,
    `stop:${firstRunId}`,
  ]);
  assert.equal(mappings.has(firstRunId), false);

  const second = await runnerInstance.fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({
        operationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        task: "Run the tests again.",
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );
  assert.equal(second.status, 202);
  assert.equal(registerAttempts, 2);
  assert.equal(calls.filter((entry) => entry.startsWith("release:")).length, 1);
});

test("a run mapping is unregistered when the admitted run disappears after registration", async () => {
  const calls: string[] = [];
  const mappings = new Map<string, string>();
  let runId = "";
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => {
      calls.push("discard");
      return false;
    },
    enqueue: (input: unknown, createdRunId: string) => {
      runId = createdRunId;
      const { operationId } = input as { operationId: string };
      return {
        created: true,
        run: queuedRun(MINE, createdRunId, operationId),
      };
    },
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => {
      throw new Error("run lookup unavailable");
    },
    listRuns: () => [],
    snapshot: () => agents.get(MINE) ?? null,
    stop: () => {
      calls.push("stop");
      return null;
    },
    warm: () => ({
      status: "provisioning" as const,
      updatedAt: "2026-08-26T00:00:00.000Z",
    }),
  };
  const directory: CloudRunnerDirectory = {
    enqueueRunMappingCleanup: (candidate, agentId) => {
      calls.push("enqueue-mapping-cleanup");
      if (mappings.get(candidate) === agentId) {
        mappings.delete(candidate);
      }
    },
    list: () => [agents.get(MINE) as AgentDefinition],
    lookupRun: (candidate) => mappings.get(candidate) ?? null,
    registerRun: (candidate, agentId) => {
      calls.push("register");
      mappings.set(candidate, agentId);
      return true;
    },
    remove: () => undefined,
    unregisterRun: (candidate, agentId) => {
      calls.push("unregister");
      if (mappings.get(candidate) !== agentId) {
        return false;
      }
      throw new Error("directory unavailable");
    },
    upsert: (value) => value,
  };
  const [environment, token] = await Promise.all([
    environmentPromise,
    identityToken(),
  ]);
  const response = await createCloudRunner({
    getAdmission: () => ({
      admit: (input: { runId: string }) => ({
        kind: "active" as const,
        runId: input.runId,
      }),
      getCleanupCapability: (candidate: string) => ({
        admissionSequence: 1,
        agentId: MINE,
        operationId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        requestHash: "request-hash",
        runId: candidate,
      }),
      release: (candidate) => {
        calls.push("release");
        return Boolean(candidate);
      },
      validateCleanup: () => true,
    }),
    getDirectory: () => directory,
    getYoloAgent: () => agent,
  }).fetch(
    new Request(`https://runner.test/api/agents/${MINE}/runs`, {
      body: JSON.stringify({
        operationId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
        task: "Run the tests.",
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "x-runner-token": TOKEN,
      },
      method: "POST",
    }),
    environment as never
  );

  assert.equal(response.status, 500);
  assert.deepEqual(calls, [
    "unregister",
    "enqueue-mapping-cleanup",
    "stop",
    "release",
  ]);
  assert.equal(mappings.get(runId), undefined);
});
