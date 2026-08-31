import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RETRY_AFTER_DELAY_MS, parseRetryAfter } from "./retry-after";

const NOW = Date.parse("2026-08-31T19:25:01.000Z");

test("Retry-After parses integer seconds and HTTP dates", () => {
  assert.deepEqual(parseRetryAfter("3", NOW), {
    kind: "valid",
    retryAt: NOW + 3000,
  });
  assert.deepEqual(parseRetryAfter("Mon, 31 Aug 2026 19:25:05 GMT", NOW), {
    kind: "valid",
    retryAt: NOW + 4000,
  });
});

test("Retry-After treats past dates as immediately eligible", () => {
  assert.deepEqual(parseRetryAfter("Mon, 31 Aug 2026 19:24:01 GMT", NOW), {
    kind: "valid",
    retryAt: NOW,
  });
});

test("Retry-After distinguishes invalid and excessive values safely", () => {
  assert.deepEqual(parseRetryAfter(null, NOW), { kind: "invalid" });
  assert.deepEqual(parseRetryAfter("-1", NOW), { kind: "invalid" });
  assert.deepEqual(parseRetryAfter("not-a-date", NOW), { kind: "invalid" });
  assert.deepEqual(
    parseRetryAfter(String(MAX_RETRY_AFTER_DELAY_MS / 1000 + 1), NOW),
    {
      kind: "excessive",
      retryAt: NOW + MAX_RETRY_AFTER_DELAY_MS + 1000,
    }
  );
});
