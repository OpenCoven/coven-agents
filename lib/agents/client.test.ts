import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_RUNNER_API_VERSION } from "@opencoven/agent-contracts";
import { RunnerApiError, RunnerClient } from "./client";

const agent = {
  backend: "cloud" as const,
  createdAt: "2026-08-20T12:00:00.000Z",
  description: "Code familiar",
  id: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
  instructions: "Implement with evidence.",
  lastRunAt: null,
  model: "gpt-5.1",
  name: "Cody",
  owner: { kind: "standalone" as const },
  runtime: "copilot" as const,
  status: "idle" as const,
  updatedAt: "2026-08-20T12:00:00.000Z",
  warm: {
    status: "not_started" as const,
    updatedAt: "2026-08-20T12:00:00.000Z",
  },
  workspace: "/workspace",
};

test("sends bearer authentication and normalizes the endpoint", async () => {
  let requestedUrl = "";
  let authorization = "";
  const request: typeof fetch = (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Promise.resolve(Response.json({ agents: [agent] }));
  };
  const client = new RunnerClient(
    { endpoint: "https://runner.example.com/", token: "secret" },
    request
  );

  const agents = await client.listAgents();

  assert.equal(requestedUrl, "https://runner.example.com/api/agents");
  assert.equal(authorization, "Bearer secret");
  assert.equal(agents[0]?.name, "Cody");
});

test("surfaces structured runner errors", async () => {
  const request: typeof fetch = () =>
    Promise.resolve(
      Response.json(
        { code: "unauthorized", error: "Token rejected." },
        { status: 401 }
      )
    );
  const client = new RunnerClient(
    { endpoint: "https://runner.example.com", token: "wrong" },
    request
  );

  await assert.rejects(
    client.listAgents(),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "unauthorized" &&
      error.status === 401
  );
});

const RUN_ID = "9c1b7d2f-5a6b-4c90-8f1a-0f4e1f4d4a2e";

function snapshot(status: string) {
  return {
    agentId: agent.id,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [
      { command: "pnpm test", exitCode: 0, stderr: "", stdout: "ok" },
    ],
    completedAt:
      status === "queued" || status === "running"
        ? null
        : "2026-08-20T12:00:05.000Z",
    createdAt: "2026-08-20T12:00:00.000Z",
    fileEvidence: [],
    id: RUN_ID,
    operationId: "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
    output: status === "completed" ? "done" : "",
    startedAt: "2026-08-20T12:00:01.000Z",
    status,
    task: "Fix the tests.",
  };
}

function makeClient(
  handler: (url: string, init?: RequestInit) => Response,
  pollIntervalMs?: number
) {
  const calls: string[] = [];
  const instance = new RunnerClient(
    { endpoint: "https://runner.test", token: "t" },
    ((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      return Promise.resolve(handler(url, init));
    }) as unknown as typeof globalThis.fetch,
    { pollIntervalMs: pollIntervalMs ?? 0 }
  );
  return { calls, instance };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

test("a synchronous local run is returned as-is", async () => {
  // The local runner answers 200 with a finished RunResult and no run route to
  // poll, so the client must not try to follow it.
  const result = {
    agentId: agent.id,
    commandResults: [],
    completedAt: "2026-08-20T12:00:05.000Z",
    fileOperations: [],
    id: RUN_ID,
    output: "done",
    startedAt: "2026-08-20T12:00:01.000Z",
    status: "completed" as const,
  };
  const { calls, instance } = makeClient(() => json({ run: result }));

  const run = await instance.runAgent(agent.id, "Fix the tests.");

  assert.equal(run.output, "done");
  assert.deepEqual(calls, [`POST /api/agents/${agent.id}/runs`]);
});

test("an accepted cloud run is followed to completion", async () => {
  // 202 carries a queued snapshot, so the client polls the run route until the
  // run is terminal and hands back the same RunResult shape either way.
  let polls = 0;
  const { calls, instance } = makeClient((url) => {
    if (url.includes("/api/runs/")) {
      polls += 1;
      return json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot(polls === 1 ? "running" : "completed"),
      });
    }
    return json(
      { apiVersion: AGENT_RUNNER_API_VERSION, run: snapshot("queued") },
      202
    );
  });

  const run = await instance.runAgent(agent.id, "Fix the tests.");

  assert.equal(run.status, "completed");
  assert.equal(run.output, "done");
  assert.equal(run.commandResults.length, 1);
  assert.equal(polls, 2, "polling continues while the run is still running");
  assert.equal(calls.at(-1), `GET /api/runs/${RUN_ID}`);
});

test("a cancelled cloud run reports as failed rather than completed", async () => {
  const { instance } = makeClient((url) =>
    url.includes("/api/runs/")
      ? json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: snapshot("cancelled"),
        })
      : json(
          { apiVersion: AGENT_RUNNER_API_VERSION, run: snapshot("queued") },
          202
        )
  );

  const run = await instance.runAgent(agent.id, "Fix the tests.");

  assert.equal(run.status, "failed");
});

test("the nested cloud error envelope is surfaced, not flattened away", async () => {
  const { instance } = makeClient(() =>
    json(
      {
        apiVersion: AGENT_RUNNER_API_VERSION,
        error: {
          code: "already_running",
          message: "An agent already has an active run.",
          retryable: false,
        },
        requestId: "11111111-2222-4333-8444-555555555555",
      },
      409
    )
  );

  await assert.rejects(
    () => instance.runAgent(agent.id, "Fix the tests."),
    (error: RunnerApiError) => {
      assert.equal(error.code, "already_running");
      assert.equal(error.message, "An agent already has an active run.");
      return true;
    }
  );
});

test("the flat local error shape is still understood", async () => {
  // Reading only the cloud envelope would degrade every local error to a
  // generic "Runner request failed (400)".
  const { instance } = makeClient(() =>
    json(
      {
        code: "backend_mismatch",
        error: "Local runner only accepts local agents.",
      },
      400
    )
  );

  await assert.rejects(
    () => instance.runAgent(agent.id, "Fix the tests."),
    (error: RunnerApiError) => {
      assert.equal(error.code, "backend_mismatch");
      assert.equal(error.message, "Local runner only accepts local agents.");
      return true;
    }
  );
});

test("an unrecognised run payload is reported rather than silently accepted", async () => {
  const { instance } = makeClient(() => json({ unexpected: true }, 202));

  await assert.rejects(
    () => instance.runAgent(agent.id, "Fix the tests."),
    (error: RunnerApiError) => error.code === "unexpected_run_payload"
  );
});

test("aborting a poll rejects promptly instead of waiting out the interval", async () => {
  // The loop checks `aborted` at the top, so a sleep that ignored the signal
  // would leave a cancel sitting for up to a full interval. The interval here
  // is 30s: if the wait were not abort-aware this test would not finish.
  const controller = new AbortController();
  const { instance } = makeClient(
    () =>
      json(
        { apiVersion: AGENT_RUNNER_API_VERSION, run: snapshot("running") },
        202
      ),
    30_000
  );

  const started = Date.now();
  const pending = instance.runAgent(agent.id, "Fix the tests.", {
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(
    () => pending,
    (error: RunnerApiError) => error.code === "aborted"
  );
  assert.ok(
    Date.now() - started < 5000,
    "abort must not block on the poll interval"
  );
});

test("a run still in flight cannot be projected onto a result", async () => {
  const { runSnapshotToResult } = await import("@opencoven/agent-contracts");

  for (const status of ["queued", "running"]) {
    assert.throws(
      () => runSnapshotToResult(snapshot(status) as never),
      /Cannot project a (queued|running) run/,
      `${status} must not silently report as failed`
    );
  }
  // Terminal statuses still project.
  assert.equal(
    runSnapshotToResult(snapshot("completed") as never).status,
    "completed"
  );
  assert.equal(
    runSnapshotToResult(snapshot("cancelled") as never).status,
    "failed"
  );
});

test("a run starts without crypto.randomUUID", async () => {
  // Browsers only expose randomUUID in a secure context, so a local runner
  // reached over plain HTTP on a LAN address has none.
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: original.getRandomValues.bind(original) },
  });
  try {
    let sentBody: string | undefined;
    const { instance } = makeClient((_url, init) => {
      sentBody = init?.body as string;
      return json({
        run: {
          agentId: agent.id,
          commandResults: [],
          completedAt: "2026-08-20T12:00:05.000Z",
          fileOperations: [],
          id: RUN_ID,
          output: "done",
          startedAt: "2026-08-20T12:00:01.000Z",
          status: "completed",
        },
      });
    });

    await instance.runAgent(agent.id, "Fix the tests.");

    const sent = JSON.parse(sentBody ?? "{}") as { operationId: string };
    assert.match(
      sent.operationId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      "the fallback must still produce a valid v4 uuid"
    );
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: original,
    });
  }
});

test("with an identity minter, the two tokens travel on separate headers", async () => {
  // Identity and authorization are different questions. The runner token
  // proves the caller may reach the deployment; the minted claim says which
  // tenant they are. Collapsing them onto one header is what let every caller
  // share a tenant.
  let seen = new Headers();
  const request: typeof globalThis.fetch = (_input, init) => {
    seen = new Headers(init?.headers);
    return Promise.resolve(Response.json({ agents: [] }));
  };

  const client = new RunnerClient(
    { endpoint: "https://runner.test", token: "deployment-gate" },
    request,
    { mintIdentity: () => Promise.resolve("minted-identity") }
  );
  await client.listAgents();

  assert.equal(seen.get("authorization"), "Bearer minted-identity");
  assert.equal(seen.get("x-runner-token"), "deployment-gate");
});

test("a cloud run mints identity for its exact agent, harness, and operation", async () => {
  let body: { operationId?: string } = {};
  let scope: unknown;
  const request: typeof globalThis.fetch = (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(
      json(
        {
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: { ...snapshot("queued"), operationId: body.operationId },
        },
        202
      )
    );
  };
  const client = new RunnerClient(
    { endpoint: "https://runner.test", token: "deployment-gate" },
    request,
    {
      mintIdentity: (run) => {
        scope = run;
        return Promise.resolve("minted-identity");
      },
    }
  );

  await client.startRun(agent.id, "Fix the tests.", {
    harnessId: agent.runtime,
  });

  assert.deepEqual(scope, {
    agentId: agent.id,
    harnessId: agent.runtime,
    operationId: body.operationId,
  });
});

test("without a minter the single token stays on authorization", async () => {
  // The local runner has no tenancy and must keep working unchanged.
  let seen = new Headers();
  const request: typeof globalThis.fetch = (_input, init) => {
    seen = new Headers(init?.headers);
    return Promise.resolve(Response.json({ agents: [] }));
  };

  const client = new RunnerClient(
    { endpoint: "https://local.test", token: "local-token" },
    request
  );
  await client.listAgents();

  assert.equal(seen.get("authorization"), "Bearer local-token");
  assert.equal(seen.get("x-runner-token"), null);
});
