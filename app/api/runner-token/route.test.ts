import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";

const fixtureMode = process.env.RUNNER_TOKEN_ROUTE_FIXTURE;
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

type RouteResult = {
  body: unknown;
  run?: unknown;
  status: number;
};

async function executeFixture(): Promise<void> {
  let run: unknown;
  await mock.module("@/app/(auth)/auth", {
    namedExports: {
      auth: () => Promise.resolve({ user: { id: "user-1" } }),
    },
  });
  await mock.module("@vercel/functions", {
    namedExports: { ipAddress: () => null },
  });
  await mock.module("@/lib/auth/subscriber-authorization.server", {
    namedExports: {
      authorizeSubscriberAccess: () =>
        Promise.resolve({
          authVersion: 0,
          kind: "allowed",
          session: { kind: "subscriber" },
          userId: "user-1",
        }),
    },
  });
  await mock.module("@/lib/auth/subscriber-access", {
    namedExports: {
      subscriberAccessResponse: () =>
        Response.json({ error: "unauthorized" }, { status: 401 }),
    },
  });
  await mock.module("@/lib/abuse/enforce", {
    namedExports: {
      abuseAdmissionResponse: () =>
        Response.json({ error: "blocked" }, { status: 429 }),
      enforceAbusePolicy: () => Promise.resolve({ kind: "allowed" }),
    },
  });
  await mock.module("@/lib/agents/key-ring", {
    namedExports: {
      runnerKeyRingFromEnvironment: () =>
        Promise.resolve({ current: { id: "current" } }),
    },
  });
  await mock.module("@/lib/agents/run-scope-rollout", {
    namedExports: { runScopedIdentityWritesEnabled: () => true },
  });
  await mock.module("@/lib/agents/runner-token", {
    namedExports: {
      claimsForUser: (_user: unknown, runScope: unknown) => {
        run = runScope;
        return {};
      },
      mintRunnerToken: () => Promise.resolve("runner-token"),
    },
  });

  const { POST } = await import("./route");
  const response = await POST(requestFor(fixtureMode));
  process.stdout.write(
    JSON.stringify({
      body: await response.json(),
      run,
      status: response.status,
    })
  );
}

function requestFor(mode: string | undefined): Request {
  const url = "https://app.test/api/runner-token";
  switch (mode) {
    case "bodyless":
      return new Request(url, { method: "POST" });
    case "empty-object":
      return new Request(url, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    case "run-scope":
      return new Request(url, {
        body: JSON.stringify({
          run: {
            agentId: "11111111-1111-4111-8111-111111111111",
            harnessId: "copilot",
            operationId: "22222222-2222-4222-8222-222222222222",
          },
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    case "malformed":
      return new Request(url, {
        body: "{",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    case "unknown-field":
      return new Request(url, {
        body: JSON.stringify({ unexpected: true }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    case "oversized":
      return new Request(url, {
        body: "x".repeat(1025),
        headers: {
          "content-length": "1025",
          "content-type": "application/json",
        },
        method: "POST",
      });
    default:
      return new Request(url, {
        body: new Uint8Array(0),
        method: "POST",
      });
  }
}

function runFixture(mode: string): RouteResult {
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
      env: { ...process.env, RUNNER_TOKEN_ROUTE_FIXTURE: mode },
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as RouteResult;
}

if (fixtureMode) {
  executeFixture().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
} else {
  test("an empty streamed POST retains bodyless runner-token compatibility", () => {
    const result = runFixture("empty-stream");

    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.body, { token: "runner-token" });
  });

  test("an absent runner-token body remains compatible", () => {
    const result = runFixture("bodyless");

    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.body, { token: "runner-token" });
  });

  test("an empty JSON object mints an unscoped runner token", () => {
    const result = runFixture("empty-object");

    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.body, { token: "runner-token" });
    assert.equal(result.run, undefined);
  });

  test("a valid run scope reaches the runner-token claims", () => {
    const result = runFixture("run-scope");

    assert.equal(result.status, 200, JSON.stringify(result));
    assert.deepEqual(result.run, {
      agentId: "11111111-1111-4111-8111-111111111111",
      harnessId: "copilot",
      operationId: "22222222-2222-4222-8222-222222222222",
    });
  });

  test("malformed runner-token JSON remains invalid", () => {
    const result = runFixture("malformed");

    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual(result.body, { error: "invalid_request" });
  });

  test("unknown runner-token fields remain invalid", () => {
    const result = runFixture("unknown-field");

    assert.equal(result.status, 400, JSON.stringify(result));
    assert.deepEqual(result.body, { error: "invalid_request" });
  });

  test("oversized runner-token JSON remains rejected before parsing", () => {
    const result = runFixture("oversized");

    assert.equal(result.status, 413, JSON.stringify(result));
    assert.deepEqual(result.body, { error: "request_too_large" });
  });
}
