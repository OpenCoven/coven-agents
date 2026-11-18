import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  agentEnvelopeSchema,
  runErrorEnvelopeSchema,
} from "@opencoven/agent-contracts";
import { z } from "zod";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const REQUEST_ID = "44444444-5555-4666-8777-888888888888";

const expectedErrors = {
  abuse_control_unavailable: [503, true],
  admission_unavailable: [503, true],
  agent_decommissioning: [409, true],
  body_too_large: [413, false],
  busy: [409, true],
  cleanup_required: [503, true],
  diagnostic_unavailable: [503, true],
  harness_unsupported: [400, false],
  internal_error: [500, true],
  invalid_event_cursor: [400, false],
  invalid_request: [400, false],
  not_found: [404, false],
  operation_conflict: [409, true],
  origin_rejected: [403, false],
  provider_rejected: [422, false],
  provider_unavailable: [503, true],
  rate_limited: [429, true],
  reconcile_unavailable: [503, true],
  run_not_found: [404, false],
  runner_unavailable: [503, true],
  sandbox_binding_refused: [409, false],
  stale_version: [409, true],
  subscription_required: [403, false],
  unauthorized: [401, false],
  unsupported_media_type: [400, false],
} as const;

test("transport publishes strict versioned envelopes for every status mapping", async () => {
  const transport = await import("./transport").catch(() => null);
  assert.ok(transport, "transport module must exist");

  assert.deepEqual(
    [...transport.RUNNER_ERROR_CODES].sort(),
    Object.keys(expectedErrors).sort()
  );
  await Promise.all(
    transport.RUNNER_ERROR_CODES.map(async (code) => {
      const response = transport.runnerErrorResponse(
        { createRequestId: () => REQUEST_ID },
        code
      );
      const envelope = runErrorEnvelopeSchema.parse(await response.json());
      const [status, retryable] = expectedErrors[code];

      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(envelope.apiVersion, AGENT_RUNNER_API_VERSION);
      assert.equal(envelope.error.code, code);
      assert.equal(envelope.error.retryable, retryable);
      assert.equal(envelope.requestId, REQUEST_ID);
    })
  );
});

test("transport bounds request IDs and permits only the explicit message override", async () => {
  const transport = await import("./transport");
  const response = transport.runnerErrorResponse(
    { createRequestId: () => `  ${"r".repeat(200)}  ` },
    "operation_conflict",
    { message: "Operation ID was already used for a different request." }
  );
  const envelope = runErrorEnvelopeSchema.parse(await response.json());

  assert.equal(envelope.error.code, "operation_conflict");
  assert.equal(
    envelope.error.message,
    "Operation ID was already used for a different request."
  );
  assert.equal(envelope.requestId.length, 128);
});

test("transport integrates bounded strict JSON parsing with fail-closed errors", async () => {
  const transport = await import("./transport");
  const schema = z.object({ name: z.string() }).strict();
  const dependencies = { createRequestId: () => REQUEST_ID };

  const parsed = await transport.readRunnerJson(
    new Request("https://app.test/api/agents", {
      body: JSON.stringify({ name: "Runner" }),
      method: "POST",
    }),
    "runner_write",
    schema,
    dependencies
  );
  assert.deepEqual(parsed, { kind: "ok", value: { name: "Runner" } });

  const invalid = await transport.readRunnerJson(
    new Request("https://app.test/api/agents", {
      body: JSON.stringify({ name: "Runner", owner: "caller" }),
      method: "POST",
    }),
    "runner_write",
    schema,
    dependencies
  );
  assert.equal(invalid.kind, "response");
  if (invalid.kind === "response") {
    assert.equal(invalid.response.status, 400);
    assert.equal(
      ((await invalid.response.json()) as { error: { code: string } }).error
        .code,
      "invalid_request"
    );
  }

  const oversized = await transport.readRunnerJson(
    new Request("https://app.test/api/agents", {
      body: "x".repeat(64_001),
      headers: { "content-length": "64001" },
      method: "POST",
    }),
    "runner_write",
    schema,
    dependencies
  );
  assert.equal(oversized.kind, "response");
  if (oversized.kind === "response") {
    assert.equal(oversized.response.status, 413);
  }
});

test("transport accepts only exact same-origin JSON mutations", async () => {
  const transport = await import("./transport");
  const dependencies = {
    appOrigin: "https://app.test",
    createRequestId: () => REQUEST_ID,
  };

  for (const contentType of [
    "application/json",
    "application/json; charset=utf-8",
  ]) {
    assert.equal(
      transport.validateRunnerMutationRequest(
        new Request("https://app.test/api/agents", {
          headers: {
            "content-type": contentType,
            origin: "https://app.test",
          },
          method: "POST",
        }),
        dependencies,
        { jsonBody: true }
      ),
      null
    );
  }
});

test("transport rejects missing, null, malformed, and mismatched mutation origins", async () => {
  const transport = await import("./transport");
  const dependencies = {
    appOrigin: "https://app.test",
    createRequestId: () => REQUEST_ID,
  };
  const rejectedOrigins = [
    undefined,
    "null",
    "not an origin",
    "ftp://app.test",
    "https://sibling.app.test",
    "http://app.test",
    "https://app.test:444",
  ];

  await Promise.all(
    rejectedOrigins.map(async (origin) => {
      const headers = new Headers({ "content-type": "application/json" });
      if (origin !== undefined) {
        headers.set("origin", origin);
      }
      const response = transport.validateRunnerMutationRequest(
        new Request("https://app.test/api/agents", {
          headers,
          method: "POST",
        }),
        dependencies,
        { jsonBody: true }
      );
      assert.ok(response instanceof Response);
      assert.equal(response.status, 403);
      const envelope = runErrorEnvelopeSchema.parse(await response.json());
      assert.equal(envelope.error.code, "origin_rejected");
      assert.equal(
        JSON.stringify(envelope).includes(origin ?? "missing"),
        false
      );
    })
  );
});

test("transport rejects a request URL outside configured APP_ORIGIN", async () => {
  const transport = await import("./transport");
  const response = transport.validateRunnerMutationRequest(
    new Request("https://forwarded-host.example/api/agents", {
      headers: {
        "content-type": "application/json",
        origin: "https://forwarded-host.example",
      },
      method: "POST",
    }),
    {
      appOrigin: "https://app.test",
      createRequestId: () => REQUEST_ID,
    },
    { jsonBody: true }
  );

  assert.ok(response instanceof Response);
  assert.equal(response.status, 403);
  assert.equal(
    runErrorEnvelopeSchema.parse(await response.json()).error.code,
    "origin_rejected"
  );
});

test("transport rejects cleartext non-loopback application origins", async () => {
  const transport = await import("./transport");
  const response = transport.validateRunnerMutationRequest(
    new Request("http://app.test/api/agents", {
      headers: {
        "content-type": "application/json",
        origin: "http://app.test",
      },
      method: "POST",
    }),
    {
      appOrigin: "http://app.test",
      createRequestId: () => REQUEST_ID,
    },
    { jsonBody: true }
  );

  assert.ok(response instanceof Response);
  assert.equal(response.status, 403);
  assert.equal(
    runErrorEnvelopeSchema.parse(await response.json()).error.code,
    "origin_rejected"
  );
});

test("transport fails closed when production APP_ORIGIN is missing", async () => {
  const transport = await import("./transport");
  const response = transport.validateRunnerMutationRequest(
    new Request("https://forwarded-host.example/api/agents", {
      headers: {
        "content-type": "application/json",
        origin: "https://forwarded-host.example",
      },
      method: "POST",
    }),
    {
      appOrigin: undefined,
      createRequestId: () => REQUEST_ID,
    },
    { jsonBody: true }
  );

  assert.ok(response instanceof Response);
  assert.equal(response.status, 403);
  assert.equal(
    runErrorEnvelopeSchema.parse(await response.json()).error.code,
    "origin_rejected"
  );
});

test("transport requires JSON media type only for JSON mutations", async () => {
  const transport = await import("./transport");
  const dependencies = {
    appOrigin: "https://app.test",
    createRequestId: () => REQUEST_ID,
  };

  await Promise.all(
    [undefined, "text/plain", "application/problem+json"].map(
      async (contentType) => {
        const headers = new Headers({ origin: "https://app.test" });
        if (contentType) {
          headers.set("content-type", contentType);
        }
        const response = transport.validateRunnerMutationRequest(
          new Request("https://app.test/api/agents", {
            headers,
            method: "POST",
          }),
          dependencies,
          { jsonBody: true }
        );
        assert.ok(response instanceof Response);
        assert.equal(response.status, 400);
        assert.equal(
          runErrorEnvelopeSchema.parse(await response.json()).error.code,
          "unsupported_media_type"
        );
      }
    )
  );

  assert.equal(
    transport.validateRunnerMutationRequest(
      new Request("https://app.test/api/tenant/prewarm", {
        headers: { origin: "https://app.test" },
        method: "POST",
      }),
      dependencies,
      { jsonBody: false }
    ),
    null
  );
});

test("transport parses IDs, empty bodies, and event cursors before services", async () => {
  const transport = await import("./transport");
  const dependencies = { createRequestId: () => REQUEST_ID };

  assert.equal(transport.invalidRunnerId(dependencies, AGENT_ID), null);
  assert.equal(
    transport.invalidRunnerId(dependencies, "not-an-id")?.status,
    400
  );

  const empty = await transport.readEmptyRunnerJson(
    new Request("https://app.test/api/runs/id/stop", { method: "POST" }),
    "runner_stop",
    dependencies
  );
  assert.deepEqual(empty, { kind: "ok", value: {} });

  assert.equal(
    transport.parseRunnerEventCursor(
      new Request("https://app.test/api/runs/id/events"),
      dependencies
    ),
    0
  );
  assert.equal(
    transport.parseRunnerEventCursor(
      new Request("https://app.test/api/runs/id/events", {
        headers: { "last-event-id": "42" },
      }),
      dependencies
    ),
    42
  );
  const invalidCursor = transport.parseRunnerEventCursor(
    new Request("https://app.test/api/runs/id/events", {
      headers: { "last-event-id": "9007199254740992" },
    }),
    dependencies
  );
  assert.ok(invalidCursor instanceof Response);
  assert.equal(invalidCursor.status, 400);
});

test("transport validates success responses instead of returning unchecked JSON", async () => {
  const transport = await import("./transport");
  const agent = {
    backend: "cloud",
    createdAt: "2026-08-28T15:00:00.000Z",
    description: "",
    familiarId: "auto",
    id: AGENT_ID,
    instructions: "Do the thing.",
    lastRunAt: null,
    model: "auto",
    name: "Runner",
    owner: { kind: "tenant", tenantId: "u_test" },
    runtime: "copilot",
    status: "idle",
    updatedAt: "2026-08-28T15:00:00.000Z",
    warm: {
      status: "not_started",
      updatedAt: "2026-08-28T15:00:00.000Z",
    },
  };
  const response = transport.runnerJsonResponse(agentEnvelopeSchema, { agent });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { agent });
  const projected = transport.runnerJsonResponse(agentEnvelopeSchema, {
    agent,
    unexpected: true,
  });
  assert.deepEqual(await projected.json(), { agent });
});

test("transport carries bounded error details only when a caller supplies them", async () => {
  const transport = await import("./transport");
  const refused = transport.runnerErrorResponse(
    { createRequestId: () => REQUEST_ID },
    "sandbox_binding_refused",
    { details: "generation_mismatch" }
  );
  const envelope = runErrorEnvelopeSchema.parse(await refused.json());
  assert.equal(refused.status, 409);
  assert.equal(envelope.error.details, "generation_mismatch");
  assert.equal(envelope.error.retryable, false);

  const plain = transport.runnerErrorResponse(
    { createRequestId: () => REQUEST_ID },
    "busy"
  );
  assert.equal(
    Object.hasOwn(
      runErrorEnvelopeSchema.parse(await plain.json()).error,
      "details"
    ),
    false
  );
});
