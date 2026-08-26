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
import {
  type CloudRunnerAgent,
  type CloudRunnerDirectory,
  createCloudRunner,
} from "./routes";

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
    registerRun: () => undefined,
    remove: () => undefined,
    unregisterRun: () => undefined,
    upsert: (value) => value,
  };

  const getYoloAgent = (_environment: unknown, agentId: string) =>
    ({
      configure: (value: AgentDefinition) => value,
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
      start: () => {
        throw new Error("start must not be reached for another tenant");
      },
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
    registerRun: () => undefined,
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
  const admissionRequests: { tenantHash?: string }[] = [];
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
    start: () => {
      throw new Error("legacy start must not be reached");
    },
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
  assert.notEqual(admissionRequests[0]?.tenantHash, CALLER_TENANT);
  assert.match(admissionRequests[0]?.tenantHash ?? "", /^v1:[0-9a-f]{64}$/);
  assert.equal(
    String(admissionRequests[0]?.tenantHash).includes(CALLER_TENANT),
    false
  );
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
    start: () => {
      throw new Error("a terminal duplicate must not dispatch");
    },
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
          requestHash: "request-hash",
          runId,
          state: "active",
          tenantHash: "tenant-hash",
        };
      },
      release: (releasedRunId) => {
        calls.push(`release:${releasedRunId}`);
        return true;
      },
    }),
    getDirectory: () => ({
      list: () => [agents.get(MINE) as AgentDefinition],
      lookupRun: () => MINE,
      registerRun: () => undefined,
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

test("an orphan queued duplicate cannot bypass admission", async () => {
  const operationId = "77777777-8888-4999-9000-111111111111";
  const runId = "88888888-9999-4000-8111-222222222222";
  const run = queuedRun(MINE, runId, operationId);
  let lookedUp = 0;
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: () => undefined,
    enqueue: () => ({ created: false, run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    start: () => {
      throw new Error("orphan duplicate must not start directly");
    },
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
        throw new Error("admit must not create a second record");
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
      registerRun: () => undefined,
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

  assert.equal(response.status, 409);
  assert.equal(lookedUp, 1);
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
    enqueue: () => ({ created: true, run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    start: () => {
      throw new Error("legacy start must not be reached");
    },
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
      registerRun: () => undefined,
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

test("reject fallback discards a queued run before releasing admission", async () => {
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
    enqueue: () => ({ created: true, run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    start: () => {
      throw new Error("legacy start must not be reached");
    },
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
      registerRun: () => undefined,
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

  assert.equal(response.status, 500);
  assert.deepEqual(calls, ["admit", "discard", "release"]);
});

test("reject fallback stops an execution that wins the discard race before release", async () => {
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
    enqueue: () => ({ created: true, run }),
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: () => run,
    listRuns: () => [run],
    snapshot: () => agents.get(MINE) ?? null,
    start: () => {
      throw new Error("legacy start must not be reached");
    },
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
      registerRun: () => undefined,
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
  assert.deepEqual(calls, ["admit", "discard", "stop", "release"]);
});

test("registerRun failure stops the run, releases admission, and allows reuse", async () => {
  const calls: string[] = [];
  const admittedRunIds: string[] = [];
  let registerAttempts = 0;
  let released = false;
  const runs = new Map<string, RunSnapshot>();
  const agent: CloudRunnerAgent = {
    configure: (value: AgentDefinition) => value,
    decommission: () => undefined,
    discardRun: (runId) => {
      calls.push(`discard:${runId}`);
      runs.delete(runId);
    },
    enqueue: (input: unknown, runId: string) => {
      const { operationId } = input as { operationId: string };
      const run = queuedRun(MINE, runId, operationId);
      runs.set(runId, run);
      return { created: true, run };
    },
    getEventStream: () => ({ events: [], terminal: false }),
    getRun: (runId) => runs.get(runId) ?? null,
    listRuns: () => [...runs.values()],
    snapshot: () => agents.get(MINE) ?? null,
    start: () => {
      throw new Error("legacy start must not be reached");
    },
    stop: (runId) => {
      calls.push(`stop:${runId}`);
      return runs.get(runId) ?? null;
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
        throw new Error("directory unavailable");
      }
    },
    remove: () => undefined,
    unregisterRun: () => undefined,
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
    release: (runId: string) => {
      calls.push(`release:${runId}`);
      released = true;
      return true;
    },
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
  assert.match(firstRunId ?? "", /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.slice(0, 4), [
    `admit:${firstRunId}`,
    `register:${firstRunId}`,
    `stop:${firstRunId}`,
    `discard:${firstRunId}`,
  ]);

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
    start: () => {
      throw new Error("legacy start must not be reached");
    },
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
      mappings.delete(candidate);
      return true;
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
      release: (candidate) => {
        calls.push("release");
        return Boolean(candidate);
      },
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
    "register",
    "unregister",
    "stop",
    "discard",
    "release",
  ]);
  assert.equal(mappings.get(runId), undefined);
});
