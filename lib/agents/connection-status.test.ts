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

test("same-origin runner status copy is provider-neutral and actionable", () => {
  assert.match(applicationRunnerMessage("signed_out"), /sign in/i);
  assert.match(
    applicationRunnerMessage("subscription_required"),
    /subscription/i
  );
  assert.match(applicationRunnerMessage("rate_limited"), /automatically/i);
  assert.match(applicationRunnerMessage("unavailable"), /Daytona runner/i);
  assert.doesNotMatch(
    [
      applicationRunnerMessage("connected"),
      applicationRunnerMessage("connecting"),
      applicationRunnerMessage("signed_out"),
      applicationRunnerMessage("subscription_required"),
      applicationRunnerMessage("rate_limited"),
      applicationRunnerMessage("unavailable"),
    ].join(" "),
    /Cloudflare|cloud runner/i
  );
});
