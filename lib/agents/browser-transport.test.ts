import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  type AgentDefinition,
  type RunSnapshot,
} from "@opencoven/agent-contracts";
import { BrowserRunnerTransport, RunnerApiError } from "./browser-transport";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_ID = "33333333-3333-4333-8333-333333333333";

const agent: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-29T00:00:00.000Z",
  description: "Transport fixture",
  id: AGENT_ID,
  instructions: "Exercise every browser route.",
  lastRunAt: null,
  model: "auto",
  name: "Transport",
  owner: { kind: "standalone" },
  runtime: "copilot",
  status: "idle",
  updatedAt: "2026-08-29T00:00:00.000Z",
  warm: {
    status: "ready",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
  workspace: "/workspace",
};

function run(status: RunSnapshot["status"] = "queued"): RunSnapshot {
  return {
    agentId: AGENT_ID,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [],
    completedAt:
      status === "queued" || status === "running"
        ? null
        : "2026-08-29T00:01:00.000Z",
    createdAt: "2026-08-29T00:00:00.000Z",
    fileEvidence: [],
    id: RUN_ID,
    operationId: OPERATION_ID,
    output: status === "completed" ? "done" : "",
    startedAt: "2026-08-29T00:00:01.000Z",
    status,
    task: "Exercise transport.",
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function interruptedEventStream(body: string): Response {
  const encoded = new TextEncoder().encode(body);
  let reads = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(encoded);
          return;
        }
        controller.error(new TypeError("connection reset"));
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  );
}

function interruptedJson(body: unknown, status = 202): Response {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  let reads = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(encoded);
          return;
        }
        controller.error(new TypeError("response body reset"));
      },
    }),
    { headers: { "content-type": "application/json" }, status }
  );
}

function runnerError(
  code: string,
  retryable: boolean,
  status: number
): Response {
  return json(
    {
      apiVersion: AGENT_RUNNER_API_VERSION,
      error: {
        code,
        message: code,
        retryable,
      },
      requestId: "request-1",
    },
    status
  );
}

test("stop preserves whether cancellation is still pending", async () => {
  let pending = true;
  const transport = new BrowserRunnerTransport((requestInput) => {
    assert.equal(String(requestInput), `/api/runs/${RUN_ID}/stop`);
    return Promise.resolve(
      json(
        {
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run(pending ? "running" : "cancelled"),
        },
        pending ? 202 : 200
      )
    );
  });

  assert.deepEqual(await transport.stopRun(RUN_ID), {
    pending: true,
    run: run("running"),
  });

  pending = false;
  assert.deepEqual(await transport.stopRun(RUN_ID), {
    pending: false,
    run: run("cancelled"),
  });
});

test("owns every relative same-origin runner path and sends only browser session credentials", async () => {
  const calls: Array<{
    body: string | null;
    credentials?: RequestCredentials;
    headers: Headers;
    method: string;
    path: string;
  }> = [];
  const request = ((requestInput: RequestInfo | URL, init?: RequestInit) => {
    const path = String(requestInput);
    const method = init?.method ?? "GET";
    calls.push({
      body: typeof init?.body === "string" ? init.body : null,
      credentials: init?.credentials,
      headers: new Headers(init?.headers),
      method,
      path,
    });

    if (path === "/api/health") {
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          capabilities: [...AGENT_RUNNER_CAPABILITIES],
          minimumClientVersion: "1.0.0",
          mode: "cloud",
        })
      );
    }
    if (path === "/api/harnesses") {
      return Promise.resolve(
        json({
          harnesses: [
            {
              detail: "Ready",
              id: "copilot",
              installed: true,
              label: "GitHub Copilot CLI",
              streams: true,
              supported: true,
              version: "1.0.0",
            },
          ],
        })
      );
    }
    if (path === "/api/tenant/prewarm") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (path === `/api/agents/${AGENT_ID}/runs`) {
      return Promise.resolve(
        method === "POST"
          ? json({ apiVersion: AGENT_RUNNER_API_VERSION, run: run() }, 202)
          : json({ apiVersion: AGENT_RUNNER_API_VERSION, runs: [run()] })
      );
    }
    if (path === `/api/runs/${RUN_ID}/events`) {
      return Promise.resolve(
        new Response("", { headers: { "content-type": "text/event-stream" } })
      );
    }
    if (path === `/api/runs/${RUN_ID}/stop`) {
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run("cancelled"),
        })
      );
    }
    if (path === `/api/runs/${RUN_ID}`) {
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run("completed"),
        })
      );
    }
    if (path === `/api/agents/${AGENT_ID}` && method === "DELETE") {
      return Promise.resolve(json({ ok: true }));
    }
    if (path === `/api/agents/${AGENT_ID}`) {
      return Promise.resolve(json({ agent }));
    }
    if (path === "/api/agents" && method === "GET") {
      return Promise.resolve(json({ agents: [agent] }));
    }
    return Promise.resolve(json({ agent }, 201));
  }) as typeof fetch;
  const transport = new BrowserRunnerTransport(request, {
    reconnectDelayMs: 0,
  });
  const input = {
    backend: agent.backend,
    description: agent.description,
    instructions: agent.instructions,
    model: agent.model,
    name: agent.name,
    runtime: agent.runtime,
    workspace: agent.workspace,
  };

  await transport.health();
  await transport.listHarnesses();
  await transport.listAgents();
  await transport.getAgent(AGENT_ID);
  await transport.createAgent(
    input,
    undefined,
    "builtin-github-agent-scout-v1"
  );
  await transport.updateAgent(AGENT_ID, input);
  await transport.deleteAgent(AGENT_ID);
  await transport.prewarmTenant();
  await transport.listRuns(AGENT_ID);
  await transport.startRun(AGENT_ID, {
    operationId: OPERATION_ID,
    task: "Exercise transport.",
  });
  await transport.getRun(RUN_ID);
  await transport.streamRunEvents(RUN_ID, { onEvent: () => undefined });
  await transport.stopRun(RUN_ID);

  assert.deepEqual(
    calls.map(({ method, path }) => `${method} ${path}`),
    [
      "GET /api/health",
      "GET /api/harnesses",
      "GET /api/agents",
      `GET /api/agents/${AGENT_ID}`,
      "POST /api/agents",
      `PUT /api/agents/${AGENT_ID}`,
      `DELETE /api/agents/${AGENT_ID}`,
      "POST /api/tenant/prewarm",
      `GET /api/agents/${AGENT_ID}/runs`,
      `POST /api/agents/${AGENT_ID}/runs`,
      `GET /api/runs/${RUN_ID}`,
      `GET /api/runs/${RUN_ID}/events`,
      `GET /api/runs/${RUN_ID}`,
      `POST /api/runs/${RUN_ID}/stop`,
    ]
  );
  for (const call of calls) {
    assert.equal(call.credentials, "same-origin");
    assert.equal(call.headers.get("authorization"), null);
    assert.equal(call.headers.get(["x", "runner", "token"].join("-")), null);
    assert.equal(call.headers.get("x-vercel-protection-bypass"), null);
    assert.deepEqual(
      Object.fromEntries(call.headers),
      call.path.endsWith("/events")
        ? { accept: "text/event-stream" }
        : call.body
          ? {
              accept: "application/json",
              "content-type": "application/json",
              ...(call.method === "POST" && call.path === "/api/agents"
                ? {
                    "idempotency-key": "builtin-github-agent-scout-v1",
                  }
                : {}),
            }
          : { accept: "application/json" }
    );
    assert.ok(call.path.startsWith("/api/"));
    assert.doesNotMatch(call.path, /^https?:/);
  }
  assert.equal(
    calls
      .find((call) => call.method === "POST" && call.path === "/api/agents")
      ?.headers.get("content-type"),
    "application/json"
  );
  assert.equal(
    calls.find((call) => call.path.endsWith("/events"))?.headers.get("accept"),
    "text/event-stream"
  );
});

test("runner requests use the configured application base path", async () => {
  const previous = process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.NEXT_PUBLIC_BASE_PATH = "/demo";
  const paths: string[] = [];
  try {
    const transport = new BrowserRunnerTransport((input) => {
      paths.push(String(input));
      return Promise.resolve(json({ agents: [] }));
    });

    await transport.listAgents();
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_BASE_PATH = previous;
    }
  }
  assert.deepEqual(paths, ["/demo/api/agents"]);
});

test("accepts only the strict v1 error envelope", async () => {
  const valid = new BrowserRunnerTransport(() =>
    Promise.resolve(
      json(
        {
          apiVersion: AGENT_RUNNER_API_VERSION,
          error: {
            code: "subscription_required",
            details: "Renew the subscription.",
            message: "An active subscription is required.",
            retryable: false,
          },
          requestId: "request-1",
        },
        403
      )
    )
  );

  await assert.rejects(
    valid.listAgents(),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "subscription_required" &&
      error.details === "Renew the subscription." &&
      error.requestId === "request-1" &&
      error.retryable === false &&
      error.status === 403
  );

  const flat = new BrowserRunnerTransport(() =>
    Promise.resolve(json({ code: "unauthorized", error: "Legacy error." }, 401))
  );
  await assert.rejects(
    flat.listAgents(),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "invalid_error_envelope" &&
      error.status === 401
  );
});

test("valid v1 error envelopes keep their explicit retryability across statuses", async () => {
  const cases = [
    { retryable: false, status: 503 },
    { retryable: true, status: 403 },
  ] as const;

  await Promise.all(
    cases.map(async ({ retryable, status }) => {
      let attempts = 0;
      const transport = new BrowserRunnerTransport(
        () => {
          attempts += 1;
          return Promise.resolve(
            runnerError("explicit_retryability", retryable, status)
          );
        },
        { startRetryDelayMs: 0 }
      );

      await assert.rejects(
        transport.startRun(AGENT_ID, {
          operationId: OPERATION_ID,
          task: "Exercise transport.",
        }),
        (error: unknown) =>
          error instanceof RunnerApiError &&
          error.code === "explicit_retryability" &&
          error.retryable === retryable &&
          error.status === status
      );
      assert.equal(attempts, retryable ? 3 : 1);
    })
  );
});

test("rejects malformed success envelopes instead of stripping unknown fields", async () => {
  const transport = new BrowserRunnerTransport(() =>
    Promise.resolve(json({ agents: [agent], legacyEndpoint: "runner.invalid" }))
  );

  await assert.rejects(
    transport.listAgents(),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "invalid_response_envelope" &&
      error.status === 200
  );
});

test("wraps fetch failures in a typed transport error", async () => {
  const transport = new BrowserRunnerTransport(() =>
    Promise.reject(new TypeError("network down"))
  );

  await assert.rejects(
    transport.health(),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "network_error" &&
      error.status === 0
  );
});

test("start retries an ambiguous response with the identical operation id and returns one logical run", async () => {
  const bodies: string[] = [];
  const committed = new Map<string, RunSnapshot>();
  let created = 0;
  const transport = new BrowserRunnerTransport(
    (_requestInput, init) => {
      const body = String(init?.body);
      bodies.push(body);
      const input = JSON.parse(body) as {
        operationId: string;
        task: string;
      };
      let snapshot = committed.get(input.operationId);
      if (!snapshot) {
        created += 1;
        snapshot = {
          ...run(),
          operationId: input.operationId,
          task: input.task,
        };
        committed.set(input.operationId, snapshot);
      }
      if (bodies.length === 1) {
        return Promise.reject(new TypeError("response was lost"));
      }
      return Promise.resolve(
        json({ apiVersion: AGENT_RUNNER_API_VERSION, run: snapshot }, 202)
      );
    },
    { startRetryDelayMs: 0 }
  );

  const snapshot = await transport.startRun(AGENT_ID, {
    operationId: OPERATION_ID,
    task: "Exercise transport.",
  });

  assert.equal(bodies.length, 2);
  assert.equal(new Set(bodies).size, 1);
  assert.equal(
    (JSON.parse(bodies[0] ?? "{}") as { operationId?: string }).operationId,
    OPERATION_ID
  );
  assert.equal(created, 1);
  assert.equal(committed.size, 1);
  assert.equal(snapshot.id, RUN_ID);
});

test("start retries when a successful response body is lost after headers", async () => {
  const bodies: string[] = [];
  let attempts = 0;
  const accepted = {
    apiVersion: AGENT_RUNNER_API_VERSION,
    run: run(),
  };
  const transport = new BrowserRunnerTransport(
    (_requestInput, init) => {
      attempts += 1;
      bodies.push(String(init?.body));
      return Promise.resolve(
        attempts === 1 ? interruptedJson(accepted) : json(accepted, 202)
      );
    },
    { startRetryDelayMs: 0 }
  );

  const snapshot = await transport.startRun(AGENT_ID, {
    operationId: OPERATION_ID,
    task: "Exercise transport.",
  });

  assert.equal(attempts, 2);
  assert.deepEqual(bodies, [bodies[0], bodies[0]]);
  assert.equal(
    (JSON.parse(bodies[0] ?? "{}") as { operationId?: string }).operationId,
    OPERATION_ID
  );
  assert.equal(snapshot.status, "queued");
});

test("start retries malformed transient gateway responses with the identical operation id", async () => {
  const malformedResponses = [
    () =>
      new Response("<html>upstream unavailable</html>", {
        headers: { "content-type": "text/html" },
        status: 503,
      }),
    () => new Response(null, { status: 503 }),
  ];

  await Promise.all(
    malformedResponses.map(async (malformedResponse) => {
      const bodies: string[] = [];
      let attempts = 0;
      const transport = new BrowserRunnerTransport(
        (_requestInput, init) => {
          attempts += 1;
          bodies.push(String(init?.body));
          return Promise.resolve(
            attempts === 1
              ? malformedResponse()
              : json(
                  {
                    apiVersion: AGENT_RUNNER_API_VERSION,
                    run: run(),
                  },
                  202
                )
          );
        },
        { startRetryDelayMs: 0 }
      );

      const snapshot = await transport.startRun(AGENT_ID, {
        operationId: OPERATION_ID,
        task: "Exercise transport.",
      });

      assert.equal(attempts, 2);
      assert.deepEqual(bodies, [bodies[0], bodies[0]]);
      assert.equal(
        (JSON.parse(bodies[0] ?? "{}") as { operationId?: string }).operationId,
        OPERATION_ID
      );
      assert.equal(snapshot.status, "queued");
    })
  );
});

test("start bounds retries for malformed rate-limit responses", async () => {
  let attempts = 0;
  const transport = new BrowserRunnerTransport(
    () => {
      attempts += 1;
      return Promise.resolve(new Response("rate limited", { status: 429 }));
    },
    { startRetryDelayMs: 0 }
  );

  await assert.rejects(
    transport.startRun(AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Exercise transport.",
    }),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "invalid_error_envelope" &&
      error.retryable === true &&
      error.status === 429
  );
  assert.equal(attempts, 3);
});

test("start does not retry malformed authorization responses", async () => {
  let attempts = 0;
  const transport = new BrowserRunnerTransport(() => {
    attempts += 1;
    return Promise.resolve(
      new Response("<html>forbidden</html>", { status: 403 })
    );
  });

  await assert.rejects(
    transport.startRun(AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Exercise transport.",
    }),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "invalid_error_envelope" &&
      error.retryable === false &&
      error.status === 403
  );
  assert.equal(attempts, 1);
});

test("start does not retry malformed JSON or schema-invalid success envelopes", async () => {
  const responses = [
    () =>
      new Response('{"apiVersion":', {
        headers: { "content-type": "application/json" },
        status: 202,
      }),
    () => json({ apiVersion: AGENT_RUNNER_API_VERSION, run: {} }, 202),
  ];

  await Promise.all(
    responses.map(async (response) => {
      let attempts = 0;
      const transport = new BrowserRunnerTransport(
        () => {
          attempts += 1;
          return Promise.resolve(response());
        },
        { startRetryDelayMs: 0 }
      );

      await assert.rejects(
        transport.startRun(AGENT_ID, {
          operationId: OPERATION_ID,
          task: "Exercise transport.",
        }),
        (error: unknown) =>
          error instanceof RunnerApiError &&
          error.code === "invalid_response_envelope" &&
          error.retryable === false &&
          error.status === 202
      );
      assert.equal(attempts, 1);
    })
  );
});

test("non-start response body failures remain strict and nonretryable", async () => {
  const transport = new BrowserRunnerTransport(() =>
    Promise.resolve(
      interruptedJson({
        apiVersion: AGENT_RUNNER_API_VERSION,
        capabilities: [...AGENT_RUNNER_CAPABILITIES],
        minimumClientVersion: "1.0.0",
        mode: "cloud",
      })
    )
  );

  await assert.rejects(
    transport.health(),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "invalid_response_envelope" &&
      error.retryable === false &&
      error.status === 202
  );
});

test("start retries with bounded exponential backoff", async () => {
  const attempts: number[] = [];
  const transport = new BrowserRunnerTransport(
    () => {
      attempts.push(Date.now());
      return Promise.reject(new TypeError("network down"));
    },
    { startRetryDelayMs: 10 }
  );

  await assert.rejects(
    transport.startRun(AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Exercise transport.",
    }),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "network_error" &&
      error.retryable
  );

  assert.equal(attempts.length, 3);
  assert.ok((attempts[1] ?? 0) - (attempts[0] ?? 0) >= 8);
  assert.ok((attempts[2] ?? 0) - (attempts[1] ?? 0) >= 18);
});

test("start aborts during retry backoff without another request", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const transport = new BrowserRunnerTransport(
    () => {
      attempts += 1;
      return Promise.reject(new TypeError("network down"));
    },
    { startRetryDelayMs: 30_000 }
  );

  const pending = transport.startRun(
    AGENT_ID,
    {
      operationId: OPERATION_ID,
      task: "Exercise transport.",
    },
    controller.signal
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof RunnerApiError && error.code === "aborted"
  );
  assert.equal(attempts, 1);
});

test("start surfaces definitive nonretryable errors without retrying", async () => {
  let attempts = 0;
  const transport = new BrowserRunnerTransport(() => {
    attempts += 1;
    return Promise.resolve(runnerError("invalid_request", false, 400));
  });

  await assert.rejects(
    transport.startRun(AGENT_ID, {
      operationId: OPERATION_ID,
      task: "Exercise transport.",
    }),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "invalid_request" &&
      error.retryable === false &&
      error.status === 400
  );
  assert.equal(attempts, 1);
});

test("SSE reconnects with the last event cursor and resolves at a terminal snapshot", async () => {
  const eventHeaders: Array<string | null> = [];
  let streams = 0;
  let reads = 0;
  const transport = new BrowserRunnerTransport(
    (input, init) => {
      const path = String(input);
      if (path.endsWith("/events")) {
        streams += 1;
        eventHeaders.push(new Headers(init?.headers).get("last-event-id"));
        const event =
          streams === 1
            ? {
                id: 1,
                output: "working",
                type: "output",
              }
            : {
                id: 2,
                run: run("completed"),
                type: "completed",
              };
        return Promise.resolve(
          new Response(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          })
        );
      }
      reads += 1;
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run(reads === 1 ? "running" : "completed"),
        })
      );
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  const terminal = await transport.streamRunEvents(RUN_ID, {
    lastEventId: 0,
    onEvent: (event) => events.push(event.id),
  });

  assert.deepEqual(events, [1, 2]);
  assert.deepEqual(eventHeaders, [null, "1"]);
  assert.equal(terminal.status, "completed");
});

test("SSE reconnects after a retryable stream failure without losing its cursor", async () => {
  let streamAttempts = 0;
  let snapshotReads = 0;
  const cursors: Array<string | null> = [];
  const transport = new BrowserRunnerTransport(
    (requestInput, init) => {
      if (String(requestInput).endsWith("/events")) {
        streamAttempts += 1;
        cursors.push(new Headers(init?.headers).get("last-event-id"));
        if (streamAttempts === 1) {
          return Promise.resolve(
            new Response(
              `data: ${JSON.stringify({ id: 1, output: "first", type: "output" })}\n\n`,
              { headers: { "content-type": "text/event-stream" } }
            )
          );
        }
        if (streamAttempts === 2) {
          return Promise.reject(new TypeError("connection reset"));
        }
        return Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ id: 2, run: run("completed"), type: "completed" })}\n\n`,
            { headers: { "content-type": "text/event-stream" } }
          )
        );
      }
      snapshotReads += 1;
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run(snapshotReads < 3 ? "running" : "completed"),
        })
      );
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  const terminal = await transport.streamRunEvents(RUN_ID, {
    onEvent: (event) => events.push(event.id),
  });

  assert.deepEqual(events, [1, 2]);
  assert.deepEqual(cursors, [null, "1", "1"]);
  assert.equal(terminal.status, "completed");
});

test("SSE persists a delivered cursor before a reader failure and ignores replayed or lower ids", async () => {
  const cursors: Array<string | null> = [];
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput, init) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        cursors.push(new Headers(init?.headers).get("last-event-id"));
        if (streams === 1) {
          return Promise.resolve(
            interruptedEventStream(
              `data: ${JSON.stringify({ id: 1, output: "first", type: "output" })}\n\n`
            )
          );
        }
        return Promise.resolve(
          new Response(
            [
              `data: ${JSON.stringify({ id: 1, output: "duplicate", type: "output" })}`,
              "",
              `data: ${JSON.stringify({ id: 0, output: "lower", type: "output" })}`,
              "",
              `data: ${JSON.stringify({ id: 2, run: run("completed"), type: "completed" })}`,
              "",
              "",
            ].join("\n"),
            { headers: { "content-type": "text/event-stream" } }
          )
        );
      }
      snapshots += 1;
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run("running"),
        })
      );
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  const terminal = await transport.streamRunEvents(RUN_ID, {
    onEvent: (event) => events.push(event.id),
  });

  assert.deepEqual(cursors, [null, "1"]);
  assert.deepEqual(events, [1, 2]);
  assert.equal(snapshots, 1);
  assert.equal(terminal.status, "completed");
});

test("SSE retries a retryable snapshot failure through the reconnect loop", async () => {
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          streams === 1
            ? new Response("", {
                headers: { "content-type": "text/event-stream" },
              })
            : new Response(
                `data: ${JSON.stringify({ id: 1, run: run("completed"), type: "completed" })}\n\n`,
                { headers: { "content-type": "text/event-stream" } }
              )
        );
      }
      snapshots += 1;
      return Promise.resolve(runnerError("runner_unavailable", true, 503));
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  const terminal = await transport.streamRunEvents(RUN_ID, {
    onEvent: (event) => events.push(event.id),
  });

  assert.equal(snapshots, 1);
  assert.equal(streams, 2);
  assert.deepEqual(events, [1]);
  assert.equal(terminal.status, "completed");
});

test("SSE recovers from a malformed transient gateway response through a running snapshot", async () => {
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          streams === 1
            ? new Response("<html>upstream unavailable</html>", { status: 503 })
            : new Response(
                `data: ${JSON.stringify({ id: 1, run: run("completed"), type: "completed" })}\n\n`,
                { headers: { "content-type": "text/event-stream" } }
              )
        );
      }
      snapshots += 1;
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run("running"),
        })
      );
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  const terminal = await transport.streamRunEvents(RUN_ID, {
    onEvent: (event) => events.push(event.id),
  });

  assert.equal(streams, 2);
  assert.equal(snapshots, 1);
  assert.deepEqual(events, [1]);
  assert.equal(terminal.status, "completed");
});

test("SSE surfaces a malformed authorization response immediately", async () => {
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          new Response("<html>forbidden</html>", { status: 403 })
        );
      }
      snapshots += 1;
      throw new Error("snapshot must not be requested");
    },
    { reconnectDelayMs: 0 }
  );

  await assert.rejects(
    transport.streamRunEvents(RUN_ID, { onEvent: () => undefined }),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "invalid_error_envelope" &&
      error.retryable === false &&
      error.status === 403
  );
  assert.equal(streams, 1);
  assert.equal(snapshots, 0);
});

test("SSE retries a network snapshot failure through the reconnect loop", async () => {
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          streams === 1
            ? new Response("", {
                headers: { "content-type": "text/event-stream" },
              })
            : new Response(
                `data: ${JSON.stringify({ id: 1, run: run("completed"), type: "completed" })}\n\n`,
                { headers: { "content-type": "text/event-stream" } }
              )
        );
      }
      snapshots += 1;
      return Promise.reject(new TypeError("network down"));
    },
    { reconnectDelayMs: 0 }
  );

  const terminal = await transport.streamRunEvents(RUN_ID, {
    onEvent: () => undefined,
  });

  assert.equal(snapshots, 1);
  assert.equal(streams, 2);
  assert.equal(terminal.status, "completed");
});

test("SSE surfaces a non-retryable snapshot failure", async () => {
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          new Response("", {
            headers: { "content-type": "text/event-stream" },
          })
        );
      }
      return Promise.resolve(runnerError("run_forbidden", false, 403));
    },
    { reconnectDelayMs: 0 }
  );

  await assert.rejects(
    transport.streamRunEvents(RUN_ID, { onEvent: () => undefined }),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "run_forbidden" &&
      error.retryable === false &&
      error.status === 403
  );
  assert.equal(streams, 1);
});

test("SSE aborts a pending snapshot promptly", async () => {
  const controller = new AbortController();
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput, init) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          new Response("", {
            headers: { "content-type": "text/event-stream" },
          })
        );
      }
      snapshots += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true }
        );
      });
    },
    { reconnectDelayMs: 30_000 }
  );

  const pending = transport.streamRunEvents(RUN_ID, {
    onEvent: () => undefined,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof RunnerApiError && error.code === "aborted"
  );
  assert.equal(streams, 1);
  assert.equal(snapshots, 1);
});

test("SSE returns a terminal event once without reading or reconnecting again", async () => {
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          interruptedEventStream(
            `data: ${JSON.stringify({ id: 1, run: run("completed"), type: "completed" })}\n\n`
          )
        );
      }
      snapshots += 1;
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run("completed"),
        })
      );
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  const terminal = await transport.streamRunEvents(RUN_ID, {
    onEvent: (event) => events.push(event.id),
  });

  assert.deepEqual(events, [1]);
  assert.equal(streams, 1);
  assert.equal(snapshots, 0);
  assert.equal(terminal.status, "completed");
});

test("SSE retries snapshots without reopening after a terminal event", async () => {
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          interruptedEventStream(
            `data: ${JSON.stringify({
              error: {
                code: "runner_failed",
                message: "Runner failed.",
                retryable: false,
              },
              id: 1,
              type: "failed",
            })}\n\n`
          )
        );
      }
      snapshots += 1;
      return Promise.resolve(
        snapshots === 1
          ? runnerError("runner_unavailable", true, 503)
          : json({
              apiVersion: AGENT_RUNNER_API_VERSION,
              run: run("failed"),
            })
      );
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  const terminal = await transport.streamRunEvents(RUN_ID, {
    onEvent: (event) => events.push(event.id),
  });

  assert.deepEqual(events, [1]);
  assert.equal(streams, 1);
  assert.equal(snapshots, 2);
  assert.equal(terminal.status, "failed");
});

test("SSE preserves the last valid cursor when a later frame is truncated", async () => {
  const cursors: Array<string | null> = [];
  let snapshots = 0;
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (requestInput, init) => {
      if (String(requestInput).endsWith("/events")) {
        streams += 1;
        cursors.push(new Headers(init?.headers).get("last-event-id"));
        if (streams === 1) {
          return Promise.resolve(
            new Response(
              `data: ${JSON.stringify({ id: 1, output: "valid", type: "output" })}\n\ndata: {"id":2`,
              { headers: { "content-type": "text/event-stream" } }
            )
          );
        }
        return Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ id: 2, run: run("completed"), type: "completed" })}\n\n`,
            { headers: { "content-type": "text/event-stream" } }
          )
        );
      }
      snapshots += 1;
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run("running"),
        })
      );
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  const terminal = await transport.streamRunEvents(RUN_ID, {
    onEvent: (event) => events.push(event.id),
  });

  assert.deepEqual(cursors, [null, "1"]);
  assert.deepEqual(events, [1, 2]);
  assert.equal(snapshots, 1);
  assert.equal(terminal.status, "completed");
});

test("SSE rejects a malformed frame without advancing past the last valid event", async () => {
  const transport = new BrowserRunnerTransport(
    (requestInput) => {
      if (String(requestInput).endsWith("/events")) {
        return Promise.resolve(
          new Response(
            `data: ${JSON.stringify({ id: 1, output: "valid", type: "output" })}\n\ndata: {"id":2}\n\n`,
            { headers: { "content-type": "text/event-stream" } }
          )
        );
      }
      throw new Error("snapshot must not be requested");
    },
    { reconnectDelayMs: 0 }
  );
  const events: number[] = [];

  await assert.rejects(
    transport.streamRunEvents(RUN_ID, {
      onEvent: (event) => events.push(event.id),
    }),
    (error: unknown) =>
      error instanceof RunnerApiError && error.code === "invalid_event"
  );
  assert.deepEqual(events, [1]);
});

test("SSE aborts a pending reconnect promptly without opening another stream", async () => {
  const controller = new AbortController();
  let streams = 0;
  const transport = new BrowserRunnerTransport(
    (input) => {
      if (String(input).endsWith("/events")) {
        streams += 1;
        return Promise.resolve(
          new Response("", {
            headers: { "content-type": "text/event-stream" },
          })
        );
      }
      return Promise.resolve(
        json({
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: run("running"),
        })
      );
    },
    { reconnectDelayMs: 30_000 }
  );

  const pending = transport.streamRunEvents(RUN_ID, {
    onEvent: () => undefined,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof RunnerApiError && error.code === "aborted"
  );
  assert.equal(streams, 1);
});

test("SSE aborts a pending stream read promptly without requesting a snapshot", async () => {
  const controller = new AbortController();
  let snapshots = 0;
  const transport = new BrowserRunnerTransport((requestInput) => {
    if (String(requestInput).endsWith("/events")) {
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({ start: () => undefined }),
          {
            headers: { "content-type": "text/event-stream" },
          }
        )
      );
    }
    snapshots += 1;
    return Promise.resolve(
      json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: run("running"),
      })
    );
  });

  const pending = transport.streamRunEvents(RUN_ID, {
    onEvent: () => undefined,
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof RunnerApiError && error.code === "aborted"
  );
  assert.equal(snapshots, 0);
});
