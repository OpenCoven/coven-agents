import assert from "node:assert/strict";
import test from "node:test";
import { corsHeaders, HttpError, readJson } from "./http.js";

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
