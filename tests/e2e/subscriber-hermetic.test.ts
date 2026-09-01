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
  revokeHermeticEntitlement,
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
  authVersion: number = account.authVersion
): Promise<void> {
  await context.addCookies(
    await sessionCookies("subscriber", {
      authVersion,
      email: account.email,
      id: account.id,
      subscribedUntil: account.subscribedUntil,
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

async function reconcileOnce(request: APIRequestContext): Promise<void> {
  const response = await request.get("/api/internal/runner-reconcile", {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
  expect(response.status()).toBe(200);
  const result = object(await response.json());
  expect(["executed", "skipped"]).toContain(result.execution);
  expect(result.failures).toBe(0);
}

async function reconcileUntilRunning(
  request: APIRequestContext,
  page: Page,
  runId: string,
  remaining = 5
): Promise<boolean> {
  await reconcileOnce(request);
  const run = object(object((await api(page, `/api/runs/${runId}`)).body).run);
  if (run.status === "running") {
    return true;
  }
  if (remaining === 1) {
    return false;
  }
  await page.waitForTimeout(50);
  return reconcileUntilRunning(request, page, runId, remaining - 1);
}

async function reconcile(
  request: APIRequestContext,
  page?: Page
): Promise<void> {
  const execute = async () => {
    const response = await request.get("/api/internal/runner-reconcile", {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(response.status()).toBe(200);
    const result = object(await response.json());
    expect(result.execution).toBe("executed");
    expect(result.failures).toBe(0);
  };
  if (!page) {
    await execute();
    return;
  }
  await page.waitForTimeout(1100);
  await execute();
  await page.waitForTimeout(1100);
  await execute();
}

async function openAuthenticatedPage(
  page: Page,
  account: (typeof HERMETIC_USERS)[keyof typeof HERMETIC_USERS],
  authVersion: number = account.authVersion
): Promise<void> {
  await signIn(page.context(), account, authVersion);
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

    await reconcile(request, page);
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
    await reconcile(request, page);
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
    await reconcile(request, page);
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

  test("finishes one launched attempt after revocation without admitting another", async ({
    page,
    request,
  }) => {
    const eligibleAuthVersion = HERMETIC_USERS.subscriberA.authVersion + 1;
    await openAuthenticatedPage(
      page,
      HERMETIC_USERS.subscriberA,
      eligibleAuthVersion
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

    expect(await reconcileUntilRunning(request, page, runId)).toBe(true);
    const capacityHolder = await api(page, `/api/agents/${agentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000005",
        task: "Hold queued capacity for revocation certification.",
      },
      method: "POST",
    });
    expect(capacityHolder.status).toBe(202);
    const capacityHolderRunId = runIdFrom(capacityHolder);
    expect(
      await reconcileUntilRunning(request, page, capacityHolderRunId)
    ).toBe(true);
    const queued = await api(page, `/api/agents/${agentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000006",
        task: "Must not launch after revocation.",
      },
      method: "POST",
    });
    expect(queued.status).toBe(202);
    const queuedRunId = runIdFrom(queued);
    expect(
      object(object((await api(page, `/api/runs/${queuedRunId}`)).body).run)
    ).toMatchObject({ status: "queued" });
    expect(await providerProvenanceForRun(runId)).toEqual({
      provider: "hermetic",
      status: "running",
    });
    const beforeRevocation = await tenantCertificationCounts(
      tenantFor(HERMETIC_USERS.subscriberA)
    );

    await revokeHermeticEntitlement(HERMETIC_USERS.subscriberA.id);
    await page.waitForTimeout(1100);
    await reconcile(request, page);

    expect(await providerProvenanceForRun(runId)).toEqual({
      provider: "hermetic",
      status: "completed",
    });
    expect(await providerProvenanceForRun(capacityHolderRunId)).toEqual({
      provider: "hermetic",
      status: "completed",
    });
    expect(await runnerRunOutcomeForRun(queuedRunId)).toEqual({
      errorCode: "authority_revoked",
      provider: null,
      status: "failed",
    });
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.subscriberA))
    ).toEqual(beforeRevocation);

    const oldSessionRead = await api(page, `/api/runs/${runId}`);
    const oldSessionStart = await api(page, `/api/agents/${agentId}/runs`, {
      body: {
        operationId: "10000000-0000-4000-8000-000000000007",
        task: "Old authority must not dispatch.",
      },
      method: "POST",
    });
    expect(oldSessionRead.status).toBe(401);
    expect(oldSessionStart.status).toBe(401);

    await page.context().clearCookies();
    await page.context().addCookies(
      await sessionCookies("subscriber", {
        authVersion: eligibleAuthVersion + 1,
        email: HERMETIC_USERS.subscriberA.email,
        id: HERMETIC_USERS.subscriberA.id,
        subscribedUntil: null,
      })
    );
    await page.goto("/ping");
    const [agents, credentialRead, credentialWrite, prewarm, freshStart] =
      await Promise.all([
        api(page, "/api/agents"),
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
            operationId: "10000000-0000-4000-8000-000000000008",
            task: "Fresh ineligible authority must not dispatch.",
          },
          method: "POST",
        }),
      ]);
    for (const result of [
      agents,
      credentialRead,
      credentialWrite,
      prewarm,
      freshStart,
    ]) {
      expect(result.status).toBe(403);
    }
    expect(
      await tenantCertificationCounts(tenantFor(HERMETIC_USERS.subscriberA))
    ).toEqual(beforeRevocation);
  });
});
