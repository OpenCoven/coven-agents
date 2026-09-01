import assert from "node:assert/strict";
import test from "node:test";
import {
  RUNNER_MID_RUN_ENTITLEMENT_POLICY,
  runnerEntitlementContinuation,
} from "./entitlement-policy";

const startedAt = new Date("2026-09-01T00:00:00.000Z");

test("mid-run entitlement policy revalidates every unlaunched state", () => {
  for (const dispatchState of ["queued", "dispatching"] as const) {
    assert.equal(
      runnerEntitlementContinuation({
        dispatchState,
        hasDurablyAuthorizedLaunch: false,
        now: startedAt,
        startedAt: null,
      }),
      RUNNER_MID_RUN_ENTITLEMENT_POLICY.preLaunch
    );
  }
});

test("mid-run entitlement policy grants only a bounded finish-current continuation", () => {
  const beforeDeadline = new Date(
    startedAt.getTime() + RUNNER_MID_RUN_ENTITLEMENT_POLICY.maxDurationMs - 1
  );
  const atDeadline = new Date(
    startedAt.getTime() + RUNNER_MID_RUN_ENTITLEMENT_POLICY.maxDurationMs
  );

  assert.equal(
    runnerEntitlementContinuation({
      dispatchState: "running",
      hasDurablyAuthorizedLaunch: true,
      now: beforeDeadline,
      startedAt,
    }),
    RUNNER_MID_RUN_ENTITLEMENT_POLICY.postLaunch
  );
  assert.equal(
    runnerEntitlementContinuation({
      dispatchState: "running",
      hasDurablyAuthorizedLaunch: true,
      now: atDeadline,
      startedAt,
    }),
    "max_duration_elapsed"
  );
});

test("mid-run entitlement policy never treats an unproven or malformed launch as finish-current", () => {
  assert.equal(
    runnerEntitlementContinuation({
      dispatchState: "running",
      hasDurablyAuthorizedLaunch: false,
      now: startedAt,
      startedAt,
    }),
    "revalidate_before_effects"
  );
  assert.equal(
    runnerEntitlementContinuation({
      dispatchState: "running",
      hasDurablyAuthorizedLaunch: true,
      now: startedAt,
      startedAt: null,
    }),
    "max_duration_elapsed"
  );
});
