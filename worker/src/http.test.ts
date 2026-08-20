import assert from "node:assert/strict";
import test from "node:test";
import {
  corsHeaders,
  HttpError,
  hasValidBearerToken,
  readJson,
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
