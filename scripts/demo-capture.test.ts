import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
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
const RECORDING_CREDENTIAL = "recording-credential-sensitive";
const AUTH_SECRET = "application-auth-secret-sensitive";
const SESSION_COOKIE = "session-cookie-sensitive";
const APP_ORIGIN = "https://app.example";
const RECORDER_EMAIL = "Recorder@example.com";
const RECORDER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const CONFIGURED_SECRETS = [
  AUTH_SECRET,
  SESSION_COOKIE,
  RECORDING_CREDENTIAL,
  RECORDER_EMAIL,
];

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

function interruptedEventStream(
  completePrefix: string
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let delivered = false;
  return new ReadableStream({
    pull(controller) {
      if (!delivered) {
        delivered = true;
        controller.enqueue(encoder.encode(completePrefix));
        return;
      }
      controller.error(new Error("simulated transport interruption"));
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

function agentResponse(): Response {
  return Response.json({
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
      warm: { status: "not_started", updatedAt: CREATED_AT },
      workspace: "/workspace",
    },
  });
}

function agentDefinition(
  name: string,
  id: string = AGENT_ID
): Record<string, unknown> {
  return {
    backend: "cloud",
    createdAt: CREATED_AT,
    description: "Temporary demo recording agent",
    id,
    instructions: "Restricted.",
    lastRunAt: null,
    model: "auto",
    name,
    owner: { kind: "tenant", tenantId: "tenant-1" },
    runtime: "copilot",
    status: "idle",
    updatedAt: CREATED_AT,
    warm: { status: "not_started", updatedAt: CREATED_AT },
    workspace: "/workspace",
  };
}

function recordingEnvironment(
  overrides: Record<string, string | undefined> = {}
) {
  return {
    APP_ORIGIN,
    AUTH_SECRET,
    AUTH_URL: APP_ORIGIN,
    DEMO_RECORDER_ACCOUNT_EMAIL: RECORDER_EMAIL,
    DEMO_RECORDING_CREDENTIAL: RECORDING_CREDENTIAL,
    ...overrides,
  };
}

const recorderLookup = {
  findRecorderUser: async () => ({
    authVersion: 7,
    email: RECORDER_EMAIL.toLowerCase(),
    emailVerified: true,
    id: RECORDER_ID,
    subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
  }),
};

function assertNoConfiguredSecrets(error: unknown): boolean {
  const rendered = `${String(error)}\n${inspect(error, { depth: 10 })}`;
  for (const secret of CONFIGURED_SECRETS) {
    assert.equal(
      rendered.includes(secret),
      false,
      `${secret} must be redacted`
    );
  }
  return true;
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

test("a terminal status does not discard a following terminal event in the same response", async () => {
  const statusEvent: RunEvent = {
    id: 2,
    status: "completed",
    type: "status",
  };
  const completedEvent: RunEvent = {
    id: 3,
    run: snapshot("completed"),
    type: "completed",
  };
  const observed: RunEvent[] = [];

  const terminal = await readRunEventStream(
    eventStream([sse(statusEvent, completedEvent)]),
    (event) => observed.push(event)
  );

  assert.equal(terminal, true);
  assert.deepEqual(observed, [statusEvent, completedEvent]);
});

test("a completed status event is terminal without a completed event", async () => {
  const statusEvent: RunEvent = {
    id: 2,
    status: "completed",
    type: "status",
  };

  const terminal = await readRunEventStream(
    eventStream([sse(statusEvent)]),
    () => undefined
  );

  assert.equal(terminal, true);
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

test("fails closed with the exact missing application session variables", () => {
  assert.throws(
    () => readCaptureEnvironment({}),
    (error: Error) => {
      assert.match(error.message, /APP_ORIGIN/);
      assert.match(error.message, /AUTH_SECRET/);
      assert.match(error.message, /DEMO_RECORDER_ACCOUNT_EMAIL/);
      assert.doesNotMatch(error.message, /DEMO_RUNNER|CLOUD_RUNNER/);
      return true;
    }
  );
});

test("uses the deployed application origin and a finite default timeout", () => {
  const configuration = readCaptureEnvironment({
    APP_ORIGIN: "https://app.example/",
    AUTH_SECRET,
    AUTH_URL: APP_ORIGIN,
    DEMO_RECORDER_ACCOUNT_EMAIL: RECORDER_EMAIL,
  });

  assert.equal(configuration.appOrigin, APP_ORIGIN);
  assert.equal(configuration.accountEmail, RECORDER_EMAIL);
  assert.equal(configuration.timeoutMs, 15 * 60 * 1000);
});

test("rejects unsafe or noncanonical application origins", () => {
  const unsafe = [
    {
      APP_ORIGIN: "http://app.example",
      AUTH_URL: "http://app.example",
    },
    {
      APP_ORIGIN: "https://other.example",
      AUTH_URL: APP_ORIGIN,
    },
    {
      APP_ORIGIN: "https://other.example",
      AUTH_URL: APP_ORIGIN,
      VERCEL_URL: "other.example",
    },
    {
      APP_ORIGIN: "https://app.example:444",
      AUTH_URL: APP_ORIGIN,
    },
    {
      APP_ORIGIN: "https://user:password@app.example",
      AUTH_URL: APP_ORIGIN,
    },
    {
      APP_ORIGIN: "ftp://app.example",
      AUTH_URL: "ftp://app.example",
    },
    {
      APP_ORIGIN: "https://app.example/path",
      AUTH_URL: APP_ORIGIN,
    },
    {
      APP_ORIGIN: "https://app.example/path/..",
      AUTH_URL: APP_ORIGIN,
    },
    {
      APP_ORIGIN: "https://app.example?query=1",
      AUTH_URL: APP_ORIGIN,
    },
    {
      APP_ORIGIN: "https://app.example#fragment",
      AUTH_URL: APP_ORIGIN,
    },
    {
      APP_ORIGIN: "https://app.example",
      AUTH_URL: undefined,
      NEXTAUTH_URL: undefined,
      VERCEL_PROJECT_PRODUCTION_URL: undefined,
      VERCEL_URL: undefined,
    },
  ];

  for (const environment of unsafe) {
    assert.throws(
      () =>
        readCaptureEnvironment(
          recordingEnvironment(
            environment as Record<string, string | undefined>
          )
        ),
      /APP_ORIGIN|application origin|https|authority/i,
      JSON.stringify(environment)
    );
  }
});

test("accepts an exactly approved HTTPS origin and explicit loopback development origins", () => {
  assert.equal(
    readCaptureEnvironment(
      recordingEnvironment({
        APP_ORIGIN: "https://preview.example",
        AUTH_URL: "https://preview.example",
      })
    ).appOrigin,
    "https://preview.example"
  );
  assert.equal(
    readCaptureEnvironment(
      recordingEnvironment({
        APP_ORIGIN: "https://preview.example",
        AUTH_URL: undefined,
        VERCEL_URL: "preview.example",
      })
    ).appOrigin,
    "https://preview.example"
  );

  for (const appOrigin of [
    "http://localhost:3000",
    "http://127.0.0.1:3100",
    "http://[::1]:3200",
  ]) {
    assert.equal(
      readCaptureEnvironment(
        recordingEnvironment({
          APP_ORIGIN: appOrigin,
          AUTH_URL: undefined,
        })
      ).appOrigin,
      appOrigin
    );
  }
});

test("an unapproved origin is rejected before account lookup or any request", async () => {
  let lookups = 0;
  let requests = 0;

  await assert.rejects(
    () =>
      captureRun(
        { repository: "OpenCoven/demo-workspace", task: "Add a parser test." },
        {
          environment: recordingEnvironment({
            APP_ORIGIN: "https://other.example",
            AUTH_URL: APP_ORIGIN,
          }),
          findRecorderUser: () => {
            lookups += 1;
            return Promise.resolve(null);
          },
          request: () => {
            requests += 1;
            return Promise.resolve(Response.json({}));
          },
        }
      ),
    /application origin|authority/i
  );

  assert.equal(lookups, 0);
  assert.equal(requests, 0);
});

test("loopback development capture sends the session cookie only to that origin", async () => {
  const calls: { headers: Headers; url: string }[] = [];

  await assert.rejects(
    () =>
      captureRun(
        { repository: "OpenCoven/demo-workspace", task: "Add a parser test." },
        {
          ...recorderLookup,
          createSessionCookie: () => Promise.resolve(SESSION_COOKIE),
          environment: recordingEnvironment({
            APP_ORIGIN: "http://127.0.0.1:3100",
            AUTH_URL: undefined,
          }),
          randomUUID: () => OPERATION_ID,
          request: (input, init) => {
            calls.push({
              headers: new Headers(init?.headers),
              url: String(input),
            });
            return Promise.resolve(Response.json({}, { status: 500 }));
          },
        }
      ),
    /runner request/i
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:3100/api/agents");
  assert.equal(
    calls[0]?.headers.get("cookie"),
    `authjs.session-token=${SESSION_COOKIE}`
  );
  assert.equal(calls[0]?.headers.get("authorization"), null);
});

test("recorder session cookies come from the verified account authority", async () => {
  let sessionInput: unknown;

  await assert.rejects(
    () =>
      captureRun(
        { repository: "OpenCoven/demo-workspace", task: "Add a parser test." },
        {
          ...recorderLookup,
          createSessionCookie: (input) => {
            sessionInput = input;
            return Promise.resolve(SESSION_COOKIE);
          },
          environment: recordingEnvironment(),
          findRecorderUser: async () => ({
            authVersion: 12,
            email: RECORDER_EMAIL.toLowerCase(),
            emailVerified: true,
            id: RECORDER_ID,
            subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
          }),
          randomUUID: () => OPERATION_ID,
          request: async () => Response.json({}, { status: 500 }),
        }
      ),
    /runner request/i
  );

  assert.deepEqual(sessionInput, {
    authVersion: 12,
    email: RECORDER_EMAIL.toLowerCase(),
    id: RECORDER_ID,
    subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
  });
});

test("recorder refuses an account that is not currently subscribed", async () => {
  let requests = 0;

  await assert.rejects(
    () =>
      captureRun(
        { repository: "OpenCoven/demo-workspace", task: "Add a parser test." },
        {
          ...recorderLookup,
          environment: recordingEnvironment(),
          findRecorderUser: async () => ({
            authVersion: 12,
            email: RECORDER_EMAIL.toLowerCase(),
            emailVerified: true,
            id: RECORDER_ID,
            subscribedUntil: null,
          }),
          request: () => {
            requests += 1;
            return Promise.resolve(Response.json({}));
          },
        }
      ),
    /subscription/i
  );

  assert.equal(requests, 0);
});

test("sends one authenticated same-origin session cookie on every request including cleanup", async () => {
  const terminalStatus: RunEvent = {
    id: 2,
    status: "completed",
    type: "status",
  };
  const calls: { credentials?: RequestCredentials; headers: Headers }[] = [];
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    calls.push({
      credentials: init.credentials,
      headers: new Headers(init.headers),
    });
    if (path === "/api/agents" && init.method === "POST") {
      return agentResponse();
    }
    if (path === `/api/agents/${AGENT_ID}/runs`) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("queued"),
      });
    }
    if (path === `/api/runs/${RUN_ID}/events`) {
      return new Response(sse(acceptedEvent, terminalStatus));
    }
    if (path === `/api/runs/${RUN_ID}`) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("completed"),
      });
    }
    if (path === `/api/agents/${AGENT_ID}` && init.method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  await captureRun(
    {
      repository: "OpenCoven/demo-workspace",
      task: "Add a parser test.",
    },
    {
      ...recorderLookup,
      createSessionCookie: () => Promise.resolve(SESSION_COOKIE),
      environment: recordingEnvironment(),
      findRecorderUser: async () => ({
        authVersion: 7,
        email: RECORDER_EMAIL.toLowerCase(),
        emailVerified: true,
        id: RECORDER_ID,
        subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
      }),
      randomUUID: () => OPERATION_ID,
      request,
    }
  );

  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.equal(call.credentials, "same-origin");
    assert.match(
      call.headers.get("cookie") ?? "",
      /^__Secure-authjs\.session-token=session-cookie-sensitive$/
    );
    assert.equal(call.headers.get("authorization"), null);
    assert.equal(call.headers.get("x-runner-token"), null);
    assert.equal(call.headers.get("origin"), APP_ORIGIN);
  }
});

test("an initial runner error cannot expose configured session secrets or credentials", async () => {
  const request = async (): Promise<Response> =>
    Response.json(
      {
        apiVersion: AGENT_RUNNER_API_VERSION,
        error: {
          code: "upstream_rejected",
          message: `${AUTH_SECRET} ${SESSION_COOKIE} ${RECORDING_CREDENTIAL}`,
          retryable: false,
        },
        requestId: RUN_ID,
      },
      { status: 500 }
    );

  await assert.rejects(
    () =>
      captureRun(
        {
          repository: "OpenCoven/demo-workspace",
          task: "Add a parser test.",
        },
        {
          ...recorderLookup,
          createSessionCookie: () => Promise.resolve(SESSION_COOKIE),
          environment: recordingEnvironment(),
          randomUUID: () => OPERATION_ID,
          request,
        }
      ),
    assertNoConfiguredSecrets
  );
});

async function captureAfterRecoverableStream(
  firstStream: Error | ReadableStream<Uint8Array>
) {
  const terminalStatus: RunEvent = {
    id: 2,
    status: "completed",
    type: "status",
  };
  const cursors: string[] = [];
  const sleeps: number[] = [];
  let cleanupRequests = 0;
  let eventRequests = 0;
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/agents" && init.method === "POST") {
      return agentResponse();
    }
    if (path === `/api/agents/${AGENT_ID}/runs`) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("queued"),
      });
    }
    if (path === `/api/runs/${RUN_ID}/events`) {
      eventRequests += 1;
      cursors.push(new Headers(init.headers).get("last-event-id") ?? "");
      if (eventRequests === 1) {
        if (firstStream instanceof Error) {
          throw firstStream;
        }
        return new Response(firstStream);
      }
      return new Response(sse(acceptedEvent, terminalStatus));
    }
    if (path === `/api/runs/${RUN_ID}`) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("completed"),
      });
    }
    if (path === `/api/agents/${AGENT_ID}` && init.method === "DELETE") {
      cleanupRequests += 1;
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  const captured = await captureRun(
    {
      repository: "OpenCoven/demo-workspace",
      task: "Add a parser test.",
    },
    {
      ...recorderLookup,
      environment: recordingEnvironment(),
      randomUUID: () => OPERATION_ID,
      request,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    }
  );

  return { captured, cleanupRequests, cursors, eventRequests, sleeps };
}

test("retries when the initial event-stream request fails before a response", async () => {
  const { captured, cleanupRequests, cursors, eventRequests, sleeps } =
    await captureAfterRecoverableStream(
      new Error("event stream connection failed")
    );

  assert.equal(eventRequests, 2);
  assert.deepEqual(cursors, ["0", "0"]);
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(
    captured.arrivals.map(({ event }) => event.id),
    [1, 2]
  );
  assert.equal(cleanupRequests, 1);
});

test("reconnects from the last validated event after an SSE transport error", async () => {
  const { captured, cursors, eventRequests, sleeps } =
    await captureAfterRecoverableStream(
      interruptedEventStream(sse(acceptedEvent))
    );

  assert.equal(eventRequests, 2);
  assert.deepEqual(cursors, ["0", "1"]);
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(
    captured.arrivals.map(({ event }) => event.id),
    [1, 2]
  );
});

test("reconnects after a transport error even when a terminal status was validated", async () => {
  const terminalStatus: RunEvent = {
    id: 2,
    status: "completed",
    type: "status",
  };
  const { captured, cursors, eventRequests, sleeps } =
    await captureAfterRecoverableStream(
      interruptedEventStream(sse(acceptedEvent, terminalStatus))
    );

  assert.equal(eventRequests, 2);
  assert.deepEqual(cursors, ["0", "2"]);
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(
    captured.arrivals.map(({ event }) => event.id),
    [1, 2]
  );
});

test("reconnects after a truncated SSE frame without accepting the partial event", async () => {
  const { captured, cursors, eventRequests, sleeps } =
    await captureAfterRecoverableStream(
      eventStream([`${sse(acceptedEvent)}data: {"id":2`])
    );

  assert.equal(eventRequests, 2);
  assert.deepEqual(cursors, ["0", "1"]);
  assert.deepEqual(sleeps, [250]);
  assert.deepEqual(
    captured.arrivals.map(({ event }) => event.id),
    [1, 2]
  );
});

test("a fully framed malformed SSE event is a hard failure", async () => {
  let eventRequests = 0;
  const sleeps: number[] = [];
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/agents" && init.method === "POST") {
      return agentResponse();
    }
    if (path === `/api/agents/${AGENT_ID}/runs`) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("queued"),
      });
    }
    if (path === `/api/runs/${RUN_ID}/events`) {
      eventRequests += 1;
      return new Response(`${sse(acceptedEvent)}data: {"id":2\n\n`);
    }
    if (path === `/api/agents/${AGENT_ID}` && init.method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  await assert.rejects(
    () =>
      captureRun(
        {
          repository: "OpenCoven/demo-workspace",
          task: "Add a parser test.",
        },
        {
          ...recorderLookup,
          environment: recordingEnvironment(),
          randomUUID: () => OPERATION_ID,
          request,
          sleep: (milliseconds) => {
            sleeps.push(milliseconds);
            return Promise.resolve();
          },
        }
      ),
    /not valid JSON/i
  );
  assert.equal(eventRequests, 1);
  assert.deepEqual(sleeps, []);
});

test("bounds consecutive SSE recovery attempts with exponential backoff", async () => {
  let eventRequests = 0;
  const sleeps: number[] = [];
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/agents" && init.method === "POST") {
      return agentResponse();
    }
    if (path === `/api/agents/${AGENT_ID}/runs`) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("queued"),
      });
    }
    if (path === `/api/runs/${RUN_ID}/events`) {
      eventRequests += 1;
      return new Response(interruptedEventStream(""));
    }
    if (path === `/api/agents/${AGENT_ID}` && init.method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  await assert.rejects(
    () =>
      captureRun(
        {
          repository: "OpenCoven/demo-workspace",
          task: "Add a parser test.",
        },
        {
          ...recorderLookup,
          environment: recordingEnvironment(),
          randomUUID: () => OPERATION_ID,
          request,
          sleep: (milliseconds) => {
            sleeps.push(milliseconds);
            return Promise.resolve();
          },
        }
      ),
    /could not be resumed/i
  );
  assert.equal(eventRequests, 6);
  assert.deepEqual(sleeps, [250, 500, 1000, 2000, 4000]);
});

async function captureTerminalStatus(status: "cancelled" | "failed") {
  const statusEvent: RunEvent = {
    id: 2,
    status,
    type: "status",
  };
  let eventRequests = 0;
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/agents" && init.method === "POST") {
      return agentResponse();
    }
    if (path === `/api/agents/${AGENT_ID}/runs`) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot("queued"),
      });
    }
    if (path === `/api/runs/${RUN_ID}/events`) {
      eventRequests += 1;
      if (eventRequests > 1) {
        throw new Error("terminal status must not reconnect");
      }
      return new Response(sse(acceptedEvent, statusEvent));
    }
    if (path === `/api/runs/${RUN_ID}`) {
      return Response.json({
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: snapshot(status),
      });
    }
    if (path === `/api/agents/${AGENT_ID}` && init.method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  const captured = await captureRun(
    {
      repository: "OpenCoven/demo-workspace",
      task: "Add a parser test.",
    },
    {
      ...recorderLookup,
      environment: recordingEnvironment(),
      randomUUID: () => OPERATION_ID,
      request,
    }
  );
  return { captured, eventRequests };
}

test("a failed status event terminates capture without reconnecting", async () => {
  const { captured, eventRequests } = await captureTerminalStatus("failed");

  assert.equal(eventRequests, 1);
  assert.equal(captured.result.status, "failed");
  assert.deepEqual(
    captured.arrivals.map(({ event }) => event.type),
    ["accepted", "status"]
  );
});

test("a cancelled status event terminates capture without reconnecting", async () => {
  const { captured, eventRequests } = await captureTerminalStatus("cancelled");

  assert.equal(eventRequests, 1);
  assert.equal(captured.result.status, "failed");
  assert.deepEqual(
    captured.arrivals.map(({ event }) => event.type),
    ["accepted", "status"]
  );
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
            warm: { status: "not_started", updatedAt: CREATED_AT },
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
      ...recorderLookup,
      environment: recordingEnvironment({
        DEMO_RECORDING_CREDENTIAL: "tenant-harness-secret",
      }),
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
    assert.equal(call.headers.get("x-runner-token"), null);
    assert.equal(call.headers.get("authorization"), null);
    assert.match(
      call.headers.get("cookie") ?? "",
      /^__Secure-authjs\.session-token=/
    );
  }
  const createInput = JSON.parse(calls[0]?.body ?? "{}") as {
    backend?: string;
    instructions?: string;
    model?: string;
    name?: string;
    runtime?: string;
    workspace?: string;
  };
  assert.equal(createInput.backend, "cloud");
  assert.equal(createInput.runtime, "copilot");
  assert.equal(createInput.model, "auto");
  assert.equal(createInput.name, `demo-record-${OPERATION_ID}`);
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
          warm: { status: "not_started", updatedAt: CREATED_AT },
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
          ...recorderLookup,
          environment: recordingEnvironment(),
          randomUUID: () => OPERATION_ID,
          request,
        }
      ),
    /run event schema validation/i
  );
  assert.equal(methods.at(-1), `DELETE /api/agents/${AGENT_ID}`);
});

test("retains a valid agent id for cleanup when the create envelope is malformed", async () => {
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
          backend: "malformed",
          id: AGENT_ID,
        },
      });
    }
    if (path === `/api/agents/${AGENT_ID}` && init.method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  await assert.rejects(
    () =>
      captureRun(
        {
          repository: "OpenCoven/demo-workspace",
          task: "Add a parser test.",
        },
        {
          ...recorderLookup,
          environment: recordingEnvironment(),
          randomUUID: () => OPERATION_ID,
          request,
        }
      ),
    /invalid agent envelope/i
  );
  assert.equal(methods.at(-1), `DELETE /api/agents/${AGENT_ID}`);
});

test("a malformed create envelope still surfaces cleanup failure without secrets", async () => {
  // biome-ignore lint/suspicious/useAwait: injected fetch matches the native asynchronous fetch contract.
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/agents") {
      return Response.json({
        agent: {
          id: AGENT_ID,
          runtime: "malformed",
        },
      });
    }
    if (path === `/api/agents/${AGENT_ID}` && init.method === "DELETE") {
      return Response.json(
        {
          apiVersion: AGENT_RUNNER_API_VERSION,
          error: {
            code: "cleanup_failed",
            message: `${AUTH_SECRET} ${SESSION_COOKIE} ${RECORDING_CREDENTIAL}`,
            retryable: true,
          },
          requestId: RUN_ID,
        },
        { status: 500 }
      );
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  await assert.rejects(
    () =>
      captureRun(
        {
          repository: "OpenCoven/demo-workspace",
          task: "Add a parser test.",
        },
        {
          ...recorderLookup,
          createSessionCookie: () => Promise.resolve(SESSION_COOKIE),
          environment: recordingEnvironment(),
          randomUUID: () => OPERATION_ID,
          request,
        }
      ),
    (error: Error) => {
      assert.match(error.message, /invalid agent envelope/i);
      assert.match(error.message, /cleanup/i);
      return assertNoConfiguredSecrets(error);
    }
  );
});

function captureWithLostCreateResponse(options: {
  createResponse?: () => Response | Promise<Response>;
  listResponse: () => Response | Promise<Response>;
}) {
  const calls: string[] = [];
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    calls.push(`${init.method ?? "GET"} ${path}`);
    if (path === "/api/agents" && init.method === "POST") {
      if (options.createResponse) {
        return await options.createResponse();
      }
      throw new Error("create response connection lost");
    }
    if (path === "/api/agents" && (init.method ?? "GET") === "GET") {
      return await options.listResponse();
    }
    if (path === `/api/agents/${AGENT_ID}` && init.method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  const pending = captureRun(
    {
      repository: "OpenCoven/demo-workspace",
      task: "Add a parser test.",
    },
    {
      ...recorderLookup,
      environment: recordingEnvironment(),
      randomUUID: () => OPERATION_ID,
      request,
    }
  );
  return { calls, pending };
}

test("recovers an exact uniquely named agent after the create response is lost and deletes it", async () => {
  const temporaryName = `demo-record-${OPERATION_ID}`;
  const { calls, pending } = captureWithLostCreateResponse({
    listResponse: () =>
      Response.json({ agents: [agentDefinition(temporaryName)] }),
  });

  await assert.rejects(pending, /creation response was lost/i);
  assert.deepEqual(calls, [
    "POST /api/agents",
    "GET /api/agents",
    `DELETE /api/agents/${AGENT_ID}`,
  ]);
});

test("recovers and deletes the exact agent when the create response body is lost", async () => {
  const temporaryName = `demo-record-${OPERATION_ID}`;
  const encoder = new TextEncoder();
  const { calls, pending } = captureWithLostCreateResponse({
    createResponse: () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('{"agent":'));
            controller.error(new Error("create response body lost"));
          },
        }),
        { headers: { "content-type": "application/json" } }
      ),
    listResponse: () =>
      Response.json({ agents: [agentDefinition(temporaryName)] }),
  });

  await assert.rejects(pending, /creation response was lost/i);
  assert.deepEqual(calls, [
    "POST /api/agents",
    "GET /api/agents",
    `DELETE /api/agents/${AGENT_ID}`,
  ]);
});

test("does not delete a fuzzy or missing match after a lost create response", async () => {
  const { calls, pending } = captureWithLostCreateResponse({
    listResponse: () =>
      Response.json({
        agents: [agentDefinition(`demo-record-${OPERATION_ID}-similar`)],
      }),
  });

  await assert.rejects(pending, /potential orphan.*no exact/i);
  assert.deepEqual(calls, ["POST /api/agents", "GET /api/agents"]);
});

test("does not delete nonunique exact matches after a lost create response", async () => {
  const temporaryName = `demo-record-${OPERATION_ID}`;
  const { calls, pending } = captureWithLostCreateResponse({
    listResponse: () =>
      Response.json({
        agents: [
          agentDefinition(temporaryName),
          agentDefinition(
            temporaryName,
            "9c1b7d2f-5a6b-4c90-8f1a-0f4e1f4d4a2e"
          ),
        ],
      }),
  });

  await assert.rejects(pending, /potential orphan.*multiple exact/i);
  assert.deepEqual(calls, ["POST /api/agents", "GET /api/agents"]);
});

test("surfaces a safe potential orphan when create recovery listing fails", async () => {
  const { calls, pending } = captureWithLostCreateResponse({
    listResponse: () =>
      Response.json(
        {
          apiVersion: AGENT_RUNNER_API_VERSION,
          error: {
            code: "list_failed",
            message: `${AUTH_SECRET} ${SESSION_COOKIE}`,
            retryable: true,
          },
          requestId: RUN_ID,
        },
        { status: 500 }
      ),
  });

  await assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /potential orphan.*recovery listing failed/i);
    return assertNoConfiguredSecrets(error);
  });
  assert.deepEqual(calls, ["POST /api/agents", "GET /api/agents"]);
});

test("surfaces a potential orphan when the recovery listing payload is malformed", async () => {
  const { calls, pending } = captureWithLostCreateResponse({
    listResponse: () =>
      new Response(`${AUTH_SECRET} malformed listing payload`),
  });

  await assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /potential orphan.*recovery listing failed/i);
    return assertNoConfiguredSecrets(error);
  });
  assert.deepEqual(calls, ["POST /api/agents", "GET /api/agents"]);
});

function captureWithTimedOutCreate(options: {
  listResponse: () => Response | Promise<Response>;
}) {
  const authenticationHeaders: Headers[] = [];
  const calls: { method: string; path: string; signalAborted: boolean }[] = [];
  let committed = false;
  const request = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? "GET";
    const { signal } = init;
    calls.push({
      method,
      path,
      signalAborted: signal?.aborted ?? false,
    });
    authenticationHeaders.push(new Headers(init.headers));

    if (path === "/api/agents" && method === "POST") {
      committed = true;
      return await new Promise<Response>((_resolve, reject) => {
        const fail = () =>
          reject(
            new Error(
              `${AUTH_SECRET} ${SESSION_COOKIE} ${RECORDING_CREDENTIAL}`
            )
          );
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
    }
    if (path === "/api/agents" && method === "GET") {
      assert.equal(committed, true);
      return await options.listResponse();
    }
    if (path === `/api/agents/${AGENT_ID}` && method === "DELETE") {
      return Response.json({ ok: true });
    }
    return Response.json({ unexpected: path }, { status: 500 });
  };

  const pending = captureRun(
    {
      repository: "OpenCoven/demo-workspace",
      task: "Add a parser test.",
    },
    {
      ...recorderLookup,
      createSessionCookie: () => Promise.resolve(SESSION_COOKIE),
      environment: recordingEnvironment({
        DEMO_RECORDING_TIMEOUT_MS: "1",
      }),
      randomUUID: () => OPERATION_ID,
      request,
    }
  );

  return { authenticationHeaders, calls, pending };
}

test("recovers and deletes an exact agent after create commits then times out", async () => {
  const temporaryName = `demo-record-${OPERATION_ID}`;
  const { authenticationHeaders, calls, pending } = captureWithTimedOutCreate({
    listResponse: () =>
      Response.json({ agents: [agentDefinition(temporaryName)] }),
  });

  await assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /timed out/i);
    return assertNoConfiguredSecrets(error);
  });
  assert.deepEqual(calls, [
    { method: "POST", path: "/api/agents", signalAborted: false },
    { method: "GET", path: "/api/agents", signalAborted: false },
    {
      method: "DELETE",
      path: `/api/agents/${AGENT_ID}`,
      signalAborted: false,
    },
  ]);
  assert.equal(authenticationHeaders.length, 3);
  for (const headers of authenticationHeaders) {
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-runner-token"), null);
    assert.equal(
      headers.get("cookie"),
      `__Secure-authjs.session-token=${SESSION_COOKIE}`
    );
  }
});

test("surfaces a safe potential orphan when timed-out create has no exact match", async () => {
  const { calls, pending } = captureWithTimedOutCreate({
    listResponse: () => Response.json({ agents: [] }),
  });

  await assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /potential orphan.*no exact/i);
    return assertNoConfiguredSecrets(error);
  });
  assert.deepEqual(calls, [
    { method: "POST", path: "/api/agents", signalAborted: false },
    { method: "GET", path: "/api/agents", signalAborted: false },
  ]);
});

test("surfaces a safe potential orphan when timed-out create has multiple exact matches", async () => {
  const temporaryName = `demo-record-${OPERATION_ID}`;
  const { calls, pending } = captureWithTimedOutCreate({
    listResponse: () =>
      Response.json({
        agents: [
          agentDefinition(temporaryName),
          agentDefinition(
            temporaryName,
            "9c1b7d2f-5a6b-4c90-8f1a-0f4e1f4d4a2e"
          ),
        ],
      }),
  });

  await assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /potential orphan.*multiple exact/i);
    return assertNoConfiguredSecrets(error);
  });
  assert.deepEqual(calls, [
    { method: "POST", path: "/api/agents", signalAborted: false },
    { method: "GET", path: "/api/agents", signalAborted: false },
  ]);
});

test("surfaces a safe potential orphan when timed-out create recovery fails", async () => {
  const { calls, pending } = captureWithTimedOutCreate({
    listResponse: () =>
      Response.json(
        {
          apiVersion: AGENT_RUNNER_API_VERSION,
          error: {
            code: "list_failed",
            message: `${AUTH_SECRET} ${SESSION_COOKIE}`,
            retryable: true,
          },
          requestId: RUN_ID,
        },
        { status: 500 }
      ),
  });

  await assert.rejects(pending, (error: Error) => {
    assert.match(error.message, /potential orphan.*recovery listing failed/i);
    return assertNoConfiguredSecrets(error);
  });
  assert.deepEqual(calls, [
    { method: "POST", path: "/api/agents", signalAborted: false },
    { method: "GET", path: "/api/agents", signalAborted: false },
  ]);
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
          warm: { status: "not_started", updatedAt: CREATED_AT },
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
            message: `${AUTH_SECRET} ${SESSION_COOKIE} ${RECORDING_CREDENTIAL}`,
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
          ...recorderLookup,
          createSessionCookie: () => Promise.resolve(SESSION_COOKIE),
          environment: recordingEnvironment(),
          randomUUID: () => OPERATION_ID,
          request,
        }
      ),
    (error: Error) => {
      assert.match(error.message, /run event schema validation/i);
      assert.match(error.message, /cleanup/i);
      return assertNoConfiguredSecrets(error);
    }
  );
});
