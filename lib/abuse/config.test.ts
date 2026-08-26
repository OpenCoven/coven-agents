import assert from "node:assert/strict";
import test from "node:test";
import { validateAbuseConfig } from "./config";

test("startup validation rejects production Redis without an abuse key secret", () => {
  assert.throws(
    () =>
      validateAbuseConfig({
        globalDailyRunCap: undefined,
        isProduction: true,
        keySecret: undefined,
        redisUrl: "redis://localhost:6379",
      }),
    /ABUSE_KEY_SECRET is required/
  );
});

test("startup validation rejects run reservations without a nonempty abuse key secret", () => {
  for (const keySecret of [undefined, "", "  "]) {
    assert.throws(
      () =>
        validateAbuseConfig({
          globalDailyRunCap: "500",
          isProduction: true,
          keySecret,
          redisUrl: undefined,
        }),
      /ABUSE_KEY_SECRET is required/
    );
  }
});

test("startup validation rejects malformed global run caps", () => {
  assert.throws(
    () =>
      validateAbuseConfig({
        globalDailyRunCap: "not-a-number",
        isProduction: true,
        keySecret: "fixed-test-abuse-key-secret",
        redisUrl: undefined,
      }),
    /GLOBAL_DAILY_RUN_CAP must be a positive integer/
  );
});

test("startup validation accepts valid or missing Redis configuration", () => {
  assert.doesNotThrow(() =>
    validateAbuseConfig({
      globalDailyRunCap: undefined,
      isProduction: true,
      keySecret: "fixed-test-abuse-key-secret",
      redisUrl: "redis://localhost:6379",
    })
  );
  assert.doesNotThrow(() =>
    validateAbuseConfig({
      globalDailyRunCap: undefined,
      isProduction: true,
      keySecret: undefined,
      redisUrl: undefined,
    })
  );
});

test("startup validation accepts valid run reservation configuration", () => {
  assert.doesNotThrow(() =>
    validateAbuseConfig({
      globalDailyRunCap: "500",
      isProduction: true,
      keySecret: "fixed-test-abuse-key-secret",
      redisUrl: undefined,
    })
  );
});

test("startup validation does not require reservation config in development", () => {
  assert.doesNotThrow(() =>
    validateAbuseConfig({
      globalDailyRunCap: "",
      isProduction: false,
      keySecret: undefined,
      redisUrl: undefined,
    })
  );
});
