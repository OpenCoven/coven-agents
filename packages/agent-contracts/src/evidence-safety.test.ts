import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeEvidencePath, sanitizeEvidenceText } from "./index";

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
  const secret = "isolated-daytona-secret";
  const sanitized = sanitizeEvidenceText(`OPENAI_API_KEY=${secret}`);

  assert.equal(sanitized.includes(secret), false);
  assert.equal(sanitized, "OPENAI_API_KEY=[REDACTED]");
});

test("redacts camel-case, hyphenated, and indented structured credential fields", () => {
  const secrets = ["camel-case-secret", "hyphenated-secret", "indented-secret"];
  const sanitized = sanitizeEvidenceText(
    [
      `{"apiKey":"${secrets[0]}"}`,
      `{"x-api-key":"${secrets[1]}"}`,
      `  password: ${secrets[2]}`,
    ].join("\n")
  );

  for (const secret of secrets) {
    assert.equal(sanitized.includes(secret), false);
  }
  assert.equal(sanitized.match(/\[REDACTED\]/gu)?.length, secrets.length);
});

test("redacts request and response session cookies from runner evidence", () => {
  const cookie = "session-id-private-value";
  const sanitized = sanitizeEvidenceText(
    `Cookie: session=${cookie}; theme=dark\nSet-Cookie: session=${cookie}; HttpOnly`
  );

  assert.equal(sanitized.includes(cookie), false);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("redacts credential URLs, private keys, JWTs, and terminal control sequences", () => {
  const jwt = [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIiwicm9sZSI6ImFkbWluIn0",
    "abcdefghijklmnop0123456789",
  ].join(".");
  const shortJwt = ["eyJhbGciOiJub25lIn0", "e30", "c2ln"].join(".");
  const privateKey = [
    "-----BEGIN \u001B[31mPRIVATE",
    " KEY-----\nprivate-key-material\n-----END PRIVATE",
    " KEY-----",
  ].join("");
  const input = [
    "postgres://runner:database-password@example.invalid/app",
    "redis://:password-only@example.invalid/0",
    "******example.invalid/path",
    privateKey,
    jwt,
    shortJwt,
    "\u001B]8;;https://malicious.example\u0007click\u001B]8;;\u0007",
    "\u009B31mC1 terminal control",
    "safe progress remains",
  ].join("\n");

  const sanitized = sanitizeEvidenceText(input);

  assert.equal(sanitized.includes("database-password"), false);
  assert.equal(sanitized.includes("password-only"), false);
  assert.equal(sanitized.includes("opaque-token"), false);
  assert.equal(sanitized.includes("private-key-material"), false);
  assert.equal(sanitized.includes(jwt), false);
  assert.equal(sanitized.includes(shortJwt), false);
  assert.equal(sanitized.includes("\u001B"), false);
  assert.equal(sanitized.includes("\u0007"), false);
  assert.equal(sanitized.includes("\u009B"), false);
  assert.match(sanitized, /safe progress remains/);
});

test("removes local user identities from absolute evidence paths", () => {
  assert.equal(
    sanitizeEvidencePath("/Users/alice/project/src/index.ts"),
    "~/project/src/index.ts"
  );
  assert.equal(
    sanitizeEvidencePath("/home/bob/project/src/index.ts"),
    "~/project/src/index.ts"
  );
  assert.equal(
    sanitizeEvidencePath("C:\\Users\\carol\\project\\src\\index.ts"),
    "~\\project\\src\\index.ts"
  );
  assert.equal(
    sanitizeEvidenceText(
      "Error at /Users/alice/project/index.ts and C:\\Users\\carol\\repo\\app.ts"
    ),
    "Error at ~/project/index.ts and ~\\repo\\app.ts"
  );
  assert.equal(
    sanitizeEvidenceText("Open file:///Users/dana/project/index.ts"),
    "Open file://~/project/index.ts"
  );
  assert.equal(
    sanitizeEvidenceText("Open C:\\Users\\Jane Doe\\project\\index.ts"),
    "Open ~\\project\\index.ts"
  );
  assert.equal(
    sanitizeEvidenceText('Open "/Users/Jane Doe" then continue'),
    'Open "~" then continue'
  );
  assert.equal(
    sanitizeEvidenceText('Open "C:\\Users\\Jane Doe" then continue'),
    'Open "~" then continue'
  );
  assert.equal(
    sanitizeEvidenceText('Open "/Users/O\'Brien" then continue'),
    'Open "~" then continue'
  );
  assert.equal(
    sanitizeEvidenceText('Open "C:\\Users\\O\'Brien" then continue'),
    'Open "~" then continue'
  );
  assert.equal(
    sanitizeEvidenceText("Home /Users/jane.doe is ready"),
    "Home ~ is ready"
  );
  assert.equal(
    sanitizeEvidenceText("Home C:\\Users\\jane.doe is ready"),
    "Home ~ is ready"
  );
});

test("preserves safe URLs containing email addresses", () => {
  const url = "https://example.invalid?email=user@example.com";

  assert.equal(sanitizeEvidenceText(url), url);
});
