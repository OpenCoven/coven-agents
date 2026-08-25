import assert from "node:assert/strict";
import test from "node:test";
import { type AbuseStore, MemoryAbuseStore } from "./abuse/store";
import { ChatbotError } from "./errors";
import {
  checkIpRateLimit,
  checkRateLimit,
  createRateLimitChecker,
} from "./ratelimit";

test("the compatibility export keeps the existing IP limiter name", () => {
  assert.equal(checkIpRateLimit, checkRateLimit);
});

test("rate limiting is skipped outside production before requesting a store", async () => {
  let storeRequests = 0;
  const check = createRateLimitChecker({
    getStore: () => {
      storeRequests += 1;
      return new MemoryAbuseStore();
    },
    isProduction: false,
  });

  await check("203.0.113.8");

  assert.equal(storeRequests, 0);
});

test("rate limiting skips missing IPs and absent Redis stores", async () => {
  const availableStores: AbuseStore[] = [];
  let storeRequests = 0;
  const check = createRateLimitChecker({
    getStore: (): AbuseStore | undefined => {
      storeRequests += 1;
      return availableStores[0];
    },
    isProduction: true,
  });

  await check(undefined);
  assert.equal(storeRequests, 0);

  await check("203.0.113.8");
  assert.equal(storeRequests, 1);
});

test("the compatibility limiter preserves 10 requests per 3600 seconds", async () => {
  const store = new MemoryAbuseStore();
  const check = createRateLimitChecker({
    getStore: () => store,
    isProduction: true,
  });

  await Promise.all(Array.from({ length: 10 }, () => check("203.0.113.8")));

  await assert.rejects(
    () => check("203.0.113.8"),
    (error: unknown) =>
      error instanceof ChatbotError &&
      error.type === "rate_limit" &&
      error.surface === "chat"
  );
});

test("the compatibility limiter passes the namespaced subject and legacy window", async () => {
  const calls: Parameters<AbuseStore["consume"]>[] = [];
  const store: AbuseStore = {
    consume: (...input) => {
      calls.push(input);
      return Promise.resolve({
        allowed: true,
        remaining: 9,
        retryAfterSeconds: 3600,
      });
    },
  };
  const check = createRateLimitChecker({
    getStore: () => store,
    isProduction: true,
  });

  await check("203.0.113.8");

  assert.deepEqual(calls, [["chat:ip:203.0.113.8", 10, 3600]]);
});

test("Redis outages retain the current skip behavior", async () => {
  const store: AbuseStore = {
    consume: () => Promise.reject(new Error("Redis unavailable")),
  };
  const check = createRateLimitChecker({
    getStore: () => store,
    isProduction: true,
  });

  await check("203.0.113.8");
});

test("production store configuration errors fail closed", async () => {
  const check = createRateLimitChecker({
    getStore: () => {
      throw new Error(
        "ABUSE_KEY_SECRET is required when REDIS_URL is configured."
      );
    },
    isProduction: true,
  });

  await assert.rejects(
    () => check("203.0.113.8"),
    /ABUSE_KEY_SECRET is required/
  );
});
