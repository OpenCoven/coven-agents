import { expect, type Page, test } from "@playwright/test";
import demoFixture from "@/lib/demo/fixtures/task-summary-demo.json";
import { HERMETIC_USERS } from "./hermetic-db";
import { e2eCookieDomain, e2eOrigin } from "./origin";
import { sessionCookies } from "./session";

const HERMETIC = process.env.E2E_HERMETIC_RUNNER === "1";
const LOCAL_ORIGIN = e2eOrigin();
const SESSION_COOKIE = "authjs.session-token";
const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";
const FIXTURE_AGENT_ID = demoFixture.result.agentId;
const FIXTURE_RUN_ID = demoFixture.result.id;
const SYNTHETIC_CREDENTIAL = "synthetic-credential-certification-not-valid";

const CLIENT_CONTROLLED = {
  agentId: FIXTURE_AGENT_ID,
  credential: SYNTHETIC_CREDENTIAL,
  plan: "subscriber",
  provider: "daytona",
  providerId: "provider-synthetic-id",
  region: "synthetic-region",
  runId: FIXTURE_RUN_ID,
  sandboxId: "sandbox-synthetic-id",
  subscriber: true,
  target: "synthetic-target",
  tenant: "u_synthetic_tenant",
  type: "subscriber",
} as const;

const RESPONSE_FORBIDDEN_VALUES = [
  ...Object.values(CLIENT_CONTROLLED).filter(
    (value): value is string => typeof value === "string"
  ),
  "test-hermetic-auth",
  "test-hermetic-abuse",
  "test-hermetic-cron",
  "test-hermetic-diagnostic",
  "test-hermetic-manual",
  "test-hermetic-postgres",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "postgres://",
  "daytona",
  "stripe",
  "github",
  "stack",
] as const;

type ApiResult = Readonly<{
  body: unknown;
  status: number;
  text: string;
}>;

type ApiOptions = Readonly<{
  body?: unknown;
  method?: "DELETE" | "GET" | "POST" | "PUT";
}>;

type Attack = Readonly<{
  body?: unknown;
  denial: "credential" | "operator" | "runner" | "simple";
  method?: ApiOptions["method"];
  name: string;
  path: string;
}>;

function tamperedSessionValue(): string {
  return `tampered.${Buffer.from(JSON.stringify(CLIENT_CONTROLLED)).toString("base64url")}.synthetic`;
}

function clientControlledPath(path: string): string {
  const query = new URLSearchParams(
    Object.entries(CLIENT_CONTROLLED).map(([name, value]) => [
      name,
      String(value),
    ])
  );
  return `${path}?${query}`;
}

function api(
  page: Page,
  path: string,
  { body, method = "GET" }: ApiOptions = {}
): Promise<ApiResult> {
  return page.evaluate(
    async ({ requestBody, requestMethod, requestPath }) => {
      const response = await fetch(requestPath, {
        body:
          requestBody === undefined ? undefined : JSON.stringify(requestBody),
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(requestBody === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        method: requestMethod,
      });
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // The protected SSE endpoint is expected to reject before streaming.
      }
      return { body: parsed, status: response.status, text };
    },
    {
      requestBody: body,
      requestMethod: method,
      requestPath: clientControlledPath(path),
    }
  );
}

function object(value: unknown): Record<string, unknown> {
  expect(value).toEqual(expect.any(Object));
  return value as Record<string, unknown>;
}

function errorCode(result: ApiResult): string | undefined {
  const { error } = object(result.body);
  return typeof error === "string" ? error : (object(error).code as string);
}

function assertNoResponseLeak(result: ApiResult, name: string): void {
  expect(
    result.text.length,
    `${name}: response exceeded denial bound`
  ).toBeLessThanOrEqual(512);
  const response = result.text.toLowerCase();
  for (const forbidden of RESPONSE_FORBIDDEN_VALUES) {
    expect(response).not.toContain(forbidden.toLowerCase());
  }
}

function assertUnauthorized(result: ApiResult, attack: Attack): void {
  assertNoResponseLeak(result, attack.name);
  const body = object(result.body);
  expect(result.status, `${attack.name}: ${result.text}`).toBe(401);
  expect(errorCode(result)).toBe("unauthorized");
  switch (attack.denial) {
    case "credential":
      expect(body).toEqual({
        error: "unauthorized",
        message: "Sign in before continuing.",
      });
      break;
    case "simple":
      expect(body).toEqual({ error: "unauthorized" });
      break;
    case "operator":
    case "runner":
      expect(body).toEqual({
        apiVersion: expect.any(String),
        error: {
          code: "unauthorized",
          message:
            attack.denial === "operator"
              ? "Operator token was rejected."
              : "Identity was rejected.",
          retryable: false,
        },
        requestId: expect.any(String),
      });
      break;
    default:
      throw new Error(`Unsupported denial type: ${attack.denial}`);
  }
  for (const authorityField of ["agent", "harnessIds", "run", "url"]) {
    expect(body).not.toHaveProperty(authorityField);
  }
}

function assertRunnerNotFound(
  result: ApiResult,
  code: "not_found" | "run_not_found"
): void {
  assertNoResponseLeak(result, code);
  expect(object(result.body)).toEqual({
    apiVersion: expect.any(String),
    error: {
      code,
      message:
        code === "not_found" ? "Agent was not found." : "Run was not found.",
      retryable: false,
    },
    requestId: expect.any(String),
  });
  expect(result.status, result.text).toBe(404);
  expect(errorCode(result)).toBe(code);
}

test.describe("adversarial demo boundary certification", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });
  test.skip(
    !HERMETIC,
    "This certification runs only through test:e2e:hermetic."
  );

  test("rejects a tampered anonymous session before protected effects", async ({
    page,
  }) => {
    const requests: Array<{ headers: Record<string, string>; url: string }> =
      [];
    page.on("request", (request) => {
      requests.push({ headers: request.headers(), url: request.url() });
    });

    const context = page.context();
    expect(await context.cookies()).toEqual([]);
    const tamperedSession = tamperedSessionValue();
    await context.addCookies([
      {
        domain: e2eCookieDomain(),
        httpOnly: true,
        name: SESSION_COOKIE,
        path: "/",
        sameSite: "Lax",
        secure: false,
        value: tamperedSession,
      },
    ]);
    await page.goto("/demo/");

    const agentInput = {
      ...CLIENT_CONTROLLED,
      backend: "cloud",
      description: "Synthetic adversarial request.",
      instructions: "Synthetic adversarial request.",
      model: "auto",
      name: "Synthetic adversarial agent",
      runtime: "copilot",
    };
    const runInput = {
      ...CLIENT_CONTROLLED,
      operationId: "10000000-0000-4000-8000-000000000010",
      task: "Synthetic adversarial run.",
    };
    const devicePollInput = {
      ...CLIENT_CONTROLLED,
      binding: "synthetic-device-binding",
      deviceCode: "synthetic-device-code",
    };
    const attacks: Attack[] = [
      { denial: "runner", name: "agent list", path: "/api/agents" },
      {
        body: agentInput,
        denial: "runner",
        method: "POST",
        name: "agent create",
        path: "/api/agents",
      },
      {
        denial: "runner",
        name: "agent read",
        path: `/api/agents/${FIXTURE_AGENT_ID}`,
      },
      {
        body: agentInput,
        denial: "runner",
        method: "PUT",
        name: "agent update",
        path: `/api/agents/${FIXTURE_AGENT_ID}`,
      },
      {
        denial: "runner",
        method: "DELETE",
        name: "agent delete",
        path: `/api/agents/${FIXTURE_AGENT_ID}`,
      },
      {
        denial: "runner",
        name: "agent run list",
        path: `/api/agents/${FIXTURE_AGENT_ID}/runs`,
      },
      {
        body: runInput,
        denial: "runner",
        method: "POST",
        name: "agent run start",
        path: `/api/agents/${FIXTURE_AGENT_ID}/runs`,
      },
      {
        denial: "runner",
        name: "run read",
        path: `/api/runs/${FIXTURE_RUN_ID}`,
      },
      {
        denial: "runner",
        method: "POST",
        name: "run stop",
        path: `/api/runs/${FIXTURE_RUN_ID}/stop`,
      },
      {
        denial: "runner",
        name: "run events",
        path: `/api/runs/${FIXTURE_RUN_ID}/events`,
      },
      {
        denial: "credential",
        name: "credential list",
        path: "/api/credentials",
      },
      {
        body: { ...CLIENT_CONTROLLED, harnessId: "copilot" },
        denial: "credential",
        method: "POST",
        name: "credential write",
        path: "/api/credentials",
      },
      {
        body: { ...CLIENT_CONTROLLED, harnessId: "copilot" },
        denial: "credential",
        method: "DELETE",
        name: "credential delete",
        path: "/api/credentials",
      },
      {
        denial: "credential",
        method: "POST",
        name: "credential device start",
        path: "/api/credentials/device",
      },
      {
        body: devicePollInput,
        denial: "credential",
        method: "PUT",
        name: "credential device poll",
        path: "/api/credentials/device",
      },
      {
        denial: "runner",
        method: "POST",
        name: "tenant prewarm",
        path: "/api/tenant/prewarm",
      },
      { denial: "simple", name: "usage", path: "/api/usage" },
      {
        body: CLIENT_CONTROLLED,
        denial: "simple",
        method: "POST",
        name: "checkout",
        path: "/api/checkout",
      },
      {
        denial: "operator",
        name: "runner reconcile cron",
        path: "/api/internal/runner-reconcile",
      },
      {
        denial: "operator",
        method: "POST",
        name: "runner reconcile manual",
        path: "/api/internal/runner-reconcile",
      },
      {
        denial: "operator",
        name: "runner inventory cron",
        path: "/api/internal/runner-resource-inventory",
      },
      {
        denial: "operator",
        method: "POST",
        name: "runner inventory manual",
        path: "/api/internal/runner-resource-inventory",
      },
    ];
    const results = await Promise.all(
      attacks.map(async (attack) => ({
        attack,
        result: await api(page, attack.path, {
          body: attack.body,
          method: attack.method,
        }),
      }))
    );

    for (const { attack, result } of results) {
      assertUnauthorized(result, attack);
    }

    const persistedSessionCookies = (await context.cookies()).filter(
      ({ name }) => [SESSION_COOKIE, SECURE_SESSION_COOKIE].includes(name)
    );
    expect(persistedSessionCookies).toEqual([
      expect.objectContaining({
        domain: e2eCookieDomain(),
        name: SESSION_COOKIE,
        value: tamperedSession,
      }),
    ]);
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe(LOCAL_ORIGIN);
      expect(request.headers.authorization).toBeUndefined();
    }
  });

  test("rejects committed demo fixture IDs in a real subscriber context", async ({
    page,
  }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      requests.push(request.url());
    });

    await page
      .context()
      .addCookies(
        await sessionCookies("subscriber", HERMETIC_USERS.subscriberB)
      );
    await page.goto("/demo/");

    const [agent, agentRuns, run, events] = await Promise.all([
      api(page, `/api/agents/${FIXTURE_AGENT_ID}`),
      api(page, `/api/agents/${FIXTURE_AGENT_ID}/runs`),
      api(page, `/api/runs/${FIXTURE_RUN_ID}`),
      api(page, `/api/runs/${FIXTURE_RUN_ID}/events`),
    ]);
    assertRunnerNotFound(agent, "not_found");
    assertRunnerNotFound(agentRuns, "not_found");
    assertRunnerNotFound(run, "run_not_found");
    assertRunnerNotFound(events, "run_not_found");
    expect(requests.length).toBeGreaterThan(1);
    for (const request of requests) {
      expect(new URL(request).origin).toBe(LOCAL_ORIGIN);
    }
  });
});
