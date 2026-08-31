import assert from "node:assert/strict";
import test from "node:test";
import { abusePolicyFor } from "./policy";
import { ABUSE_ROUTES, type AbusePolicy, type AbuseRoute } from "./types";

const EXPECTED_ROUTES = [
  "auth_start",
  "auth_callback",
  "chat",
  "chat_delete",
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
  "usage_read",
  "analytics_read",
  "model_list",
  "stripe_webhook",
  "run_start",
  "internal_credential",
  "runner_public_read",
  "runner_read",
  "runner_write",
  "runner_run_start",
  "runner_stop",
  "runner_diagnostic",
  "runner_reconcile",
  "skill_read",
  "skill_write",
  "skill_delete",
  "team_read",
  "team_write",
  "team_delete",
  "team_run_read",
  "team_run_start",
  "team_run_stop",
  "team_run_approve",
] as const satisfies readonly AbuseRoute[];

const EXPECTED_POLICIES = {
  analytics_read: expectedPolicy(["ip", "user"], 0, 20, 60, 100, 3600),
  auth_callback: expectedPolicy(["ip"], 16_384, 10, 60, 40, 3600),
  auth_start: expectedPolicy(["ip"], 0, 5, 60, 20, 3600),
  avatar_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  avatar_write: expectedPolicy(["ip", "user"], 8192, 10, 60, 40, 3600),
  chat: expectedPolicy(["ip", "user"], 64_000, 4, 60, 60, 3600),
  chat_delete: expectedPolicy(["ip", "user"], 0, 5, 60, 20, 3600),
  checkout: expectedPolicy(["ip", "user"], 8192, 2, 300, 3, 3600),
  credential_delete: expectedPolicy(["ip", "user"], 8192, 10, 60, 40, 3600),
  credential_device_poll: expectedPolicy(
    ["ip", "user"],
    8192,
    12,
    60,
    60,
    3600
  ),
  credential_device_start: expectedPolicy(["ip", "user"], 0, 2, 300, 5, 3600),
  credential_list: expectedPolicy(["ip", "user"], 0, 30, 60, 200, 3600),
  credential_write: expectedPolicy(["ip", "user"], 16_384, 10, 60, 40, 3600),
  document_delete: expectedPolicy(["ip", "user"], 0, 5, 60, 20, 3600),
  document_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  document_write: expectedPolicy(["ip", "user"], 262_144, 20, 60, 100, 3600),
  history_delete: expectedPolicy(["ip", "user"], 0, 5, 60, 20, 3600),
  history_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  internal_credential: expectedPolicy(["ip", "tenant"], 8192, 10, 60, 60, 3600),
  messages_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  model_list: expectedPolicy(["ip"], 0, 120, 60, 1200, 3600),
  run_start: expectedPolicy(["ip", "tenant"], 64_000, 5, 60, 25, 86_400),
  runner_diagnostic: expectedPolicy(["ip"], 1024, 2, 300, 10, 86_400),
  runner_public_read: expectedPolicy(["ip"], 0, 120, 60, 1200, 3600),
  runner_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  runner_reconcile: expectedPolicy(["ip"], 1024, 120, 60, 1200, 3600),
  runner_run_start: expectedPolicy(["ip", "tenant"], 64_000, 5, 60, 25, 86_400),
  runner_stop: expectedPolicy(["ip", "tenant"], 1024, 5, 60, 20, 3600),
  runner_write: expectedPolicy(["ip", "user"], 64_000, 10, 60, 40, 3600),
  skill_delete: expectedPolicy(["ip", "tenant"], 0, 5, 60, 20, 3600),
  skill_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  skill_write: expectedPolicy(["ip", "tenant"], 8192, 10, 60, 40, 3600),
  stripe_webhook: expectedPolicy(["ip"], 262_144, 60, 60, 600, 3600),
  suggestions_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  team_delete: expectedPolicy(["ip", "tenant"], 0, 5, 60, 20, 3600),
  team_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  team_run_approve: expectedPolicy(["ip", "tenant"], 4096, 10, 60, 40, 3600),
  team_run_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  team_run_start: expectedPolicy(["ip", "tenant"], 64_000, 5, 60, 25, 86_400),
  team_run_stop: expectedPolicy(["ip", "tenant"], 1024, 5, 60, 20, 3600),
  team_write: expectedPolicy(["ip", "tenant"], 131_072, 10, 60, 40, 3600),
  upload: expectedPolicy(["ip", "user"], 5_250_000, 2, 60, 20, 3600),
  usage_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  vote_read: expectedPolicy(["ip", "user"], 0, 60, 60, 600, 3600),
  vote_write: expectedPolicy(["ip", "user"], 8192, 20, 60, 100, 3600),
} as const satisfies Record<AbuseRoute, AbusePolicy>;

test("the registry covers every reviewed route", () => {
  assert.deepEqual(ABUSE_ROUTES, EXPECTED_ROUTES);

  for (const route of EXPECTED_ROUTES) {
    assert.ok(abusePolicyFor(route), `${route} needs a policy`);
  }
});

test("every route keeps its exact approved policy", () => {
  for (const route of EXPECTED_ROUTES) {
    assert.deepEqual(abusePolicyFor(route), EXPECTED_POLICIES[route], route);
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
  const coercibleRoute = {
    toString: () => "chat",
    valueOf: () => "chat",
  };
  const boxedRoute: unknown = Reflect.construct(String, ["chat"]);

  for (const route of [
    "unknown",
    "toString",
    null,
    undefined,
    1,
    coercibleRoute,
    boxedRoute,
  ]) {
    assert.throws(
      () => abusePolicyFor(route),
      /No abuse policy/,
      String(route)
    );
  }
});

test("route and policy values cannot be mutated process-wide", () => {
  assert.ok(Object.isFrozen(ABUSE_ROUTES));

  for (const route of EXPECTED_ROUTES) {
    const policy = abusePolicyFor(route);

    assert.ok(Object.isFrozen(policy), route);
    assert.ok(Object.isFrozen(policy.burst), `${route}.burst`);
    assert.ok(Object.isFrozen(policy.sustained), `${route}.sustained`);
    assert.ok(Object.isFrozen(policy.subjects), `${route}.subjects`);
  }

  const originalRoutes = [...ABUSE_ROUTES];
  const chatPolicy = abusePolicyFor("chat");

  assert.equal(Reflect.set(ABUSE_ROUTES, "0", "chat"), false);
  assert.equal(Reflect.set(chatPolicy, "bodyBytes", 1), false);
  assert.equal(Reflect.set(chatPolicy.burst, "limit", 1), false);
  assert.equal(Reflect.set(chatPolicy.sustained, "limit", 1), false);
  assert.equal(Reflect.set(chatPolicy.subjects, "0", "tenant"), false);

  assert.deepEqual(ABUSE_ROUTES, originalRoutes);
  assert.deepEqual(abusePolicyFor("chat"), EXPECTED_POLICIES.chat);
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
