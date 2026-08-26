import assert from "node:assert/strict";
import test from "node:test";
import { validateAbuseConfig } from "./config";

test("startup validation rejects production Redis without an abuse key secret", () => {
  assert.throws(
    () =>
      validateAbuseConfig({
        isProduction: true,
        keySecret: undefined,
        redisUrl: "redis://localhost:6379",
      }),
    /ABUSE_KEY_SECRET is required/
  );
});

test("startup validation accepts valid or missing Redis configuration", () => {
  assert.doesNotThrow(() =>
    validateAbuseConfig({
      isProduction: true,
      keySecret: "fixed-test-abuse-key-secret",
      redisUrl: "redis://localhost:6379",
    })
  );
  assert.doesNotThrow(() =>
    validateAbuseConfig({
      isProduction: true,
      keySecret: undefined,
      redisUrl: undefined,
    })
  );
});
