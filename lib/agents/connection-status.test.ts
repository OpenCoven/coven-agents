import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationRunnerMessage,
  applicationRunnerStatusFromError,
  connectionMessage,
  readConnectionResponse,
} from "./connection-status";

const PROVISIONED = {
  endpoint: "https://runner.example.workers.dev",
  token: "gate-token",
};

test("a served connection is provisioned", () => {
  const status = readConnectionResponse(200, PROVISIONED);

  assert.equal(status.kind, "provisioned");
  if (status.kind === "provisioned") {
    assert.equal(status.endpoint, PROVISIONED.endpoint);
    assert.equal(status.token, PROVISIONED.token);
  }
});

test("403 is reported as needing a subscription, not as a failure", () => {
  // The defect this fixes: a demo session was refused the connection, the
  // console silently fell back to a stored endpoint pointing at the app, and
  // the user saw "Runner request failed (404)" -- which says nothing true.
  assert.equal(
    readConnectionResponse(403, { error: "subscription_required" }).kind,
    "subscription_required"
  );
});

test("401 is reported as signed out", () => {
  assert.equal(
    readConnectionResponse(401, { error: "unauthorized" }).kind,
    "signed_out"
  );
});

test("503 is reported as an unconfigured deployment", () => {
  assert.equal(
    readConnectionResponse(503, { error: "runner_unconfigured" }).kind,
    "unconfigured"
  );
});

test("a 200 with no token is not treated as provisioned", () => {
  // Applying an empty token would send `x-runner-token: ""`, which a worker
  // with no AGENT_CONTROL_TOKEN of its own would accept -- the deployment gate
  // silently ceasing to exist.
  for (const body of [
    { endpoint: PROVISIONED.endpoint },
    { endpoint: PROVISIONED.endpoint, token: "" },
    null,
  ]) {
    assert.equal(
      readConnectionResponse(200, body).kind,
      "unavailable",
      `${JSON.stringify(body)} must not provision`
    );
  }
});

test("a 200 with no endpoint is not treated as provisioned", () => {
  // An empty endpoint makes the client build a same-origin URL, which is
  // exactly how a runner call became a 404 against the app itself.
  assert.equal(
    readConnectionResponse(200, { endpoint: "", token: "gate-token" }).kind,
    "unavailable"
  );
});

test("a non-200 carrying a valid-looking body still does not provision", () => {
  // Only a 200 provisions. An error response can still carry a body -- a proxy
  // error page, a cached payload, a gateway that rewrites the status -- and
  // trusting the body over the status would hand out a connection the server
  // never agreed to serve.
  for (const status of [500, 502, 418, 302]) {
    assert.equal(
      readConnectionResponse(status, PROVISIONED).kind,
      "unavailable",
      `${status} must not provision`
    );
  }
});

test("an unexpected status is unavailable rather than assumed fine", () => {
  assert.equal(readConnectionResponse(500, null).kind, "unavailable");
  assert.equal(readConnectionResponse(418, null).kind, "unavailable");
});

test("every status has a message that names the cause", () => {
  const kinds = [
    "signed_out",
    "subscription_required",
    "unavailable",
    "unconfigured",
  ] as const;

  for (const kind of kinds) {
    const message = connectionMessage(kind);

    assert.ok(message.length > 0, `${kind} needs a message`);
    // The whole point is that the user learns the cause, so a generic
    // "something went wrong" is a regression.
    assert.ok(
      !/^(error|failed|something went wrong)/i.test(message),
      `${kind} message must name the cause, got: ${message}`
    );
  }
});

test("the subscription message says what to do", () => {
  assert.match(connectionMessage("subscription_required"), /subscription/i);
});

/**
 * The admission layer sits in front of this endpoint since #108, so its
 * refusals arrive on the same status codes the route already used for other
 * meanings. Misreading them is what made the console answer a rate limit by
 * asking for a deployment token.
 */
test("a 429 is rate limiting, not a missing runner", () => {
  const status = readConnectionResponse(429, { error: "rate_limited" }, "137");

  assert.equal(status.kind, "rate_limited");
  if (status.kind === "rate_limited") {
    assert.equal(status.retryAfterSeconds, 137);
  }
});

test("a 429 without a usable retry-after still says how long to wait", () => {
  // The default matters: a rate_limited status with no horizon reads as
  // permanent, which is the misunderstanding this kind exists to end.
  const missing = readConnectionResponse(429, null, null);
  const garbage = readConnectionResponse(429, null, "soon");

  for (const status of [missing, garbage]) {
    assert.equal(status.kind, "rate_limited");
    if (status.kind === "rate_limited") {
      assert.equal(status.retryAfterSeconds, 60);
    }
  }
});

test("only the route's own 503 claims the runner is unconfigured", () => {
  // "Unconfigured" tells the user to paste a token manually — permanent-state
  // advice. The admission layer's 503 is a transient store failure wearing
  // the same status code, and must not trigger that prompt.
  assert.equal(
    readConnectionResponse(503, { error: "runner_unconfigured" }).kind,
    "unconfigured"
  );
  assert.equal(
    readConnectionResponse(503, { error: "rate_limited" }).kind,
    "unavailable"
  );
  assert.equal(readConnectionResponse(503, null).kind, "unavailable");
});

test("same-origin runner refusals retain signed-out, subscription, rate-limit, and unavailable states", () => {
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
