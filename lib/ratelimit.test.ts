import assert from "node:assert/strict";
import test from "node:test";
import { type AbuseStore, MemoryAbuseStore } from "./abuse/store";
import { ChatbotError } from "./errors";
import {
  checkIpRateLimit,
  checkRateLimit,
  createRateLimitChecker,
  ResilientAbuseStore,
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

/**
 * The resilient store exists because production answered 503 whenever the
 * Redis client was configured but not yet connected: node-redis connects
 * asynchronously and queues commands while it does, so a cold boot's first
 * requests either saw no store or hung past the enforcement timeout. Both
 * outcomes turned the limiter's own connection latency into an outage.
 */
test("a throwing Redis degrades to memory limiting, not an outage", async () => {
  const store = new ResilientAbuseStore({
    consume: () => Promise.reject(new Error("connection lost")),
  });

  const first = await store.consume("probe:throw", 2, 60);
  const second = await store.consume("probe:throw", 2, 60);
  const third = await store.consume("probe:throw", 2, 60);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  // The fallback is a real limiter, not a rubber stamp: the budget still runs
  // out.
  assert.equal(third.allowed, false);
});

test("a hanging Redis is raced out, because a hang past the enforcement timeout is a 503", async () => {
  const store = new ResilientAbuseStore(
    { consume: () => new Promise(() => undefined) },
    20
  );

  const result = await store.consume("probe:hang", 5, 60);
  assert.equal(result.allowed, true);
});

test("an answering Redis is used, and the fallback is not consulted", async () => {
  let primaryCalls = 0;
  const store = new ResilientAbuseStore({
    consume: () => {
      primaryCalls += 1;
      return Promise.resolve({
        allowed: false,
        remaining: 0,
        retryAfterSeconds: 30,
      });
    },
  });

  const result = await store.consume("probe:primary", 5, 60);
  assert.equal(primaryCalls, 1);
  // The primary's verdict stands, including a denial — degradation is for
  // failure, never for an answer someone dislikes.
  assert.equal(result.allowed, false);
  assert.equal(result.retryAfterSeconds, 30);
});
