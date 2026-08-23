import assert from "node:assert/strict";
import test from "node:test";
import {
  corsHeaders,
  errorEnvelope,
  HttpError,
  hasValidBearerToken,
  readJson,
  serializeSse,
} from "./http.js";

test("only reflects the configured CORS origin", () => {
  const allowed = corsHeaders(
    new Request("https://runner.example", {
      headers: { origin: "https://app.example" },
    }),
    "https://app.example"
  );
  const rejected = corsHeaders(
    new Request("https://runner.example", {
      headers: { origin: "https://attacker.example" },
    }),
    "https://app.example"
  );

  assert.equal(
    allowed.get("access-control-allow-origin"),
    "https://app.example"
  );
  assert.equal(rejected.has("access-control-allow-origin"), false);
});

test("rejects oversized JSON before buffering it", async () => {
  const request = new Request("https://runner.example/api/agents", {
    body: "{}",
    headers: { "content-length": String(70 * 1024) },
    method: "POST",
  });

  await assert.rejects(
    readJson(request),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 413 &&
      error.code === "body_too_large"
  );
});

test("stops reading a chunked body as soon as it exceeds the byte cap", async () => {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(controller) {
      pulls += 1;
      if (pulls === 1) {
        controller.enqueue(new Uint8Array(64 * 1024));
        return;
      }
      if (pulls === 2) {
        controller.enqueue(new Uint8Array([0x20]));
        return;
      }
      controller.error(new Error("read past the request body limit"));
    },
  });
  const request = new Request("https://runner.example/api/agents", {
    body,
    // Node's Request implementation requires this for stream bodies.
    duplex: "half",
    method: "POST",
  } as RequestInit);

  await assert.rejects(
    readJson(request),
    (error: unknown) =>
      error instanceof HttpError &&
      error.status === 413 &&
      error.code === "body_too_large"
  );
  assert.equal(pulls, 2);
  assert.equal(cancelled, true);
});

test("accepts the exact runner token and rejects every near miss", () => {
  const token = "runner-token-value";
  const authed = (value: string | null) =>
    new Request("https://runner.example/api/agents", {
      headers: value === null ? {} : { authorization: value },
      method: "POST",
    });

  assert.equal(hasValidBearerToken(authed(`Bearer ${token}`), token), true);

  for (const attempt of [
    null,
    "",
    "Bearer ",
    // No trailing-whitespace case: the Headers spec strips it, so
    // "Bearer <token> " is literally the same header value.
    `Bearer ${token}x`,
    `Bearer ${token.slice(0, -1)}`,
    `bearer ${token}`,
    token,
    `Basic ${token}`,
  ]) {
    assert.equal(
      hasValidBearerToken(authed(attempt), token),
      false,
      `expected rejection for ${JSON.stringify(attempt)}`
    );
  }
});

test("denies every request when the runner token is unconfigured", () => {
  // Regression: the handler once read the secret from process.env, which a
  // Worker never populates, so this path silently received "" in production.
  const request = new Request("https://runner.example/api/agents", {
    headers: { authorization: "Bearer anything" },
    method: "POST",
  });

  for (const unset of ["", undefined]) {
    assert.equal(hasValidBearerToken(request, unset ?? ""), false);
  }
});

test("serializes only events after an SSE cursor", () => {
  const stream = serializeSse(
    [
      {
        at: "2026-08-20T20:00:00.000Z",
        id: 1,
        operationId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
        runId: "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce",
        type: "accepted",
      },
      {
        at: "2026-08-20T20:00:01.000Z",
        id: 2,
        status: "running",
        type: "status",
      },
    ],
    1
  );

  assert.equal(stream.includes("id: 1\n"), false);
  assert.match(stream, /id: 2\nevent: status\n/);
});

test("wraps runner errors in the versioned error envelope", () => {
  assert.deepEqual(
    errorEnvelope(
      "not_found",
      "Run was not found.",
      false,
      undefined,
      "test-request-id"
    ),
    {
      apiVersion: "1.0",
      error: {
        code: "not_found",
        message: "Run was not found.",
        retryable: false,
      },
      requestId: "test-request-id",
    }
  );
});
