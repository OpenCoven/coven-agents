import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { createRunnerAuth } from "../runner/auth";
import { createRunnerHttpHandlers } from "../runner/http";
import { authenticateBearerOwner } from "../runner/owner-authentication";
import { createSandboxInspectionHandler } from "../runner/sandbox-inspection-http";
import { tenantForUser } from "../session";

const url = process.env.OWNER_CREDENTIAL_TEST_URL;
test("machine refusals precede body and service access, and inspection accepts only the bound grant", {
  skip: !url,
}, async () => {
  assert.ok(url && process.env.POSTGRES_URL === url);
  const { authorizeSubscriberAccess } = await import(
    "../auth/subscriber-authorization.server"
  );
  const { issueOwnerCredential, revokeOwnerCredential } = await import(
    "./owner-credentials"
  );
  const db = postgres(url, { max: 1 });
  const userId = randomUUID();
  const agentId = randomUUID();
  const owner = { authVersion: 1, tenant: tenantForUser(userId), userId };
  const operator = "fixture-diagnostic";
  const deniedEffect = () =>
    assert.fail("Refusal reached service construction or provider");
  const auth = createRunnerAuth({
    authenticate: async () => null,
    authenticateBearerOwner,
    authorizeSubscriberAccess,
    environment: {
      CRON_SECRET: "fixture-cron",
      OPERATOR_DIAGNOSTIC_TOKEN: operator,
      RUNNER_MANUAL_RECONCILE_SECRET: "fixture-manual",
    },
  });
  const deps = {
    auth,
    enforceAbuse: async () => ({ kind: "allowed" }) as const,
    ipAddress: () => null,
  };
  const handlers = createRunnerHttpHandlers({
    ...deps,
    createOperatorService: deniedEffect,
    createService: deniedEffect,
    diagnoseSandbox: deniedEffect,
  });
  const makeRequest = (value?: string) =>
    new Request("https://app.test/api/agents", {
      body: JSON.stringify({
        expectedGeneration: 0,
        expectedSandboxId: "fixture",
      }),
      headers: {
        "content-type": "application/json",
        ...(value === undefined ? {} : { authorization: `Bearer ${value}` }),
      },
      method: "POST",
    });
  const deniedStart = async (
    value: string | undefined,
    id = agentId,
    expected = 401
  ) => {
    const request = makeRequest(value);
    const response = await handlers.startAgentRun(request, id);
    assert.equal(response.status, expected);
    assert.equal(request.bodyUsed, false);
  };
  try {
    await db`insert into "User" (id,email,"authVersion","subscribedUntil") values (${userId},'http@example.invalid',1,now()+interval '1 day')`;
    await db`insert into "RunnerAgent" (id,tenant,name,instructions,model,runtime) values (${agentId},${owner.tenant},'fixture','fixture','auto','copilot')`;
    const foreignUser = randomUUID();
    const foreignAgent = randomUUID();
    await db`insert into "User" (id,email) values (${foreignUser},'foreign@example.invalid')`;
    await db`insert into "RunnerAgent" (id,tenant,name,instructions,model,runtime) values (${foreignAgent},${tenantForUser(foreignUser)},'foreign','fixture','auto','copilot')`;
    const start = await issueOwnerCredential(owner, agentId, ["run:start"]);
    const inspect = await issueOwnerCredential(owner, agentId, [
      "sandbox:inspect",
    ]);
    assert.ok(start && inspect);
    await Promise.all(
      [
        operator,
        "fixture-cron",
        "fixture-manual",
        "invalid",
        "x".repeat(8192),
        "eyJhbGci.fixture.signature",
        inspect.secret,
      ].map((value) => deniedStart(value))
    );
    await deniedStart(undefined, agentId, 403);
    await deniedStart(start.secret, randomUUID());
    await deniedStart(start.secret, foreignAgent);
    const ownerRequest = makeRequest(start.secret);
    assert.equal(auth.authorizeDiagnostic(ownerRequest).kind, "unauthorized");
    assert.equal(auth.authorizeReconcile(ownerRequest).kind, "unauthorized");
    const handler = createSandboxInspectionHandler({
      ...deps,
      createService: (subscriber) => {
        assert.equal(subscriber.principal.ownerCredentialId, inspect.id);
        return {
          inspectSandbox: (principal, target) => {
            assert.equal(principal.tenant, owner.tenant);
            assert.equal(target, agentId);
            return Promise.resolve({
              outcome: "ambiguous",
              reason: "generation_mismatch",
              record: {
                agentId,
                fence: "none",
                generation: 1,
                lifecycle: "ready",
                sandboxId: null,
              },
              version: 1,
            } as const);
          },
        };
      },
    });
    const result = await handler(makeRequest(inspect.secret), agentId);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).outcome, "ambiguous");
    const wrong = makeRequest(start.secret);
    assert.equal((await handler(wrong, agentId)).status, 401);
    assert.equal(wrong.bodyUsed, false);
    await db`update "User" set "subscribedUntil"=null where id=${userId}`;
    await deniedStart(start.secret, agentId, 403);
    await db`update "User" set "subscribedUntil"=now()+interval '1 day',"authVersion"=2 where id=${userId}`;
    await deniedStart(start.secret);
    await db`update "User" set "authVersion"=1 where id=${userId}`;
    await db`update "RunnerOwnerCredential" set "issuedAt"=now()-interval '2 hours',"expiresAt"=now()-interval '1 hour' where id=${start.id}`;
    await deniedStart(start.secret);
    assert.ok(await revokeOwnerCredential(owner, agentId, inspect.id));
    const revoked = makeRequest(inspect.secret);
    assert.equal((await handler(revoked, agentId)).status, 401);
    assert.equal(revoked.bodyUsed, false);
  } finally {
    await db.end();
    const queries = await import("./queries");
    await queries.db.$client.end();
  }
});
