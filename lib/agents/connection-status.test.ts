import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationRunnerMessage,
  applicationRunnerStatusFromError,
} from "./connection-status";

test("same-origin runner refusals retain actionable application states", () => {
  assert.equal(
    applicationRunnerStatusFromError({ code: "unauthorized", status: 401 }),
    "signed_out"
  );
  assert.equal(
    applicationRunnerStatusFromError({
      code: "subscription_required",
      status: 403,
    }),
    "subscription_required"
  );
  assert.equal(
    applicationRunnerStatusFromError({ code: "rate_limited", status: 429 }),
    "rate_limited"
  );
  assert.equal(
    applicationRunnerStatusFromError({
      code: "runner_unavailable",
      status: 503,
    }),
    "unavailable"
  );
  assert.equal(
    applicationRunnerStatusFromError({ code: "invalid_request", status: 400 }),
    null
  );
});

test("same-origin runner status copy matches the current application contract", () => {
  assert.deepEqual(
    Object.fromEntries(
      [
        "connected",
        "connecting",
        "rate_limited",
        "signed_out",
        "subscription_required",
        "unavailable",
      ].map((kind) => [
        kind,
        applicationRunnerMessage(
          kind as Parameters<typeof applicationRunnerMessage>[0]
        ),
      ])
    ),
    {
      connected: "The Daytona runner answered for this authenticated session.",
      connecting: "Connecting to the Daytona runner…",
      rate_limited: "Rate limited — access will be retried automatically.",
      signed_out: "Sign in to use the Daytona runner.",
      subscription_required:
        "An active subscription is required to run agents.",
      unavailable:
        "The Daytona runner is temporarily unavailable. Try again shortly.",
    }
  );
});
