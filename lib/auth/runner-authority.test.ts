import assert from "node:assert/strict";
import test from "node:test";
import { decideRunnerAuthority } from "./runner-authority";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const TENANT = "u_9c8589018a57479181fe4c455b099bc9";

function input(
  overrides: Partial<Parameters<typeof decideRunnerAuthority>[0]> = {}
) {
  return {
    authVersion: 4,
    plan: "subscriber" as const,
    sub: USER_ID,
    tenant: TENANT,
    ...overrides,
  };
}

function user(
  overrides: Partial<Parameters<typeof decideRunnerAuthority>[1]> = {}
) {
  return {
    authVersion: 4,
    id: USER_ID,
    subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

test("runner authority allows an exact active subscriber", () => {
  assert.deepEqual(decideRunnerAuthority(input(), user(), NOW), {
    kind: "allowed",
  });
});

test("runner authority denies a revoked auth version without revealing account state", () => {
  assert.deepEqual(
    decideRunnerAuthority(input(), user({ authVersion: 5 }), NOW),
    { kind: "unauthorized" }
  );
});

test("runner authority denies a lapsed subscription without revealing account state", () => {
  assert.deepEqual(
    decideRunnerAuthority(
      input(),
      user({ subscribedUntil: new Date("2026-08-27T12:00:00.000Z") }),
      NOW
    ),
    { kind: "subscription_required" }
  );
});

test("runner authority derives the tenant from the subject", () => {
  assert.deepEqual(
    decideRunnerAuthority(input({ tenant: "victim" }), user(), NOW),
    { kind: "unauthorized" }
  );
});

test("runner authority rejects a plan that differs from the active DB authority", () => {
  assert.deepEqual(
    decideRunnerAuthority(input({ plan: "demo" }), user(), NOW),
    { kind: "subscription_required" }
  );
});

test("runner authority rejects a missing or mismatched subject", () => {
  assert.deepEqual(decideRunnerAuthority(input(), null, NOW), {
    kind: "unauthorized",
  });
  assert.deepEqual(
    decideRunnerAuthority(
      input(),
      user({ id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" }),
      NOW
    ),
    { kind: "unauthorized" }
  );
});
