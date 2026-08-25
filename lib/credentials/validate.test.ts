import assert from "node:assert/strict";
import test from "node:test";
import { blocksSave, checkMessage, interpretCopilotCheck } from "./validate";

test("a 200 means the token can use Copilot", () => {
  assert.equal(interpretCopilotCheck(200), "valid");
  assert.equal(interpretCopilotCheck(204), "valid");
});

test("401 is a paste error, 403 is the wrong kind of token", () => {
  // These are the two failures a person can act on, and the actions differ:
  // one is "check what you copied", the other is "get a different token".
  assert.equal(interpretCopilotCheck(401), "invalid_token");
  assert.equal(interpretCopilotCheck(403), "no_copilot");
});

test("404 means no Copilot record, which reads the same as not entitled", () => {
  assert.equal(interpretCopilotCheck(404), "no_copilot");
});

test("an unexpected status does not block the save", () => {
  // Refusing here would make GitHub's availability a hard dependency of
  // setup -- trading a rare wrong-token for a common cannot-configure.
  for (const status of [500, 502, 429, 0]) {
    assert.equal(interpretCopilotCheck(status), "unknown", `status ${status}`);
    assert.equal(blocksSave(interpretCopilotCheck(status)), false);
  }
});

test("only the two actionable failures block", () => {
  assert.equal(blocksSave("invalid_token"), true);
  assert.equal(blocksSave("no_copilot"), true);
  assert.equal(blocksSave("valid"), false);
  assert.equal(blocksSave("unknown"), false);
});

test("each blocking result says what to do about it", () => {
  for (const check of ["invalid_token", "no_copilot"] as const) {
    const message = checkMessage(check);

    assert.ok(message.length > 0, `${check} needs a message`);
    assert.ok(
      !/^(error|failed|invalid)$/i.test(message),
      `${check} must be actionable, got: ${message}`
    );
  }
});

test("a passing result has no message to show", () => {
  assert.equal(checkMessage("valid"), "");
  assert.equal(checkMessage("unknown"), "");
});

test("a network failure leaves the credential storable", async () => {
  const { checkCopilotToken } = await import("./validate");
  const failing = () => Promise.reject(new Error("offline"));

  assert.equal(await checkCopilotToken("tok", failing), "unknown");
  assert.equal(blocksSave(await checkCopilotToken("tok", failing)), false);
});

test("the token is sent as a bearer to the entitlement endpoint", async () => {
  const { checkCopilotToken } = await import("./validate");
  let seen: { url?: string; auth?: string } = {};

  await checkCopilotToken("tok-123", (url, init) => {
    seen = {
      auth: (init?.headers as Record<string, string>)?.authorization,
      url,
    };
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  assert.match(seen.url ?? "", /copilot_internal\/user/);
  assert.equal(seen.auth, "Bearer tok-123");
});
