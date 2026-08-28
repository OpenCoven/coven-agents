import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEvidenceText } from "./index";

test("redacts authorization, credential assignments, and provider keys while preserving useful evidence", () => {
  const input = [
    "preflight: repository is clean",
    "Authorization: Bearer bearer-test-value-123456",
    "x-api-key: header-api-key-abcdef",
    "DEPLOYMENT_ACCESS_KEY=access-key-value",
    "export DATABASE_PASSWORD='database-password-value'",
    '{"client_secret":"client-secret-value"}',
    "curl --private-key private-key-value --token cli-token-value",
    // secret-scan: allow-next-line -- synthetic OpenAI redaction fixture
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    // secret-scan: allow-next-line -- synthetic GitHub redaction fixture
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    ["xoxb", "123456789012", "abcdefghijklmnopqrstuvwxyz"].join("-"),
    // secret-scan: allow-next-line -- synthetic AWS redaction fixture
    "AKIA1234567890ABCDEF",
    "postflight: focused tests passed",
  ].join("\n");

  const sanitized = sanitizeEvidenceText(input);

  for (const secret of [
    "bearer-test-value-123456",
    "header-api-key-abcdef",
    "access-key-value",
    "database-password-value",
    "client-secret-value",
    "private-key-value",
    "cli-token-value",
    // secret-scan: allow-next-line -- synthetic OpenAI assertion fixture
    "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
    // secret-scan: allow-next-line -- synthetic GitHub assertion fixture
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD",
    ["xoxb", "123456789012", "abcdefghijklmnopqrstuvwxyz"].join("-"),
    // secret-scan: allow-next-line -- synthetic AWS assertion fixture
    "AKIA1234567890ABCDEF",
  ]) {
    assert.equal(sanitized.includes(secret), false, `leaked ${secret}`);
  }
  assert.match(sanitized, /preflight: repository is clean/);
  assert.match(sanitized, /postflight: focused tests passed/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("replaces complete environment dumps without discarding adjacent non-secret diagnostics", () => {
  const sanitized = sanitizeEvidenceText(
    [
      "before: checking sandbox",
      "PATH=/usr/local/bin",
      "HOME=/root",
      "SHELL=/bin/sh",
      "LANG=en_US.UTF-8",
      "after: command exited 0",
    ].join("\n")
  );

  assert.match(sanitized, /before: checking sandbox/);
  assert.match(sanitized, /\[environment output redacted\]/);
  assert.match(sanitized, /after: command exited 0/);
  assert.equal(sanitized.includes("/usr/local/bin"), false);
  assert.equal(sanitized.includes("/root"), false);
});

test("redacts an isolated sensitive environment assignment", () => {
  const secret = "isolated-cloud-secret";
  const sanitized = sanitizeEvidenceText(`OPENAI_API_KEY=${secret}`);

  assert.equal(sanitized.includes(secret), false);
  assert.equal(sanitized, "OPENAI_API_KEY=[REDACTED]");
});

test("redacts request and response session cookies from runner evidence", () => {
  const cookie = "session-id-private-value";
  const sanitized = sanitizeEvidenceText(
    `Cookie: session=${cookie}; theme=dark\nSet-Cookie: session=${cookie}; HttpOnly`
  );

  assert.equal(sanitized.includes(cookie), false);
  assert.match(sanitized, /\[REDACTED\]/);
});
