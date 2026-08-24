import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  type RunEvent,
  type RunSnapshot,
} from "@opencoven/agent-contracts";
import {
  captureRun,
  readCaptureEnvironment,
  readRunEventStream,
} from "./demo-capture";

const AGENT_ID = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
const RUN_ID = "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce";
const OPERATION_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const CREATED_AT = "2026-08-24T19:03:49.798Z";

const acceptedEvent: RunEvent = {
  id: 1,
  operationId: OPERATION_ID,
  runId: RUN_ID,
  type: "accepted",
};

const outputEvent: RunEvent = {
  id: 2,
  output: "Working.",
  type: "output",
};

function snapshot(status: RunSnapshot["status"]): RunSnapshot {
  return {
    agentId: AGENT_ID,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [],
    completedAt:
      status === "queued" || status === "running"
        ? null
        : "2026-08-24T19:04:49.798Z",
    createdAt: CREATED_AT,
    fileEvidence: [],
    id: RUN_ID,
    operationId: OPERATION_ID,
    output: status === "completed" ? "Done." : "",
    startedAt: status === "queued" ? null : "2026-08-24T19:03:50.798Z",
    status,
    task: "Add a parser test.",
  };
}

function eventStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function sse(...events: readonly RunEvent[]): string {
  return events
    .map(
      (event) =>
        `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    )
    .join("");
}

test("parses events across arbitrary SSE chunk boundaries", async () => {
  const payload = sse(acceptedEvent, outputEvent);
  const observed: RunEvent[] = [];

  const terminal = await readRunEventStream(
    eventStream([
      payload.slice(0, 7),
      payload.slice(7, 41),
      payload.slice(41, 93),
      payload.slice(93),
    ]),
    (event) => observed.push(event)
  );

  assert.equal(terminal, false);
  assert.deepEqual(observed, [acceptedEvent, outputEvent]);
});

test("joins multiple data lines and parses multiple SSE events", async () => {
  const multiline = JSON.stringify(acceptedEvent).replace(
    ',"runId"',
    ',\n"runId"'
  );
  const payload = `${multiline
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n")}\n\ndata: ${JSON.stringify(outputEvent)}\n\n`;
  const observed: RunEvent[] = [];

  await readRunEventStream(eventStream([payload]), (event) =>
    observed.push(event)
  );

  assert.deepEqual(observed, [acceptedEvent, outputEvent]);
});

test("rejects every SSE data payload that fails the run event schema", async () => {
  const invalid = 'data: {"id":1,"output":42,"type":"output"}\n\n';

  await assert.rejects(
    () => readRunEventStream(eventStream([invalid]), () => undefined),
    /run event schema validation/i
  );
});

test("fails closed with the exact missing runner variable names", () => {
  assert.throws(
    () => readCaptureEnvironment({}),
    (error: Error) => {
      assert.match(
        error.message,
        /DEMO_RUNNER_URL.*NEXT_PUBLIC_CLOUD_RUNNER_URL/
      );
      assert.match(error.message, /DEMO_RUNNER_TOKEN/);
      assert.match(error.message, /DEMO_RUNNER_IDENTITY_TOKEN/);
      return true;
    }
  );
});

test("uses the public runner URL fallback and a finite default timeout", () => {
  const configuration = readCaptureEnvironment({
    DEMO_RUNNER_IDENTITY_TOKEN: "identity",
    DEMO_RUNNER_TOKEN: "gate",
    NEXT_PUBLIC_CLOUD_RUNNER_URL: "https://runner.example/",
  });

  assert.equal(configuration.runnerUrl, "https://runner.example");
  assert.equal(configuration.timeoutMs, 15 * 60 * 1000);
});

test("reconnects with a cursor, deduplicates arrivals, and stops at terminal completion", async () => {
  const completedEvent: RunEvent = {
    id: 2,
    run: snapshot("completed"),
    type: "completed",
  };
  const calls: {
    body: string;
    headers: Headers;
    method: string;
    path: string;
  }[] = [];
  let eventRequests = 0;
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(String(input));
    const call = {
      body: typeof init.body === "string" ? init.body : "",
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      path: url.pathname,
    };
    calls.push(call);

    if (url.pathname === "/api/agents" && call.method === "POST") {
      return Response.json(
        {
          agent: {
            backend: "cloud",
            createdAt: CREATED_AT,
            description: "Temporary demo recording agent",
            id: AGENT_ID,
            instructions: "Restricted.",
            lastRunAt: null,
            model: "auto",
            name: "demo-recording",
            owner: { kind: "tenant", tenantId: "tenant-1" },
            runtime: "copilot",
            status: "idle",
            updatedAt: CREATED_AT,
            workspace: "/workspace",
          },
        },
        { status: 201 }
      );
    }
    if (
      url.pathname === `/api/agents/${AGENT_ID}/runs` &&
      call.method === "POST"
    ) {
      return Response.json(
        {
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: snapshot("queued"),
        },
        { status: 202 }
      );
    }
    if (url.pathname === `/api/runs/${RUN_ID}/events`) {
      eventRequests += 1;
      if (eventRequests === 1) {
        return new Response(sse(acceptedEvent), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      assert.equal(call.headers.get("last-event-id"), "1");
      return new Response(sse(acceptedEvent, completedEvent), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.pathname === `/api/runs/${RUN_ID}` && call.method === "GET") {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("completed"),
      });
    }
    if (
      url.pathname === `/api/agents/${AGENT_ID}` &&
      call.method === "DELETE"
    ) {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: call }, { status: 500 });
  };
  const times = [100, 110, 120];

  const captured = await captureRun(
    {
      repository: "OpenCoven/demo-workspace",
      task: "Add a parser test.",
    },
    {
      environment: {
        DEMO_RECORDING_CREDENTIAL: "tenant-harness-secret",
        DEMO_RUNNER_IDENTITY_TOKEN: "identity",
        DEMO_RUNNER_TOKEN: "gate",
        DEMO_RUNNER_URL: "https://runner.example/",
      },
      now: () => times.shift() ?? 999,
      randomUUID: () => OPERATION_ID,
      request,
    }
  );

  assert.deepEqual(
    captured.arrivals.map(({ event, receivedAt }) => ({
      id: event.id,
      receivedAt,
    })),
    [
      { id: 1, receivedAt: 100 },
      { id: 2, receivedAt: 120 },
    ]
  );
  assert.equal(captured.result.status, "completed");
  assert.equal(eventRequests, 2);
  assert.equal(
    calls.at(-1)?.path,
    `/api/agents/${AGENT_ID}`,
    "the temporary agent is deleted after capture"
  );
  for (const call of calls) {
    assert.equal(call.headers.get("x-runner-token"), "gate");
    assert.equal(call.headers.get("authorization"), "Bearer identity");
  }
  const createInput = JSON.parse(calls[0]?.body ?? "{}") as {
    backend?: string;
    instructions?: string;
    model?: string;
    runtime?: string;
    workspace?: string;
  };
  assert.equal(createInput.backend, "cloud");
  assert.equal(createInput.runtime, "copilot");
  assert.equal(createInput.model, "auto");
  assert.equal(createInput.workspace, "/workspace");
  assert.match(
    createInput.instructions ?? "",
    /clone https:\/\/github\.com\/OpenCoven\/demo-workspace\.git into \/workspace\/repo/
  );
  assert.match(createInput.instructions ?? "", /only (?:inside|there)/i);
  assert.ok(
    calls.every((call) => !call.body.includes("tenant-harness-secret")),
    "the harness credential is never sent to the runner"
  );
});

test("deletes the temporary agent after a capture failure", async () => {
  const methods: string[] = [];
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    methods.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/api/agents") {
      return Response.json({
        agent: {
          backend: "cloud",
          createdAt: CREATED_AT,
          description: "",
          id: AGENT_ID,
          instructions: "Restricted.",
          lastRunAt: null,
          model: "auto",
          name: "demo-recording",
          owner: { kind: "tenant", tenantId: "tenant-1" },
          runtime: "copilot",
          status: "idle",
          updatedAt: CREATED_AT,
          workspace: "/workspace",
        },
      });
    }
    if (path.endsWith("/runs")) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("queued"),
      });
    }
    if (path.endsWith("/events")) {
      return new Response('data: {"id":1,"output":false,"type":"output"}\n\n');
    }
    if (init.method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: true }, { status: 500 });
  };

  await assert.rejects(
    () =>
      captureRun(
        {
          repository: "OpenCoven/demo-workspace",
          task: "Add a parser test.",
        },
        {
          environment: {
            DEMO_RUNNER_IDENTITY_TOKEN: "identity",
            DEMO_RUNNER_TOKEN: "gate",
            DEMO_RUNNER_URL: "https://runner.example",
          },
          randomUUID: () => OPERATION_ID,
          request,
        }
      ),
    /run event schema validation/i
  );
  assert.equal(methods.at(-1), `DELETE /api/agents/${AGENT_ID}`);
});

test("surfaces cleanup failure while preserving the primary failure context", async () => {
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/agents") {
      return Response.json({
        agent: {
          backend: "cloud",
          createdAt: CREATED_AT,
          description: "",
          id: AGENT_ID,
          instructions: "Restricted.",
          lastRunAt: null,
          model: "auto",
          name: "demo-recording",
          owner: { kind: "tenant", tenantId: "tenant-1" },
          runtime: "copilot",
          status: "idle",
          updatedAt: CREATED_AT,
          workspace: "/workspace",
        },
      });
    }
    if (path.endsWith("/runs")) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("queued"),
      });
    }
    if (path.endsWith("/events")) {
      return new Response('data: {"id":1,"output":false,"type":"output"}\n\n');
    }
    if (init.method === "DELETE") {
      return Response.json(
        {
          apiVersion: AGENT_RUNNER_API_VERSION,
          error: {
            code: "cleanup_failed",
            message: "Temporary agent could not be deleted.",
            retryable: true,
          },
          requestId: RUN_ID,
        },
        { status: 500 }
      );
    }
    return Response.json({ unexpected: true }, { status: 500 });
  };

  await assert.rejects(
    () =>
      captureRun(
        {
          repository: "OpenCoven/demo-workspace",
          task: "Add a parser test.",
        },
        {
          environment: {
            DEMO_RUNNER_IDENTITY_TOKEN: "identity",
            DEMO_RUNNER_TOKEN: "gate",
            DEMO_RUNNER_URL: "https://runner.example",
          },
          randomUUID: () => OPERATION_ID,
          request,
        }
      ),
    (error: Error) => {
      assert.match(error.message, /run event schema validation/i);
      assert.match(error.message, /cleanup/i);
      assert.doesNotMatch(error.message, /identity|gate/);
      return true;
    }
  );
});
