import assert from "node:assert/strict";
import test from "node:test";
import { connectionDecision } from "./connection-access";

const CONFIGURED = {
  controlToken: "deployment-gate-value",
  endpoint: "https://runner.example.workers.dev",
};

test("a subscriber is handed the connection", () => {
  const decision = connectionDecision({ ...CONFIGURED, plan: "subscriber" });

  assert.equal(decision.kind, "allowed");
  if (decision.kind === "allowed") {
    assert.equal(decision.token, CONFIGURED.controlToken);
    assert.equal(decision.endpoint, CONFIGURED.endpoint);
  }
});

test("a demo session is refused", () => {
  // The control token gates reaching the owner's worker at all. A demo
  // session cannot start a run anyway, so handing it the gate would widen
  // exposure for no capability.
  assert.equal(
    connectionDecision({ ...CONFIGURED, plan: "demo" }).kind,
    "forbidden"
  );
});

test("a signed-out caller is refused", () => {
  assert.equal(
    connectionDecision({ ...CONFIGURED, plan: null }).kind,
    "unauthorized"
  );
});

test("signed-out is checked before plan", () => {
  // Ordering: an anonymous caller gets 401, never 403, so the response never
  // implies an account exists.
  assert.equal(
    connectionDecision({ ...CONFIGURED, plan: null }).kind,
    "unauthorized"
  );
});

test("an unconfigured deployment reports that, rather than handing out an empty token", () => {
  // An empty control token would be accepted by a worker whose own
  // AGENT_CONTROL_TOKEN is also unset, silently removing the deployment gate.
  // Better to fail loudly than to auto-configure a console into an open door.
  for (const controlToken of ["", "   ", undefined]) {
    assert.equal(
      connectionDecision({
        controlToken,
        endpoint: CONFIGURED.endpoint,
        plan: "subscriber",
      }).kind,
      "unconfigured",
      `${JSON.stringify(controlToken)} must not be served`
    );
  }
});

test("a missing endpoint is also unconfigured", () => {
  assert.equal(
    connectionDecision({
      controlToken: CONFIGURED.controlToken,
      endpoint: "",
      plan: "subscriber",
    }).kind,
    "unconfigured"
  );
});

test("the token is trimmed before it is served", () => {
  // A trailing newline from a copy-paste into the dashboard would be sent as
  // part of the header and rejected by the worker's exact comparison.
  const decision = connectionDecision({
    controlToken: "  padded-value\n",
    endpoint: CONFIGURED.endpoint,
    plan: "subscriber",
  });

  assert.equal(decision.kind, "allowed");
  if (decision.kind === "allowed") {
    assert.equal(decision.token, "padded-value");
  }
});
