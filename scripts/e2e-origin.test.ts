import assert from "node:assert/strict";
import test from "node:test";
import { e2eCookieDomain, e2eOrigin } from "../tests/e2e/origin";

test("E2E origin helpers keep hermetic traffic and cookies on IPv4", () => {
  const environment = { APP_ORIGIN: "http://127.0.0.1:43123" };
  assert.equal(e2eOrigin(environment), "http://127.0.0.1:43123");
  assert.equal(e2eCookieDomain(environment), "127.0.0.1");
});

test("E2E origin helpers retain normal localhost behavior", () => {
  assert.equal(e2eOrigin({}), "http://localhost:3100");
  assert.equal(e2eCookieDomain({}), "localhost");
});
