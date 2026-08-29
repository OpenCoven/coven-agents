import assert from "node:assert/strict";
import test from "node:test";
import type { SubscriberAccessDecision } from "@/lib/auth/subscriber-access";
import {
  createRunnerAuth,
  cronReconcileSecretFromEnvironment,
  diagnosticSecretFromEnvironment,
  MAX_PRIVILEGED_RUNNER_SECRET_LENGTH,
  manualReconcileSecretFromEnvironment,
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
    CRON_SECRET: "reconcile-secret",
    OPERATOR_DIAGNOSTIC_TOKEN: "operator-secret",
    RUNNER_MANUAL_RECONCILE_SECRET: "manual-reconcile-secret",
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

test("missing and currently aliased operator configuration is unavailable", () => {
  assert.equal(diagnosticSecretFromEnvironment({}), null);
  assert.equal(
    diagnosticSecretFromEnvironment({
      CRON_SECRET: "same-secret",
      OPERATOR_DIAGNOSTIC_TOKEN: "same-secret",
    }),
    null
  );
});

test("retired Worker secrets do not participate in current operator authority", () => {
  assert.equal(
    diagnosticSecretFromEnvironment({
      AGENT_CONTROL_TOKEN: "same-secret",
      OPERATOR_DIAGNOSTIC_TOKEN: "same-secret",
      RUNNER_SERVICE_TOKEN: "same-secret",
    }),
    "same-secret"
  );
  assert.equal(
    cronReconcileSecretFromEnvironment({
      AGENT_CONTROL_TOKEN: "same-secret",
      CRON_SECRET: "same-secret",
      RUNNER_SERVICE_TOKEN: "same-secret",
    }),
    "same-secret"
  );
  assert.equal(
    manualReconcileSecretFromEnvironment({
      AGENT_CONTROL_TOKEN: "same-secret",
      RUNNER_MANUAL_RECONCILE_SECRET: "same-secret",
      RUNNER_SERVICE_TOKEN: "same-secret",
    }),
    "same-secret"
  );
});

test("manual reconciliation accepts only its independent bearer secret", () => {
  const auth = runnerAuth();
  const request = (credential: string) =>
    new Request("https://app.test/api/internal/runner-reconcile", {
      headers: { authorization: ["Bearer", credential].join(" ") },
      method: "POST",
    });

  assert.deepEqual(
    auth.authorizeReconcile(request("manual-reconcile-secret")),
    {
      kind: "allowed",
    }
  );
  assert.deepEqual(auth.authorizeReconcile(request("wrong-secret")), {
    kind: "unauthorized",
  });
  assert.equal(manualReconcileSecretFromEnvironment({}), null);
  assert.equal(
    manualReconcileSecretFromEnvironment({
      OPERATOR_DIAGNOSTIC_TOKEN: "same-secret",
      RUNNER_MANUAL_RECONCILE_SECRET: "same-secret",
    }),
    null
  );
});

test("Vercel Cron GET uses CRON_SECRET and rejects invalid authorization", () => {
  const auth = runnerAuth();
  const request = (credential: string) =>
    new Request("https://app.test/api/internal/runner-reconcile", {
      headers: { authorization: ["Bearer", credential].join(" ") },
      method: "GET",
    });

  assert.deepEqual(auth.authorizeReconcile(request("reconcile-secret")), {
    kind: "allowed",
  });
  assert.deepEqual(auth.authorizeReconcile(request("wrong-secret")), {
    kind: "unauthorized",
  });
});

test("GET rejects manual and diagnostic secrets while POST rejects cron and diagnostic secrets", () => {
  const auth = runnerAuth();
  const request = (method: "GET" | "POST", credential: string) =>
    new Request("https://app.test/api/internal/runner-reconcile", {
      headers: { authorization: ["Bearer", credential].join(" ") },
      method,
    });

  for (const credential of ["manual-reconcile-secret", "operator-secret"]) {
    assert.deepEqual(auth.authorizeReconcile(request("GET", credential)), {
      kind: "unauthorized",
    });
  }
  for (const credential of ["reconcile-secret", "operator-secret"]) {
    assert.deepEqual(auth.authorizeReconcile(request("POST", credential)), {
      kind: "unauthorized",
    });
  }
});

test("every privileged runner secret must be independent and bounded", () => {
  for (const alias of [
    { OPERATOR_DIAGNOSTIC_TOKEN: "same-secret" },
    { RUNNER_MANUAL_RECONCILE_SECRET: "same-secret" },
  ]) {
    assert.equal(
      cronReconcileSecretFromEnvironment({
        CRON_SECRET: "same-secret",
        ...alias,
      }),
      null
    );
  }

  for (const alias of [
    { CRON_SECRET: "same-secret" },
    { RUNNER_MANUAL_RECONCILE_SECRET: "same-secret" },
  ]) {
    assert.equal(
      diagnosticSecretFromEnvironment({
        OPERATOR_DIAGNOSTIC_TOKEN: "same-secret",
        ...alias,
      }),
      null
    );
  }

  assert.equal(
    cronReconcileSecretFromEnvironment({
      CRON_SECRET: "x".repeat(MAX_PRIVILEGED_RUNNER_SECRET_LENGTH + 1),
    }),
    null
  );
  assert.equal(
    manualReconcileSecretFromEnvironment({
      RUNNER_MANUAL_RECONCILE_SECRET: "x".repeat(
        MAX_PRIVILEGED_RUNNER_SECRET_LENGTH + 1
      ),
    }),
    null
  );
});

test("secret comparison accepts exact values and rejects near misses", () => {
  assert.equal(timingSafeSecretEqual("one-secret", "one-secret"), true);
  assert.equal(timingSafeSecretEqual("one-secret", "one-secret!"), false);
  assert.equal(timingSafeSecretEqual("one-secret", "other-secret"), false);
});
