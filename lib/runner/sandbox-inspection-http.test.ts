import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxInspectionResult } from "@opencoven/agent-contracts";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import type {
  RunnerAuthenticatedSubscriber,
  RunnerBearerOwnerAuthorization,
} from "./auth";
import { createSandboxInspectionHandler } from "./sandbox-inspection-http";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const subscriber: RunnerAuthenticatedSubscriber = {
  authVersion: 4,
  kind: "allowed",
  principal: { kind: "subscriber", tenant: "tenant_a", userId: "user-a" },
  session: { kind: "subscriber", tenant: "tenant_a", userId: "user-a" },
  userId: "user-a",
};
const observed: SandboxInspectionResult = {
  outcome: "ambiguous",
  reason: "generation_mismatch",
  record: { fence: "none", generation: 3, lifecycle: "ready" },
  version: 1,
};

function fixture(
  options: Readonly<{
    admission?: AbuseAdmission;
    authorization?: RunnerBearerOwnerAuthorization | null;
    result?: SandboxInspectionResult | Error;
  }> = {}
) {
  const events: string[] = [];
  const inspections: unknown[] = [];
  const admissions: AbuseEnforcementInput[] = [];
  const handler = createSandboxInspectionHandler({
    auth:
      options.authorization === null
        ? {}
        : {
            authorizeBearerOwner: () => {
              events.push("auth");
              return Promise.resolve(options.authorization ?? subscriber);
            },
          },
    createRequestId: () => "request-1",
    createService: (owner) => {
      events.push("service");
      return {
        inspectSandbox: (principal, agentId, expected) => {
          events.push("inspect");
          inspections.push({ agentId, expected, owner, principal });
          return options.result instanceof Error
            ? Promise.reject(options.result)
            : Promise.resolve(options.result ?? observed);
        },
      };
    },
    enforceAbuse: (input) => {
      events.push("abuse");
      admissions.push(input);
      return Promise.resolve(options.admission ?? { kind: "allowed" });
    },
    ipAddress: () => "203.0.113.7",
  });
  return { admissions, events, handler, inspections };
}

function request(
  body: unknown = { expectedGeneration: 3, expectedSandboxId: "sandbox-a" },
  headers: Record<string, string> = { "content-type": "application/json" }
) {
  return new Request(
    `https://agents.example/api/agents/${AGENT_ID}/sandbox/inspection`,
    {
      body: typeof body === "string" ? body : JSON.stringify(body),
      headers,
      method: "POST",
    }
  );
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

test("an authorized owner receives the contract result and nothing is cached", async () => {
  const { admissions, events, handler, inspections } = fixture();
  const response = await handler(request(), AGENT_ID);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), observed);
  assert.deepEqual(events, ["auth", "abuse", "service", "inspect"]);
  assert.deepEqual(inspections, [
    {
      agentId: AGENT_ID,
      expected: { expectedGeneration: 3, expectedSandboxId: "sandbox-a" },
      owner: subscriber,
      principal: subscriber.principal,
    },
  ]);
  assert.deepEqual(admissions, [
    {
      failClosed: true,
      ip: "203.0.113.7",
      route: "runner_sandbox_inspect",
      tenant: "tenant_a",
      userId: "user-a",
    },
  ]);
});

test("the tenant comes from the authenticated owner, never from the body", async () => {
  const { events, handler } = fixture();
  const response = await handler(
    request({
      expectedGeneration: 3,
      expectedSandboxId: "sandbox-a",
      tenant: "tenant_b",
    }),
    AGENT_ID
  );
  assert.equal(response.status, 400);
  assert.equal(await errorCode(response), "invalid_request");
  assert.deepEqual(events, ["auth", "abuse"]);
});

test("every unauthenticated outcome stops before abuse, body, and service work", async () => {
  const cases = [
    [{ kind: "unauthorized" }, 401, "unauthorized"],
    [{ kind: "subscription_required" }, 403, "subscription_required"],
    [{ kind: "unavailable" }, 503, "runner_unavailable"],
    [null, 503, "runner_unavailable"],
  ] as const;
  for (const [authorization, status, code] of cases) {
    const { events, handler } = fixture({ authorization });
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    const response = await handler(request(), AGENT_ID);
    assert.equal(response.status, status);
    assert.equal(await errorCode(response), code);
    assert.deepEqual(events, authorization === null ? [] : ["auth"]);
  }
});

test("a non-JSON request is refused before authentication", async () => {
  const { events, handler } = fixture();
  const response = await handler(
    request("expectedSandboxId=sandbox-a", {
      "content-type": "application/x-www-form-urlencoded",
    }),
    AGENT_ID
  );
  assert.equal(response.status, 400);
  assert.equal(await errorCode(response), "unsupported_media_type");
  assert.deepEqual(events, []);
});

test("abuse control denial and outage stop before the service", async () => {
  const denied = fixture({
    admission: { kind: "denied", retryAfterSeconds: 30 } as AbuseAdmission,
  });
  const limited = await denied.handler(request(), AGENT_ID);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "30");
  assert.deepEqual(denied.events, ["auth", "abuse"]);

  const outage = fixture({
    admission: { kind: "unavailable" } as AbuseAdmission,
  });
  const response = await outage.handler(request(), AGENT_ID);
  assert.equal(await errorCode(response), "abuse_control_unavailable");
  assert.deepEqual(outage.events, ["auth", "abuse"]);
});

test("a malformed agent ID or body never reaches the service", async () => {
  const badId = fixture();
  assert.equal((await badId.handler(request(), "not-a-uuid")).status, 400);
  assert.deepEqual(badId.events, ["auth", "abuse"]);

  for (const body of [
    {},
    { expectedGeneration: -1, expectedSandboxId: "sandbox-a" },
    { expectedGeneration: 3, expectedSandboxId: "../other" },
    { expectedGeneration: "3", expectedSandboxId: "sandbox-a" },
    "{",
  ]) {
    const { events, handler } = fixture();
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    assert.equal((await handler(request(body), AGENT_ID)).status, 400);
    assert.deepEqual(events, ["auth", "abuse"]);
  }

  const large = fixture();
  const response = await large.handler(
    request({ expectedGeneration: 3, expectedSandboxId: "a".repeat(4000) }),
    AGENT_ID
  );
  assert.equal(response.status, 413);
  assert.deepEqual(large.events, ["auth", "abuse"]);
});

test("a missing or foreign agent is a non-disclosing not found", async () => {
  const { handler } = fixture({
    result: { outcome: "unauthorized", version: 1 },
  });
  const response = await handler(request(), AGENT_ID);
  assert.equal(response.status, 404);
  assert.equal(await errorCode(response), "not_found");
});

test("provider and database outages are distinct, bounded errors", async () => {
  for (const [source, code] of [
    ["provider", "provider_unavailable"],
    ["database", "runner_unavailable"],
  ] as const) {
    const { handler } = fixture({
      result: { outcome: "unavailable", source, version: 1 },
    });
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    const response = await handler(request(), AGENT_ID);
    assert.equal(response.status, 503);
    assert.equal(await errorCode(response), code);
  }
});

test("an unexpected failure exposes no detail", async () => {
  const { handler } = fixture({
    result: new Error("postgres://user:secret@db.internal failed"),
  });
  const response = await handler(request(), AGENT_ID);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.equal(text.includes("secret"), false);
  assert.equal(text.includes("internal_error"), true);
});
