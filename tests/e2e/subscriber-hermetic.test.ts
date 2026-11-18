import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { tenantForUser } from "@/lib/session";
import {
  HERMETIC_USERS,
  incrementHermeticAuthVersion,
  providerProvenanceForRun,
  restoreHermeticSubscriberEntitlement,
  revokeHermeticEntitlement,
  runCertificationCounts,
  runnerRunOutcomeForRun,
  tenantCertificationCounts,
} from "./hermetic-db";
import { e2eOrigin } from "./origin";
import { sessionCookies } from "./session";

const CRON_SECRET = "test-hermetic-cron";
const HERMETIC = process.env.E2E_HERMETIC_RUNNER === "1";
const LOCAL_ORIGIN = e2eOrigin();
const PROVIDER_FIELDS = new Set([
  "adapterVersion",
  "daytona",
  "executionProvenance",
  "provider",
  "sandbox",
  "target",
]);

type ApiResult = Readonly<{
  body: unknown;
  status: number;
  text: string;
}>;

type ReconciliationResult = Readonly<{
  dispatched: number;
  execution: "executed" | "skipped";
}>;

let agentId = "";
let completedRunId = "";

function tenantFor(
  account: (typeof HERMETIC_USERS)[keyof typeof HERMETIC_USERS]
) {
  return tenantForUser(account.id);
}

async function signIn(
  context: BrowserContext,
  account: (typeof HERMETIC_USERS)[keyof typeof HERMETIC_USERS],
  authVersion: number = account.authVersion,
  subscribedUntil: string | null = account.subscribedUntil
): Promise<void> {
  await context.addCookies(
    await sessionCookies("subscriber", {
      authVersion,
      email: account.email,
      id: account.id,
      subscribedUntil,
    })
  );
}

function api(
  page: Page,
  path: string,
  options: Readonly<{
    body?: unknown;
    headers?: Record<string, string>;
    method?: "DELETE" | "GET" | "POST" | "PUT";
  }> = {}
): Promise<ApiResult> {
  return page.evaluate(
    async ({ body, headers, method, path: requestPath }) => {
      const response = await fetch(requestPath, {
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        method: method ?? "GET",
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // SSE certification intentionally reads the raw response below.
      }
      return { body: parsed, status: response.status, text };
    },
    { ...options, path }
  );
}

function agentInput(name = "Hermetic subscriber agent") {
  return {
    backend: "cloud",
    description: "Runs deterministic browser certification.",
    instructions: "Return bounded deterministic evidence.",
    model: "auto",
    name,
    runtime: "copilot",
  };
}

function object(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  return value as Record<string, unknown>;
}

function runIdFrom(result: ApiResult): string {
  const body = object(result.body);
  const run = object(body.run);
  expect(run.id).toEqual(expect.any(String));
  return run.id as string;
}

async function reconcileOnce(
  request: APIRequestContext
): Promise<ReconciliationResult> {
  const response = await request.get("/api/internal/runner-reconcile", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(response.status()).toBe(200);
  const result = object(await response.json());
  const { execution } = result;
  expect(["executed", "skipped"]).toContain(execution);
  expect(result.failures).toBe(0);
  expect(result.dispatched).toEqual(expect.any(Number));
  return {
    dispatched: result.dispatched as number,
    execution: execution as ReconciliationResult["execution"],
  };
}

async function reconcileUntilExecuted(
  request: APIRequestContext,
  page: Page,
  remaining = 40
): Promise<ReconciliationResult> {
  const result = await reconcileOnce(request);
  if (result.execution === "executed") {
    return result;
  }
  if (remaining === 1) {
    throw new Error("Operator reconciliation remained overlapped.");
  }
  await page.waitForTimeout(50);
  return reconcileUntilExecuted(request, page, remaining - 1);
}

async function reconcileUntilRunStatus(
  request: APIRequestContext,
  page: Page,
  runId: string,
  expectedStatus: "completed" | "failed" | "running",
  remaining = 120
): Promise<void> {
  const run = await providerProvenanceForRun(runId);
  if (run.status === expectedStatus) {
    return;
  }
  expect(["queued", "running"]).toContain(run.status);
  if (remaining === 1) {
    expect(run.status).toBe(expectedStatus);
    return;
  }
  await reconcileUntilExecuted(request, page);
  await page.waitForTimeout(50);
  return reconcileUntilRunStatus(
    request,
    page,
    runId,
    expectedStatus,
    remaining - 1
  );
}

async function openAuthenticatedPage(
  page: Page,
  account: (typeof HERMETIC_USERS)[keyof typeof HERMETIC_USERS],
  authVersion: number = account.authVersion,
  subscribedUntil: string | null = account.subscribedUntil
): Promise<void> {
  await signIn(page.context(), account, authVersion, subscribedUntil);
  await page.goto("/ping");
}

function eventIds(text: string): number[] {
  return [...text.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]));
}

test.describe("hermetic subscriber browser certification", () => {
  test.describe.configure({ mode: "serial", timeout: 90_000 });
  test.skip(
    !HERMETIC,
    "This certification runs only through test:e2e:hermetic."
  );

  test("runs the real credential, agent, usage, reconciliation, and provenance path", async ({
    page,
    request,
  }) => {
    const requests: Array<{ body: unknown; headers: Record<string, string> }> =
      [];
    page.on("request", (browserRequest) => {
      const url = new URL(browserRequest.url());
      if (url.origin !== LOCAL_ORIGIN || !url.pathname.includes("/api/")) {
        return;
      }
      let body: unknown = null;
      try {
        body = browserRequest.postDataJSON();
      } catch {
        // GET requests and opaque bodies need no body assertion.
      }
      requests.push({ body, headers: browserRequest.headers() });
    });
    await openAuthenticatedPage(page, HERMETIC_USERS.subscriberA);

    const credential = await api(page, "/api/credentials", {
      body: {
        credential: "hermetic-dummy-copilot-token",
        harnessId: "copilot",
      },
      method: "POST",
    });
    expect(credential.status).toBe(200);
    expect(credential.body).toEqual({ harnessId: "copilot", stored: true });

    const created = await api(page, "/api/agents", {
      body: agentInput(),
      method: "POST",
    });
    expect(
      created.status,
      `${created.text}; page=${await page.evaluate(() => location.origin)}; expected=${LOCAL_ORIGIN}; origin=${requests.at(-1)?.headers.origin ?? "missing"}`
    ).toBe(201);
    agentId = object(object(created.body).agent).id as string;
    const prewarm = await api(page, "/api/tenant/prewarm", { method: "POST" });
    expect([202, 204]).toContain(prewarm.status);

    const started = await api(page, `/api/agents/${agentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000001",
        task: "Complete the hermetic certification task.",
      },
      method: "POST",
    });
    expect(started.status).toBe(202);
    completedRunId = runIdFrom(started);

    await reconcileUntilRunStatus(request, page, completedRunId, "completed");
    const completed = await api(page, `/api/runs/${completedRunId}`);
    expect(completed.status).toBe(200);
    expect(object(object(completed.body).run)).toMatchObject({
      output: "Hermetic runner completed deterministic certification task.",
      status: "completed",
    });
    expect(await providerProvenanceForRun(completedRunId)).toEqual({
      provider: "hermetic",
      status: "completed",
    });
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.subscriberA))
    ).toMatchObject({ agents: 1, credentials: 1, runs: 1, usage: 1 });

    for (const requestRecord of requests) {
      expect(requestRecord.headers.authorization).toBeUndefined();
      expect(
        Object.keys(requestRecord.headers).some((name) =>
          /(?:daytona|provider|sandbox|credential)/iu.test(name)
        )
      ).toBe(false);
      const { body } = requestRecord;
      if (body && typeof body === "object") {
        for (const key of Object.keys(body)) {
          expect(PROVIDER_FIELDS.has(key)).toBe(false);
        }
      }
    }
  });

  test("resumes SSE from a cursor and reuses an operation ID without duplicate billing", async ({
    page,
  }) => {
    await openAuthenticatedPage(page, HERMETIC_USERS.subscriberA);
    const complete = await api(page, `/api/runs/${completedRunId}/events`);
    expect(complete.status).toBe(200);
    const ids = eventIds(complete.text);
    expect(ids.length).toBeGreaterThan(2);
    const [, cursor] = ids;
    const resumed = await api(page, `/api/runs/${completedRunId}/events`, {
      headers: { "last-event-id": String(cursor) },
    });
    expect(resumed.status).toBe(200);
    const resumedIds = eventIds(resumed.text);
    expect(resumedIds.length).toBeGreaterThan(0);
    expect(resumedIds.every((id) => id > cursor)).toBe(true);
    expect(new Set(resumedIds).size).toBe(resumedIds.length);

    const duplicate = await api(page, `/api/agents/${agentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000001",
        task: "Complete the hermetic certification task.",
      },
      method: "POST",
    });
    expect(duplicate.status).toBe(202);
    expect(runIdFrom(duplicate)).toBe(completedRunId);
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.subscriberA))
    ).toMatchObject({ runs: 1, usage: 1 });
  });

  test("fences tenant B from tenant A agents, runs, and credentials", async ({
    page,
  }) => {
    await openAuthenticatedPage(page, HERMETIC_USERS.subscriberB);
    for (const result of await Promise.all([
      api(page, `/api/agents/${agentId}`),
      api(page, `/api/agents/${agentId}`, {
        body: agentInput("Unauthorized mutation"),
        method: "PUT",
      }),
      api(page, `/api/agents/${agentId}`, { method: "DELETE" }),
      api(page, `/api/agents/${agentId}/runs`),
      api(page, `/api/runs/${completedRunId}`),
      api(page, `/api/runs/${completedRunId}/stop`, { method: "POST" }),
    ])) {
      expect(result.status).toBe(404);
    }
    const credentialState = await api(page, "/api/credentials");
    expect(credentialState.status).toBe(200);
    expect(credentialState.body).toEqual({ harnessIds: [] });
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.subscriberB))
    ).toEqual({
      agents: 0,
      credentials: 0,
      reservations: 0,
      runs: 0,
      usage: 0,
    });
  });

  test("rejects ineligible and stale sessions before credential or runner effects", async ({
    page,
  }) => {
    const beforeIneligible = await tenantCertificationCounts(
      tenantFor(HERMETIC_USERS.ineligible)
    );
    await openAuthenticatedPage(page, HERMETIC_USERS.ineligible);
    const [agents, usage, credentials, credentialWrite, deviceFlow, run] =
      await Promise.all([
        api(page, "/api/agents"),
        api(page, "/api/usage"),
        api(page, "/api/credentials"),
        api(page, "/api/credentials", {
          body: {
            credential: "hermetic-dummy-copilot-token",
            harnessId: "copilot",
          },
          method: "POST",
        }),
        api(page, "/api/credentials/device", { method: "POST" }),
        api(page, `/api/agents/${agentId}/runs`, {
          body: {
            operationId: "10000000-0000-4000-8000-000000000002",
            task: "This must be rejected before admission.",
          },
          method: "POST",
        }),
      ]);
    for (const result of [
      agents,
      credentials,
      credentialWrite,
      deviceFlow,
      run,
    ]) {
      expect(result.status).toBe(403);
    }
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({
      dailyRemaining: 0,
      globalAdmissionClosed: true,
      monthlyRemaining: 0,
      resetsAt: null,
    });
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.ineligible))
    ).toEqual(beforeIneligible);

    const beforeStale = await tenantCertificationCounts(
      tenantFor(HERMETIC_USERS.subscriberA)
    );
    await openAuthenticatedPage(
      page,
      HERMETIC_USERS.subscriberA,
      HERMETIC_USERS.subscriberA.authVersion - 1
    );
    const stale = await api(page, "/api/agents");
    expect(stale.status).toBe(401);
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.subscriberA))
    ).toEqual(beforeStale);
  });

  test("invalidates an old signed cookie before a fresh protected operation", async ({
    page,
  }) => {
    const before = await tenantCertificationCounts(
      tenantFor(HERMETIC_USERS.subscriberA)
    );
    await openAuthenticatedPage(page, HERMETIC_USERS.subscriberA);
    await incrementHermeticAuthVersion(HERMETIC_USERS.subscriberA.id);
    const result = await api(page, "/api/agents", {
      body: agentInput("Must not be created"),
      method: "POST",
    });
    expect(result.status).toBe(401);
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.subscriberA))
    ).toEqual(before);
  });

  test("cancels a held fake run and never invents a second terminal outcome", async ({
    page,
    request,
  }) => {
    const freshVersion = HERMETIC_USERS.subscriberA.authVersion + 1;
    await openAuthenticatedPage(page, HERMETIC_USERS.subscriberA, freshVersion);
    const started = await api(page, `/api/agents/${agentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000003",
        task: "Hold for cancellation [[hermetic:hold]]",
      },
      method: "POST",
    });
    expect(started.status).toBe(202);
    const heldRunId = runIdFrom(started);
    await reconcileUntilRunStatus(request, page, heldRunId, "running");
    expect(
      object(object((await api(page, `/api/runs/${heldRunId}`)).body).run)
    ).toMatchObject({
      status: "running",
    });

    const stopped = await api(page, `/api/runs/${heldRunId}/stop`, {
      method: "POST",
    });
    expect(stopped.status).toBe(200);
    expect(object(object(stopped.body).run)).toMatchObject({
      status: "cancelled",
    });
    await reconcileUntilExecuted(request, page);
    expect(
      object(object((await api(page, `/api/runs/${heldRunId}`)).body).run)
    ).toMatchObject({
      status: "cancelled",
    });

    const completedStop = await api(page, `/api/runs/${completedRunId}/stop`, {
      method: "POST",
    });
    expect(completedStop.status).toBe(200);
    expect(object(object(completedStop.body).run)).toMatchObject({
      status: "completed",
    });
  });

  test("finishes one durably launched attempt after revocation", async ({
    page,
    request,
  }) => {
    const eligibleAuthVersion = await restoreHermeticSubscriberEntitlement(
      HERMETIC_USERS.subscriberA.id
    );
    await openAuthenticatedPage(
      page,
      HERMETIC_USERS.subscriberA,
      eligibleAuthVersion
    );
    const beforeStart = await tenantCertificationCounts(
      tenantFor(HERMETIC_USERS.subscriberA)
    );
    const started = await api(page, `/api/agents/${agentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000004",
        task: "Complete after durable launch.",
      },
      method: "POST",
    });
    expect(started.status).toBe(202);
    const runId = runIdFrom(started);

    await reconcileUntilRunStatus(request, page, runId, "running");
    expect(await providerProvenanceForRun(runId)).toEqual({
      provider: "hermetic",
      status: "running",
    });
    expect(await runCertificationCounts(runId)).toEqual({
      provenance: 1,
      records: 1,
      usage: 1,
    });

    const revokedAuthVersion = await revokeHermeticEntitlement(
      HERMETIC_USERS.subscriberA.id
    );
    expect(revokedAuthVersion).toBeGreaterThan(eligibleAuthVersion);
    await reconcileUntilRunStatus(request, page, runId, "completed");

    expect(await providerProvenanceForRun(runId)).toEqual({
      provider: "hermetic",
      status: "completed",
    });
    expect(await runCertificationCounts(runId)).toEqual({
      provenance: 1,
      records: 1,
      usage: 1,
    });
    const afterCompletion = await tenantCertificationCounts(
      tenantFor(HERMETIC_USERS.subscriberA)
    );
    expect(afterCompletion).toMatchObject({
      agents: beforeStart.agents,
      credentials: beforeStart.credentials,
      runs: beforeStart.runs + 1,
      usage: beforeStart.usage + 1,
    });

    for (const result of await Promise.all([
      api(page, `/api/runs/${runId}`),
      api(page, "/api/credentials"),
      api(page, "/api/credentials", {
        body: {
          credential: "hermetic-dummy-copilot-token",
          harnessId: "copilot",
        },
        method: "POST",
      }),
      api(page, "/api/tenant/prewarm", { method: "POST" }),
      api(page, `/api/agents/${agentId}/runs`, {
        body: {
          operationId: "10000000-0000-4000-8000-000000000005",
          task: "Old authority must not dispatch.",
        },
        method: "POST",
      }),
    ])) {
      expect(result.status).toBe(401);
    }

    await page.context().clearCookies();
    await openAuthenticatedPage(
      page,
      HERMETIC_USERS.subscriberA,
      revokedAuthVersion,
      null
    );
    for (const result of await Promise.all([
      api(page, `/api/runs/${runId}`),
      api(page, "/api/credentials"),
      api(page, "/api/credentials", {
        body: {
          credential: "hermetic-dummy-copilot-token",
          harnessId: "copilot",
        },
        method: "POST",
      }),
      api(page, "/api/tenant/prewarm", { method: "POST" }),
      api(page, `/api/agents/${agentId}/runs`, {
        body: {
          operationId: "10000000-0000-4000-8000-000000000006",
          task: "Fresh ineligible authority must not dispatch.",
        },
        method: "POST",
      }),
    ])) {
      expect(result.status).toBe(403);
    }
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.subscriberA))
    ).toEqual(afterCompletion);

    await restoreHermeticSubscriberEntitlement(HERMETIC_USERS.subscriberA.id);
  });

  test("revokes tenant-cap queued work before provider effects", async ({
    page,
    request,
  }) => {
    const eligibleAuthVersion = await restoreHermeticSubscriberEntitlement(
      HERMETIC_USERS.subscriberA.id
    );
    await openAuthenticatedPage(
      page,
      HERMETIC_USERS.subscriberA,
      eligibleAuthVersion
    );

    const agentIds = await Promise.all(
      [
        "Hermetic held tenant capacity one",
        "Hermetic held tenant capacity two",
        "Hermetic queued tenant capacity",
      ].map(async (name) => {
        const created = await api(page, "/api/agents", {
          body: agentInput(name),
          method: "POST",
        });
        expect(created.status).toBe(201);
        const { id } = object(object(created.body).agent);
        expect(id).toEqual(expect.any(String));
        return id as string;
      })
    );
    const [firstAgentId, secondAgentId, queuedAgentId] = agentIds;

    const firstHeld = await api(page, `/api/agents/${firstAgentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000007",
        task: "Hold tenant capacity one [[hermetic:hold]]",
      },
      method: "POST",
    });
    expect(firstHeld.status).toBe(202);
    const firstHeldRunId = runIdFrom(firstHeld);
    await reconcileUntilRunStatus(request, page, firstHeldRunId, "running");

    const secondHeld = await api(page, `/api/agents/${secondAgentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000008",
        task: "Hold tenant capacity two [[hermetic:hold]]",
      },
      method: "POST",
    });
    expect(secondHeld.status).toBe(202);
    const secondHeldRunId = runIdFrom(secondHeld);
    await reconcileUntilRunStatus(request, page, secondHeldRunId, "running");

    const grantPath = `/api/agents/${queuedAgentId}/owner-credentials`;
    const grant = await api(page, grantPath, {
      body: { scopes: ["run:start"] },
      method: "POST",
    });
    expect(grant.status).toBe(201);
    const { secret, id: grantId } = grant.body as {
      secret: string;
      id: string;
    };
    const bearer = { authorization: `Bearer ${secret}` };
    const blockedRun = await request.post(`/api/agents/${queuedAgentId}/runs`, {
      data: {
        operationId: "10000000-0000-4000-8000-000000000011",
        task: "Queued machine revocation",
      },
      headers: bearer,
    });
    expect(blockedRun.status()).toBe(202);
    const { run: machineRun } = await blockedRun.json();
    expect(await runnerRunOutcomeForRun(machineRun.id)).toEqual({
      errorCode: null,
      provider: null,
      status: "queued",
    });
    expect(
      (
        await request.get(`/api/runs/${machineRun.id}`, { headers: bearer })
      ).status()
    ).toBe(401);
    expect(
      (
        await request.post(`/api/agents/${secondAgentId}/runs`, {
          data: {},
          headers: bearer,
        })
      ).status()
    ).toBe(401);
    const [revocation] = await Promise.all([
      api(page, grantPath, { body: { id: grantId }, method: "DELETE" }),
      reconcileOnce(request),
    ]);
    expect(revocation.status).toBe(204);
    await reconcileUntilRunStatus(request, page, machineRun.id, "failed");
    expect(await runnerRunOutcomeForRun(machineRun.id)).toEqual({
      errorCode: "authority_revoked",
      provider: null,
      status: "failed",
    });
    expect(await runCertificationCounts(machineRun.id)).toEqual({
      provenance: 0,
      records: 1,
      usage: 0,
    });

    const queued = await api(page, `/api/agents/${queuedAgentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000009",
        task: "Fail before provider admission after authority revocation.",
      },
      method: "POST",
    });
    expect(queued.status).toBe(202);
    const queuedRunId = runIdFrom(queued);

    const capacityReconciliation = await reconcileUntilExecuted(request, page);
    expect(capacityReconciliation.dispatched).toBe(0);
    for (const provenance of await Promise.all(
      [firstHeldRunId, secondHeldRunId].map((heldRunId) =>
        providerProvenanceForRun(heldRunId)
      )
    )) {
      expect(provenance).toEqual({
        provider: "hermetic",
        status: "running",
      });
    }
    expect(await runnerRunOutcomeForRun(queuedRunId)).toEqual({
      errorCode: null,
      provider: null,
      status: "queued",
    });
    expect(await runCertificationCounts(queuedRunId)).toEqual({
      provenance: 0,
      records: 1,
      usage: 0,
    });

    const revokedAuthVersion = await revokeHermeticEntitlement(
      HERMETIC_USERS.subscriberA.id
    );
    expect(revokedAuthVersion).toBeGreaterThan(eligibleAuthVersion);
    await reconcileUntilRunStatus(request, page, queuedRunId, "failed");
    expect(await runnerRunOutcomeForRun(queuedRunId)).toEqual({
      errorCode: "authority_revoked",
      provider: null,
      status: "failed",
    });
    expect(await runCertificationCounts(queuedRunId)).toEqual({
      provenance: 0,
      records: 1,
      usage: 0,
    });
    for (const provenance of await Promise.all(
      [firstHeldRunId, secondHeldRunId].map((heldRunId) =>
        providerProvenanceForRun(heldRunId)
      )
    )) {
      expect(provenance).toEqual({
        provider: "hermetic",
        status: "running",
      });
    }

    const restoredAuthVersion = await restoreHermeticSubscriberEntitlement(
      HERMETIC_USERS.subscriberA.id
    );
    await page.context().clearCookies();
    await openAuthenticatedPage(
      page,
      HERMETIC_USERS.subscriberA,
      restoredAuthVersion
    );
    for (const stopped of await Promise.all(
      [firstHeldRunId, secondHeldRunId].map((heldRunId) =>
        api(page, `/api/runs/${heldRunId}/stop`, { method: "POST" })
      )
    )) {
      expect(stopped.status).toBe(200);
      expect(object(object(stopped.body).run)).toMatchObject({
        status: "cancelled",
      });
    }
    await reconcileUntilExecuted(request, page);
    for (const deleted of await Promise.all(
      agentIds.map((temporaryAgentId) =>
        api(page, `/api/agents/${temporaryAgentId}`, { method: "DELETE" })
      )
    )) {
      expect(deleted.status).toBe(200);
      expect(deleted.body).toEqual({ ok: true });
    }
  });
  test("issues a one-agent credential and drives a cookie-free run through cancellation and revocation", async ({
    page,
    request,
  }) => {
    const account = HERMETIC_USERS.subscriberA;
    const version = await restoreHermeticSubscriberEntitlement(account.id);
    await openAuthenticatedPage(page, account, version);
    const path = `/api/agents/${agentId}/owner-credentials`;
    const issued = await api(page, path, {
      body: {
        scopes: [
          "run:start",
          "run:read",
          "run:events",
          "run:stop",
          "sandbox:inspect",
        ],
      },
      method: "POST",
    });
    expect(issued.status).toBe(201);
    const { id, secret } = issued.body as { id: string; secret: string };
    const headers = { authorization: `Bearer ${secret}` };
    const list = await api(page, path);
    expect(list.status).toBe(200);
    expect(list.text.includes(secret)).toBe(false);
    const started = await request.post(`/api/agents/${agentId}/runs`, {
      data: {
        operationId: "10000000-0000-4000-8000-000000000010",
        task: "Machine cancellation [[hermetic:hold]]",
      },
      headers,
    });
    expect(started.status()).toBe(202);
    const { run } = await started.json();
    await reconcileUntilRunStatus(request, page, run.id, "running");
    const runPath = `/api/runs/${run.id}`;
    // A held executor may have no second event until cancellation. Open the
    // resumed request first and let the terminal event finish its response.
    const resumedRequest = request.get(`${runPath}/events`, {
      headers: { ...headers, "last-event-id": "1" },
    });
    const stopped = await request.post(`${runPath}/stop`, { headers });
    expect(stopped.status()).toBe(200);
    const resumed = await resumedRequest;
    expect(resumed.status()).toBe(200);
    expect(resumed.headers()["content-type"]).toContain("text/event-stream");
    const events = await resumed.text();
    const ids = eventIds(events);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.every((value) => value > 1)).toBe(true);
    expect(events.includes(secret)).toBe(false);
    const terminal = await request.get(runPath, { headers });
    expect(terminal.status()).toBe(200);
    expect((await terminal.json()).run.status).toBe("cancelled");
    expect((await terminal.text()).includes(secret)).toBe(false);
    const revoked = await api(page, path, { body: { id }, method: "DELETE" });
    expect(revoked.status).toBe(204);
    expect((await request.get(runPath, { headers })).status()).toBe(401);
  });
});
