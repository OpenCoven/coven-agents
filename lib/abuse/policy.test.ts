import assert from "node:assert/strict";
import test from "node:test";
import { abusePolicyFor } from "./policy";
import { ABUSE_ROUTES, type AbusePolicy, type AbuseRoute } from "./types";

const EXPECTED_ROUTES = [
  "auth_start",
  "auth_callback",
  "chat",
  "document_read",
  "document_write",
  "document_delete",
  "history_read",
  "history_delete",
  "messages_read",
  "suggestions_read",
  "vote_read",
  "vote_write",
  "upload",
  "checkout",
  "avatar_read",
  "avatar_write",
  "credential_list",
  "credential_write",
  "credential_delete",
  "credential_device_start",
  "credential_device_poll",
  "runner_connection",
  "runner_token",
  "usage_read",
  "analytics_read",
  "model_list",
  "stripe_webhook",
  "run_start",
  "internal_credential",
] as const satisfies readonly AbuseRoute[];

const REVIEWED_MAXIMA = {
  auth_callback: expectedPolicy(["ip"], 16_384, 10, 60, 40, 3600),
  auth_start: expectedPolicy(["ip"], 0, 5, 60, 20, 3600),
  chat: expectedPolicy(["ip", "user"], 64_000, 4, 60, 60, 3600),
  checkout: expectedPolicy(["ip", "user"], 8192, 2, 300, 3, 3600),
  credential_device_poll: expectedPolicy(
    ["ip", "user"],
    8192,
    12,
    60,
    60,
    3600
  ),
  credential_device_start: expectedPolicy(["ip", "user"], 0, 2, 300, 5, 3600),
  run_start: expectedPolicy(["ip", "tenant"], 64_000, 5, 60, 25, 86_400),
  runner_connection: expectedPolicy(["ip", "user"], 0, 10, 60, 60, 3600),
  runner_token: expectedPolicy(["ip", "user"], 0, 10, 60, 60, 3600),
  upload: expectedPolicy(["ip", "user"], 5_250_000, 2, 60, 20, 3600),
} as const satisfies Partial<Record<AbuseRoute, AbusePolicy>>;

test("the registry covers every reviewed route", () => {
  assert.deepEqual(ABUSE_ROUTES, EXPECTED_ROUTES);

  for (const route of EXPECTED_ROUTES) {
    assert.ok(abusePolicyFor(route), `${route} needs a policy`);
  }
});

test("reviewed high-cost routes keep their approved maxima", () => {
  for (const [route, expected] of Object.entries(REVIEWED_MAXIMA)) {
    assert.deepEqual(abusePolicyFor(route as AbuseRoute), expected, route);
  }
});

test("every declared route initially fails closed", () => {
  for (const route of EXPECTED_ROUTES) {
    assert.equal(abusePolicyFor(route).failureMode, "closed", route);
  }
});

test("every policy has valid finite integer bounds and subjects", () => {
  for (const route of EXPECTED_ROUTES) {
    const policy = abusePolicyFor(route);

    assertNonNegativeInteger(policy.bodyBytes, `${route}.bodyBytes`);
    assertPositiveWindow(policy.burst, `${route}.burst`);
    assertPositiveWindow(policy.sustained, `${route}.sustained`);
    assert.ok(
      policy.sustained.windowSeconds >= policy.burst.windowSeconds,
      `${route} sustained window must cover at least the burst window`
    );
    assert.ok(policy.subjects.length > 0, `${route} needs a subject`);
  }
});

test("unknown runtime route values fail during lookup", () => {
  for (const route of ["unknown", "toString"]) {
    assert.throws(
      () => abusePolicyFor(route as AbuseRoute),
      /No abuse policy/,
      route
    );
  }
});

function expectedPolicy(
  subjects: AbusePolicy["subjects"],
  bodyBytes: number,
  burstLimit: number,
  burstWindowSeconds: number,
  sustainedLimit: number,
  sustainedWindowSeconds: number
): AbusePolicy {
  return {
    bodyBytes,
    burst: { limit: burstLimit, windowSeconds: burstWindowSeconds },
    failureMode: "closed",
    subjects,
    sustained: {
      limit: sustainedLimit,
      windowSeconds: sustainedWindowSeconds,
    },
  };
}

function assertNonNegativeInteger(value: number, label: string): void {
  assert.ok(Number.isFinite(value), `${label} must be finite`);
  assert.ok(Number.isInteger(value), `${label} must be an integer`);
  assert.ok(value >= 0, `${label} must not be negative`);
}

function assertPositiveWindow(
  window: AbusePolicy["burst"],
  label: string
): void {
  assertNonNegativeInteger(window.limit, `${label}.limit`);
  assertNonNegativeInteger(window.windowSeconds, `${label}.windowSeconds`);
  assert.ok(window.limit > 0, `${label}.limit must be positive`);
  assert.ok(
    window.windowSeconds > 0,
    `${label}.windowSeconds must be positive`
  );
}
