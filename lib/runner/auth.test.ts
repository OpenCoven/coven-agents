import assert from "node:assert/strict";
import test from "node:test";
import type { SubscriberAccessDecision } from "@/lib/auth/subscriber-access";
import {
  createRunnerAuth,
  diagnosticSecretFromEnvironment,
  reconcileSecretFromEnvironment,
  timingSafeSecretEqual,
} from "./auth";

const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const TENANT = "u_9c8589018a57479181fe4c455b099bc9";

function allowedAccess() {
  return {
    authVersion: 4,
    kind: "allowed" as const,
    session: {
      kind: "subscriber" as const,
      tenant: TENANT,
      userId: USER_ID,
    },
    userId: USER_ID,
  };
}

function runnerAuth(
  authorize: () =>
    | SubscriberAccessDecision
    | Promise<SubscriberAccessDecision> = () => allowedAccess(),
  environment = {
    OPERATOR_DIAGNOSTIC_TOKEN: "operator-secret",
    RUNNER_RECONCILE_SECRET: "reconcile-secret",
  }
) {
  return createRunnerAuth({
    authenticate: async () => ({
      user: { authVersion: 4, id: USER_ID, type: "subscriber" },
    }),
    authorizeSubscriberAccess: async () => authorize(),
    environment,
  });
}

test("subscriber authorization derives its tenant only from current account access", async () => {
  const decision = await runnerAuth().authorizeSubscriber();

  assert.deepEqual(decision, {
    authVersion: 4,
    kind: "allowed",
    principal: { kind: "subscriber", tenant: TENANT, userId: USER_ID },
    session: { kind: "subscriber", tenant: TENANT, userId: USER_ID },
    userId: USER_ID,
  });
});

test("subscriber authorization fails closed for signed-out, expired, stale, and lookup failures", async () => {
  let signedOutAuthorizationCalls = 0;
  const signedOut = createRunnerAuth({
    authenticate: async () => null,
    authorizeSubscriberAccess: () => {
      signedOutAuthorizationCalls += 1;
      return Promise.resolve(allowedAccess());
    },
  });
  const expired = runnerAuth(() => ({ kind: "unauthorized" }));
  const stale = runnerAuth(() => ({ kind: "subscription_required" }));
  const unavailable = runnerAuth(() =>
    Promise.reject(new Error("subscription lookup failed"))
  );

  assert.deepEqual(await signedOut.authorizeSubscriber(), {
    kind: "unauthorized",
  });
  assert.equal(signedOutAuthorizationCalls, 0);
  assert.deepEqual(await expired.authorizeSubscriber(), {
    kind: "unauthorized",
  });
  assert.deepEqual(await stale.authorizeSubscriber(), {
    kind: "subscription_required",
  });
  assert.deepEqual(await unavailable.authorizeSubscriber(), {
    kind: "subscription_required",
  });
});

test("operator diagnostics accept only their separate timing-safe bearer secret", () => {
  const auth = runnerAuth();
  const allowed = new Request("https://app.test/api/diagnostics/sandbox", {
    headers: { authorization: "Bearer operator-secret" },
    method: "POST",
  });
  const wrong = new Request("https://app.test/api/diagnostics/sandbox", {
    headers: { authorization: "Bearer reconcile-secret" },
    method: "POST",
  });
  const legacy = new Request("https://app.test/api/diagnostics/sandbox", {
    headers: {
      authorization: "Bearer operator-secret",
      "x-runner-token": "retired-browser-token",
    },
    method: "POST",
  });

  assert.deepEqual(auth.authorizeDiagnostic(allowed), { kind: "allowed" });
  assert.deepEqual(auth.authorizeDiagnostic(wrong), { kind: "unauthorized" });
  assert.deepEqual(auth.authorizeDiagnostic(legacy), {
    kind: "unauthorized",
  });
});

test("missing and aliased operator configuration is unavailable", () => {
  assert.equal(diagnosticSecretFromEnvironment({}), null);
  assert.equal(
    diagnosticSecretFromEnvironment({
      AGENT_CONTROL_TOKEN: "same-secret",
      OPERATOR_DIAGNOSTIC_TOKEN: "same-secret",
    }),
    null
  );
  assert.equal(
    diagnosticSecretFromEnvironment({
      OPERATOR_DIAGNOSTIC_TOKEN: "same-secret",
      RUNNER_RECONCILE_SECRET: "same-secret",
    }),
    null
  );
});

test("reconciliation accepts only its independent bearer secret", () => {
  const auth = runnerAuth();

  assert.deepEqual(
    auth.authorizeReconcile(
      new Request("https://app.test/api/internal/runner-reconcile", {
        headers: { authorization: "Bearer reconcile-secret" },
        method: "POST",
      })
    ),
    { kind: "allowed" }
  );
  assert.deepEqual(
    auth.authorizeReconcile(
      new Request("https://app.test/api/internal/runner-reconcile", {
        headers: { authorization: "Bearer operator-secret" },
        method: "POST",
      })
    ),
    { kind: "unauthorized" }
  );
  assert.equal(reconcileSecretFromEnvironment({}), null);
  assert.equal(
    reconcileSecretFromEnvironment({
      OPERATOR_DIAGNOSTIC_TOKEN: "same-secret",
      RUNNER_RECONCILE_SECRET: "same-secret",
    }),
    null
  );
});

test("secret comparison accepts exact values and rejects near misses", () => {
  assert.equal(timingSafeSecretEqual("one-secret", "one-secret"), true);
  assert.equal(timingSafeSecretEqual("one-secret", "one-secret!"), false);
  assert.equal(timingSafeSecretEqual("one-secret", "other-secret"), false);
});
