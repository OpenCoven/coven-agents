import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type Outcome = { success: boolean };

class RecordingLimiter {
  readonly keys: string[] = [];
  private readonly outcome: Outcome | Error;

  constructor(outcome: Outcome | Error = { success: true }) {
    this.outcome = outcome;
  }

  limit(input: { key: string }): Promise<Outcome> {
    this.keys.push(input.key);
    return this.outcome instanceof Error
      ? Promise.reject(this.outcome)
      : Promise.resolve(this.outcome);
  }
}

async function abuseModule() {
  const loaded = await import("./abuse.js").catch(() => null);
  assert.ok(loaded, "worker abuse controls must be implemented");
  return loaded;
}

function environment(overrides: Record<string, unknown> = {}) {
  return {
    EDGE_ABUSE_KEY_SECRET: "test-edge-abuse-secret",
    EDGE_REQUEST_LIMITER: new RecordingLimiter(),
    TENANT_MUTATION_LIMITER: new RecordingLimiter(),
    TENANT_RUN_LIMITER: new RecordingLimiter(),
    ...overrides,
  };
}

test("source limits use stable pseudonymous keys and a shared missing-IP bucket", async () => {
  const { enforceWorkerEdgeLimit } = await abuseModule();
  const edge = new RecordingLimiter();
  const env = environment({ EDGE_REQUEST_LIMITER: edge });

  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env,
      ip: "203.0.113.10",
      routeClass: "read",
      stage: "source",
    }),
    { kind: "allowed" }
  );
  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env,
      ip: "203.0.113.10",
      routeClass: "mutation",
      stage: "source",
    }),
    { kind: "allowed" }
  );
  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env,
      ip: null,
      routeClass: "read",
      stage: "source",
    }),
    { kind: "allowed" }
  );
  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env,
      ip: "",
      routeClass: "read",
      stage: "source",
    }),
    { kind: "allowed" }
  );

  assert.equal(edge.keys.length, 4);
  assert.equal(edge.keys[0], edge.keys[1]);
  assert.equal(edge.keys[2], edge.keys[3]);
  assert.notEqual(edge.keys[0], edge.keys[2]);
  assert.ok(edge.keys.every((key) => !key.includes("203.0.113.10")));
  assert.ok(edge.keys.every((key) => !key.includes("unknown")));
});

test("tenant reads are free while mutations and runs use isolated bindings", async () => {
  const { enforceWorkerEdgeLimit } = await abuseModule();
  const mutation = new RecordingLimiter();
  const run = new RecordingLimiter();
  const env = environment({
    TENANT_MUTATION_LIMITER: mutation,
    TENANT_RUN_LIMITER: run,
  });

  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env,
      ip: "203.0.113.10",
      routeClass: "read",
      stage: "tenant",
      tenant: "tenant-a",
    }),
    { kind: "allowed" }
  );
  const mutationResults = await Promise.all(
    ["tenant-a", "tenant-b"].map((tenant) =>
      enforceWorkerEdgeLimit({
        env,
        ip: "203.0.113.10",
        routeClass: "mutation",
        stage: "tenant",
        tenant,
      })
    )
  );
  for (const result of mutationResults) {
    assert.deepEqual(result, { kind: "allowed" });
  }
  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env,
      ip: "203.0.113.10",
      routeClass: "run",
      stage: "tenant",
      tenant: "tenant-a",
    }),
    { kind: "allowed" }
  );

  assert.deepEqual(mutation.keys.length, 2);
  assert.notEqual(mutation.keys[0], mutation.keys[1]);
  assert.ok(mutation.keys.every((key) => !key.includes("tenant-")));
  assert.equal(run.keys.length, 1);
  assert.equal(environment().EDGE_REQUEST_LIMITER.keys.length, 0);
});

test("limit refusals and limiter failures fail closed with bounded retry metadata", async () => {
  const { enforceWorkerEdgeLimit } = await abuseModule();

  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env: environment({
        EDGE_REQUEST_LIMITER: new RecordingLimiter({ success: false }),
      }),
      ip: "203.0.113.10",
      routeClass: "read",
      stage: "source",
    }),
    { kind: "limited", retryAfterSeconds: 60 }
  );
  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env: environment({
        TENANT_RUN_LIMITER: new RecordingLimiter(new Error("unavailable")),
      }),
      ip: "203.0.113.10",
      routeClass: "run",
      stage: "tenant",
      tenant: "tenant-a",
    }),
    { kind: "unavailable" }
  );
  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env: environment({ EDGE_ABUSE_KEY_SECRET: undefined }),
      ip: "203.0.113.10",
      routeClass: "read",
      stage: "source",
    }),
    { kind: "unavailable" }
  );
  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env: environment({ TENANT_MUTATION_LIMITER: undefined }),
      ip: "203.0.113.10",
      routeClass: "mutation",
      stage: "tenant",
      tenant: "tenant-a",
    }),
    { kind: "unavailable" }
  );
  assert.deepEqual(
    await enforceWorkerEdgeLimit({
      env: environment(),
      ip: "203.0.113.10",
      routeClass: "mutation",
      stage: "tenant",
    }),
    { kind: "unavailable" }
  );
});

test("route classification separates reads, mutations, and paid run starts", async () => {
  const { workerRouteClass } = await abuseModule();

  assert.equal(workerRouteClass("GET", "/api/agents"), "read");
  assert.equal(workerRouteClass("POST", "/api/agents"), "mutation");
  assert.equal(
    workerRouteClass(
      "POST",
      "/api/agents/3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90/runs"
    ),
    "run"
  );
  assert.equal(workerRouteClass("POST", "/api/diagnostics/sandbox"), "run");
  // Prewarm boots a container exactly like a run does, so it spends the
  // run budget, not the cheaper mutation one.
  assert.equal(workerRouteClass("POST", "/api/tenant/prewarm"), "run");
  assert.equal(
    workerRouteClass(
      "POST",
      "/api/runs/3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90/stop"
    ),
    "mutation"
  );
});

test("Wrangler declares isolated edge bindings and the HMAC secret type", () => {
  const config = readFileSync(
    new URL("../wrangler.jsonc", import.meta.url),
    "utf8"
  );
  const secrets = readFileSync(
    new URL("./worker-secrets.d.ts", import.meta.url),
    "utf8"
  );
  const generated = readFileSync(
    new URL("../worker-configuration.d.ts", import.meta.url),
    "utf8"
  );
  const developmentVariables = readFileSync(
    new URL("../.dev.vars.example", import.meta.url),
    "utf8"
  );

  for (const [name, namespaceId, limit] of [
    ["EDGE_REQUEST_LIMITER", "1001", 60],
    ["TENANT_MUTATION_LIMITER", "1002", 30],
    ["TENANT_RUN_LIMITER", "1003", 5],
  ] as const) {
    assert.match(
      config,
      new RegExp(
        `"name": "${name}"[\\s\\S]*?"namespace_id": "${namespaceId}"[\\s\\S]*?"limit": ${limit}[\\s\\S]*?"period": 60`
      )
    );
    assert.match(generated, new RegExp(`${name}: RateLimit;`));
  }
  assert.match(secrets, /EDGE_ABUSE_KEY_SECRET\?: string;/);
  assert.match(
    developmentVariables,
    /^EDGE_ABUSE_KEY_SECRET=replace-with-a-long-random-secret$/m
  );
});
