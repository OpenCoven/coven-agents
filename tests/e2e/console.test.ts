import { expect, type Page, test } from "@playwright/test";
import { subscriberCookies } from "./session";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_RUN_ID = "66666666-6666-4666-8666-666666666666";
const ALLOWED_BROWSER_REQUEST_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "accept-language",
  "content-length",
  "content-type",
  "cookie",
  "origin",
  "priority",
  "referer",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
]);
const retainedAgent = {
  backend: "cloud",
  createdAt: "2026-08-27T06:00:00.000Z",
  description: "Verifies the run timeline.",
  id: AGENT_ID,
  instructions: "Report evidence clearly.",
  lastRunAt: "2026-08-27T06:01:00.000Z",
  model: "auto",
  name: "Timeline auditor",
  owner: {
    kind: "tenant",
    tenantId: "u_00000000000040008000000000000001",
  },
  runtime: "copilot",
  status: "idle",
  updatedAt: "2026-08-27T06:01:00.000Z",
  warm: {
    status: "ready",
    updatedAt: "2026-08-27T06:01:00.000Z",
  },
};

const retainedRun = {
  agentId: AGENT_ID,
  apiVersion: "1.0",
  commandEvidence: [],
  completedAt: "2026-08-27T06:01:00.000Z",
  createdAt: "2026-08-27T06:00:00.000Z",
  fileEvidence: [],
  id: RUN_ID,
  operationId: "33333333-3333-4333-8333-333333333333",
  output: "Timeline verified.",
  startedAt: "2026-08-27T06:00:01.000Z",
  status: "completed",
  task: "Verify timeline output",
};

function liveRun(
  status: "cancelled" | "completed" | "failed" | "running" = "running"
) {
  return {
    ...retainedRun,
    completedAt: status === "running" ? null : "2026-08-27T06:02:00.000Z",
    output: status === "completed" ? "Timeline verified." : "",
    status,
  };
}

function historicalRun(status: "cancelled" | "completed" | "failed") {
  return {
    ...retainedRun,
    output: status === "completed" ? "Historical completion output." : "",
    status,
  };
}

async function notifySessionChange(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const channel = new BroadcastChannel("next-auth");
    channel.postMessage({ event: "session" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.postMessage({ event: "session" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.postMessage({ event: "session" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    channel.close();
  });
}

function expectCurrentBrowserRequestHeaders(
  headers: Record<string, string>,
  url: string,
  options: Readonly<{ contentType?: string; sendsOrigin?: boolean }> = {}
): void {
  expect(
    Object.keys(headers)
      .filter((name) => !ALLOWED_BROWSER_REQUEST_HEADERS.has(name))
      .sort()
  ).toEqual([]);
  expect({
    accept: headers.accept,
    ...(options.contentType ? { "content-type": headers["content-type"] } : {}),
    cookie: headers.cookie,
    ...(options.sendsOrigin ? { origin: headers.origin } : {}),
  }).toEqual({
    accept: "application/json",
    ...(options.contentType ? { "content-type": options.contentType } : {}),
    cookie: expect.stringContaining("authjs.session-token="),
    ...(options.sendsOrigin ? { origin: new URL(url).origin } : {}),
  });
}

test.describe("Run console", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("the default root hydrates the signed-out console without protected requests", async ({
    page,
  }) => {
    const protectedRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        pathname === "/api/credentials" ||
        pathname === "/api/agents" ||
        pathname === "/api/tenant/prewarm"
      ) {
        protectedRequests.push(pathname);
      }
    });

    await page.goto("/");

    await expect(page).toHaveURL("/agents");
    await expect(
      page.getByRole("button", { name: "signed out" })
    ).toBeVisible();
    await page.getByRole("button", { name: "Search or run a command" }).click();
    await expect(
      page.getByRole("dialog", { name: "Search runs, agents, and commands" })
    ).toBeVisible();
    expect(protectedRequests).toEqual([]);
  });

  test("an authenticated subscriber prewarms once through the same-origin API", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let prewarmRequests = 0;
    await page.route("**/api/tenant/prewarm", (route) => {
      prewarmRequests += 1;
      const request = route.request();
      expect(request.method()).toBe("POST");
      expect(new URL(request.url()).pathname).toBe("/api/tenant/prewarm");
      expectCurrentBrowserRequestHeaders(request.headers(), request.url(), {
        sendsOrigin: true,
      });
      return route.fulfill({ status: 204 });
    });
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/api/agents"
          ? { json: { agents: [retainedAgent] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });

    await page.goto("/agents");
    await expect(page.getByText(retainedAgent.name).first()).toBeVisible();
    await expect.poll(() => prewarmRequests).toBe(1);

    await notifySessionChange(page);
    await page.waitForTimeout(100);
    expect(prewarmRequests).toBe(1);
  });

  test("a lapsed authenticated session makes no protected console request", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/auth/session", (route) =>
      route.fulfill({
        json: {
          expires: "2099-01-01T00:00:00.000Z",
          user: {
            authVersion: 0,
            email: "lapsed@example.invalid",
            id: "00000000-0000-4000-8000-000000000003",
            image: null,
            name: "Lapsed subscriber",
            type: "demo",
          },
        },
      })
    );
    const protectedRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        pathname === "/api/agents" ||
        pathname === "/api/credentials" ||
        pathname === "/api/tenant/prewarm"
      ) {
        protectedRequests.push(pathname);
      }
    });

    await page.goto("/agents");

    await expect(page.getByText("no subscription")).toBeVisible();
    await page.waitForTimeout(100);
    expect(protectedRequests).toEqual([]);
  });

  test("an account switch aborts stale prewarm and starts one for the new tenant", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies("first@example.invalid"));
    let sessionOverride: Record<string, unknown> | undefined;
    await page.route("**/api/auth/session", (route) =>
      sessionOverride === undefined
        ? route.continue()
        : route.fulfill({ json: sessionOverride })
    );
    let prewarmRequests = 0;
    let firstPrewarmStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstPrewarmStarted = resolve;
    });
    let releaseFirst!: () => Promise<void>;
    await page.route("**/api/tenant/prewarm", (route) => {
      prewarmRequests += 1;
      if (prewarmRequests > 1) {
        return route.fulfill({ status: 204 });
      }
      firstPrewarmStarted();
      return new Promise<void>((resolve) => {
        releaseFirst = async () => {
          await route.fulfill({ status: 204 }).catch(() => undefined);
          resolve();
        };
      });
    });
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    let agentRequests = 0;
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        agentRequests += 1;
        return route.fulfill({
          json: {
            agents: [
              {
                ...retainedAgent,
                id: agentRequests === 1 ? AGENT_ID : OTHER_AGENT_ID,
                name:
                  agentRequests === 1
                    ? "First account agent"
                    : "Second account agent",
              },
            ],
          },
        });
      }
      return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
    });

    await page.goto("/agents");
    await started;
    const stalePrewarmAborted = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        new URL(request.url()).pathname === "/api/tenant/prewarm",
    });
    sessionOverride = {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        authVersion: 0,
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    await notifySessionChange(page);

    await stalePrewarmAborted;
    await expect.poll(() => prewarmRequests).toBe(2);
    await expect(page.getByText("Second account agent").first()).toBeVisible();
    await releaseFirst();
    await page.waitForTimeout(100);
    expect(prewarmRequests).toBe(2);
  });

  test("signed-out profile actions lead to sign-in instead of a doomed write flow", async ({
    page,
  }) => {
    await page.goto("/agents");
    await page.getByRole("button", { name: "New agent" }).click();
    await expect(page).toHaveURL("/login");

    await page.goto("/agents");
    await page.getByRole("button", { name: "Search or run a command" }).click();
    await page.getByRole("button", { name: "action Create an agent" }).click();
    await expect(page).toHaveURL("/login");
  });

  test("the command palette opens and closes from the keyboard", async ({
    page,
  }) => {
    await page.goto("/agents");
    await expect(
      page.getByRole("button", { name: "signed out" })
    ).toBeVisible();
    await page.keyboard.press("Meta+K");
    await expect(
      page.getByRole("dialog", { name: "Search runs, agents, and commands" })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "Search runs, agents, and commands" })
    ).not.toBeVisible();
  });

  test("signed-out settings show a sign-in gate instead of credential controls", async ({
    page,
  }) => {
    await page.goto("/agents");
    await page.getByRole("button", { name: "Account and settings" }).click();

    await expect(
      page.getByRole("heading", { name: "Sign in to manage your account" })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Sign in with GitHub" })
    ).toBeVisible();
    await expect(page.getByLabel("GitHub Copilot credential")).toHaveCount(0);
  });

  test("the console remains operable at a phone viewport", async ({ page }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto("/agents");

    await expect(page.getByLabel("Navigation, collapsed")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /Autonomous agents/ })
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);

    await page.getByRole("button", { name: "Expand the navigation" }).click();
    await expect(
      page.getByRole("button", { name: "Collapse the navigation" })
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  });

  test("a retained run exposes rich steps and the global collapse control", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    const applicationRequests: string[] = [];
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      applicationRequests.push(`${request.method()} ${pathname}`);
      if (pathname === "/api/agents") {
        expectCurrentBrowserRequestHeaders(request.headers(), request.url());
        return route.fulfill({ json: { agents: [retainedAgent] } });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return route.fulfill({
          json: { apiVersion: "1.0", runs: [retainedRun] },
        });
      }
      if (pathname === `/api/runs/${RUN_ID}/events`) {
        const event = {
          at: "2026-08-27T06:00:30.000Z",
          evidence: {
            command: "pnpm test",
            completedAt: "2026-08-27T06:00:30.000Z",
            exitCode: 0,
            startedAt: "2026-08-27T06:00:20.000Z",
            stderr: "",
            stdout: "first output line\nsecond output line",
          },
          id: 1,
          type: "command",
        };
        return route.fulfill({
          body: `data: ${JSON.stringify(event)}\n\n`,
          contentType: "text/event-stream",
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /completed Verify timeline/ })
      .click();

    await expect(page.getByText("second output line")).toBeVisible();
    await page.getByRole("button", { exact: true, name: "collapse" }).click();
    await expect(page.getByText("second output line")).toHaveCount(0);
    await expect(
      page.getByRole("button", { exact: true, name: "expand" })
    ).toBeVisible();
    expect(applicationRequests).toEqual([
      "GET /api/agents",
      `GET /api/agents/${AGENT_ID}/runs`,
      `GET /api/runs/${RUN_ID}/events`,
      `GET /api/runs/${RUN_ID}`,
    ]);
  });

  for (const scenario of [
    {
      agentStatus: "idle",
      event: {
        error: {
          code: "historical_failure",
          message: "Historical failure transcript.",
          retryable: false,
        },
        id: 1,
        type: "failed",
      },
      historicalStatus: "failed",
      transcript: "Historical failure transcript.",
    },
    {
      agentStatus: "error",
      event: {
        id: 1,
        run: historicalRun("completed"),
        type: "completed",
      },
      historicalStatus: "completed",
      transcript: "Historical completion output.",
    },
    {
      agentStatus: "running",
      event: {
        id: 1,
        status: "cancelled",
        type: "status",
      },
      historicalStatus: "cancelled",
      transcript: "Run cancelled",
    },
  ] as const) {
    test(`a historical ${scenario.historicalStatus} transcript does not overwrite a newer ${scenario.agentStatus} agent lifecycle`, async ({
      context,
      page,
    }) => {
      await context.addCookies(await subscriberCookies());
      await page.route("**/api/tenant/prewarm", (route) =>
        route.fulfill({ status: 204 })
      );
      await page.route("**/api/credentials", (route) =>
        route.fulfill({ json: { harnessIds: ["copilot"] } })
      );
      await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === "/api/agents") {
          return route.fulfill({
            json: {
              agents: [{ ...retainedAgent, status: scenario.agentStatus }],
            },
          });
        }
        if (pathname === `/api/agents/${AGENT_ID}/runs`) {
          return route.fulfill({
            json: {
              apiVersion: "1.0",
              runs: [historicalRun(scenario.historicalStatus)],
            },
          });
        }
        if (pathname === `/api/runs/${RUN_ID}/events`) {
          return route.fulfill({
            body: `data: ${JSON.stringify(scenario.event)}\n\n`,
            contentType: "text/event-stream",
          });
        }
        if (pathname === `/api/runs/${RUN_ID}`) {
          return route.fulfill({
            json: {
              apiVersion: "1.0",
              run: historicalRun(scenario.historicalStatus),
            },
          });
        }
        return route.fulfill({ json: {}, status: 404 });
      });

      await page.goto("/agents");
      await page
        .getByRole("complementary")
        .getByRole("button", {
          name: new RegExp(`${scenario.historicalStatus} Verify timeline`, "u"),
        })
        .click();

      await expect(page.getByText(scenario.transcript).first()).toBeVisible();
      await expect(
        page
          .getByRole("button", { name: retainedAgent.name })
          .getByRole("img", { name: scenario.agentStatus })
      ).toBeVisible();
    });
  }

  test("a direct cancelled stop leaves only the owning agent idle", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    const otherAgent = {
      ...retainedAgent,
      id: OTHER_AGENT_ID,
      name: "Other running agent",
      status: "running",
    };
    let releaseEvents!: () => Promise<void>;
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/agents") {
        return route.fulfill({
          json: {
            agents: [{ ...retainedAgent, status: "running" }, otherAgent],
          },
        });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return route.fulfill({
          json: { apiVersion: "1.0", runs: [liveRun()] },
        });
      }
      if (pathname === `/api/agents/${OTHER_AGENT_ID}/runs`) {
        return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
      }
      if (pathname === `/api/runs/${RUN_ID}/events`) {
        return new Promise<void>((resolve) => {
          releaseEvents = async () => {
            await route.fulfill({
              body: "",
              contentType: "text/event-stream",
            });
            resolve();
          };
        });
      }
      if (
        pathname === `/api/runs/${RUN_ID}/stop` &&
        request.method() === "POST"
      ) {
        return route.fulfill({
          json: { apiVersion: "1.0", run: liveRun("cancelled") },
        });
      }
      if (pathname === `/api/runs/${RUN_ID}`) {
        return route.fulfill({
          json: { apiVersion: "1.0", run: liveRun("cancelled") },
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");
    await page
      .getByRole("complementary")
      .getByRole("button", { name: /running Verify timeline/ })
      .click();
    await page.getByRole("button", { exact: true, name: "Stop" }).click();

    await expect(page.getByText("Run cancelled.")).toBeVisible();
    await expect(page.getByRole("img", { name: "idle" })).toBeVisible();
    await expect(page.getByRole("img", { name: "running" })).toBeVisible();
    await releaseEvents();
  });

  test("a completed live event leaves the owning agent idle", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        return route.fulfill({
          json: { agents: [{ ...retainedAgent, status: "running" }] },
        });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return route.fulfill({
          json: { apiVersion: "1.0", runs: [liveRun()] },
        });
      }
      if (pathname === `/api/runs/${RUN_ID}/events`) {
        return route.fulfill({
          body: `data: ${JSON.stringify({
            id: 1,
            run: liveRun("completed"),
            type: "completed",
          })}\n\n`,
          contentType: "text/event-stream",
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");

    await expect(
      page
        .getByRole("button", { name: retainedAgent.name })
        .getByRole("img", { name: "idle" })
    ).toBeVisible();
    await expect(
      page
        .getByRole("complementary")
        .getByRole("button", { name: /completed Verify timeline/ })
    ).toBeVisible();
  });

  test("a cancelled terminal snapshot recovery leaves the owning agent idle", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        return route.fulfill({
          json: { agents: [{ ...retainedAgent, status: "running" }] },
        });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return route.fulfill({
          json: { apiVersion: "1.0", runs: [liveRun()] },
        });
      }
      if (pathname === `/api/runs/${RUN_ID}/events`) {
        return route.fulfill({
          body: "",
          contentType: "text/event-stream",
        });
      }
      if (pathname === `/api/runs/${RUN_ID}`) {
        return route.fulfill({
          json: { apiVersion: "1.0", run: liveRun("cancelled") },
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");

    await expect(page.getByRole("img", { name: "idle" })).toBeVisible();
    await expect(page.getByRole("img", { name: "error" })).toHaveCount(0);
  });

  test("a failed terminal snapshot recovery leaves the owning agent in error", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        return route.fulfill({
          json: { agents: [{ ...retainedAgent, status: "running" }] },
        });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return route.fulfill({
          json: { apiVersion: "1.0", runs: [liveRun()] },
        });
      }
      if (pathname === `/api/runs/${RUN_ID}/events`) {
        return route.fulfill({
          body: "",
          contentType: "text/event-stream",
        });
      }
      if (pathname === `/api/runs/${RUN_ID}`) {
        return route.fulfill({
          json: { apiVersion: "1.0", run: liveRun("failed") },
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");

    await expect(page.getByRole("img", { name: "error" })).toBeVisible();
    await expect(page.getByRole("img", { name: "idle" })).toHaveCount(0);
  });

  test("a same-origin subscription refusal blocks runs without offering a manual connection", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route("**/api/agents", (route) =>
      route.fulfill({
        json: {
          apiVersion: "1.0",
          error: {
            code: "subscription_required",
            message: "An active subscription is required.",
            retryable: false,
          },
          requestId: "44444444-4444-4444-8444-444444444444",
        },
        status: 403,
      })
    );

    await page.goto("/agents");

    await expect(page.getByText("no subscription")).toBeVisible();
    await expect(
      page.getByText("An active subscription is required to run agents.")
    ).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Connect a runner" })
    ).toHaveCount(0);
  });

  test("credential writes immediately refresh run eligibility without trusting failures", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let harnessIds: string[] = [];
    let delayNextCredentialGet = false;
    let failNextCredentialGet = false;
    let mutationRequests = 0;
    let releaseCredentialGet: (() => Promise<void>) | undefined;
    await page.route("**/api/credentials", (route) => {
      const request = route.request();
      if (request.method() === "GET") {
        if (delayNextCredentialGet) {
          delayNextCredentialGet = false;
          const snapshot = [...harnessIds];
          return new Promise<void>((resolve) => {
            releaseCredentialGet = async () => {
              await route.fulfill({ json: { harnessIds: snapshot } });
              resolve();
            };
          });
        }
        if (failNextCredentialGet) {
          failNextCredentialGet = false;
          return route.fulfill({ json: { error: "unavailable" }, status: 503 });
        }
        return route.fulfill({ json: { harnessIds } });
      }
      const body = request.postDataJSON() as {
        credential?: string;
        harnessId?: string;
      };
      if (request.method() === "POST") {
        mutationRequests += 1;
        if (body.credential === "rejected-credential") {
          return route.fulfill({ json: { error: "failed" }, status: 500 });
        }
        harnessIds = [...new Set([...harnessIds, body.harnessId ?? ""])]
          .filter(Boolean)
          .sort();
        failNextCredentialGet = true;
        return route.fulfill({
          json: { harnessId: body.harnessId, stored: true },
        });
      }
      harnessIds = harnessIds.filter((id) => id !== body.harnessId);
      failNextCredentialGet = true;
      return route.fulfill({
        json: { harnessId: body.harnessId, removed: true },
      });
    });
    await page.route("**/api/usage", (route) =>
      route.fulfill({ json: { cap: 10, resetsAt: null, used: 0 } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        return route.fulfill({ json: { agents: [retainedAgent] } });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    const blocked =
      "No harness credential stored — add one in account settings.";
    await page.goto("/agents");
    await expect(page.getByText(blocked)).toBeVisible();

    await page.getByRole("button", { name: "Account and settings" }).click();
    await page
      .getByLabel("GitHub Copilot CLI credential")
      .fill("rejected-credential");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => mutationRequests).toBe(1);
    await expect(
      page.getByText("Could not store the credential.")
    ).toBeVisible();
    await page.getByRole("link", { name: "Back to runs" }).click();
    await expect(page.getByText(blocked)).toBeVisible();

    delayNextCredentialGet = true;
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page
      .getByLabel("GitHub Copilot CLI credential")
      .fill("accepted-token");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Credential stored.")).toBeVisible();
    await releaseCredentialGet?.();
    await page.getByRole("link", { name: "Back to runs" }).click();
    await expect(page.getByText(blocked)).toHaveCount(0);

    await page.getByRole("button", { name: "Account and settings" }).click();
    const remove = page.getByRole("button", { name: "Remove" });
    await expect(remove).toBeVisible();
    delayNextCredentialGet = true;
    await remove.click();
    await expect(remove).toHaveCount(0);
    await releaseCredentialGet?.();
    await expect(page.getByText("Credential removed.")).toBeVisible();
    await page.getByRole("link", { name: "Back to runs" }).click();
    await expect(page.getByText(blocked)).toBeVisible();
  });

  test("a delayed authenticated agent response cannot restore state after sign-out", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let sessionOverride: Record<string, unknown> | null | undefined;
    await page.route("**/api/auth/session", (route) =>
      sessionOverride === undefined
        ? route.continue()
        : route.fulfill({ json: sessionOverride })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    let releaseAgents!: () => Promise<void>;
    let agentRequestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      agentRequestStarted = resolve;
    });
    let eventRequests = 0;
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        agentRequestStarted();
        return new Promise<void>((resolve) => {
          releaseAgents = async () => {
            await route.fulfill({ json: { agents: [retainedAgent] } });
            resolve();
          };
        });
      }
      if (pathname.endsWith("/events")) {
        eventRequests += 1;
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");
    await started;
    await expect(page.getByTitle("e2e-user@example.invalid")).toBeVisible();
    sessionOverride = null;
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      return (await response.json()) === null;
    });
    await notifySessionChange(page);
    await sessionRefresh;
    await expect(
      page.getByRole("button", { name: "signed out" })
    ).toBeVisible();

    await releaseAgents();
    await expect(page.getByText(retainedAgent.name)).toHaveCount(0);
    expect(eventRequests).toBe(0);
  });

  test("a delayed run response cannot start a stale stream after an account switch", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies("first@example.invalid"));
    let sessionOverride: Record<string, unknown> | undefined;
    await page.route("**/api/auth/session", (route) =>
      sessionOverride === undefined
        ? route.continue()
        : route.fulfill({ json: sessionOverride })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    const nextAgent = {
      ...retainedAgent,
      id: OTHER_AGENT_ID,
      name: "New account agent",
    };
    const staleLiveRun = {
      ...retainedRun,
      agentId: AGENT_ID,
      completedAt: null,
      id: OTHER_RUN_ID,
      output: "",
      status: "running",
      task: "Stale account run",
    };
    let releaseRuns!: () => Promise<void>;
    let runRequestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runRequestStarted = resolve;
    });
    let agentRequests = 0;
    let eventRequests = 0;
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        agentRequests += 1;
        return route.fulfill({
          json: { agents: agentRequests === 1 ? [retainedAgent] : [nextAgent] },
        });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        runRequestStarted();
        return new Promise<void>((resolve) => {
          releaseRuns = async () => {
            await route.fulfill({
              json: { apiVersion: "1.0", runs: [staleLiveRun] },
            });
            resolve();
          };
        });
      }
      if (pathname === `/api/agents/${OTHER_AGENT_ID}/runs`) {
        return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
      }
      if (pathname.endsWith("/events")) {
        eventRequests += 1;
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");
    await started;
    await expect(page.getByTitle("first@example.invalid")).toBeVisible();
    sessionOverride = {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { email?: string } };
      return body.user?.email === "second@example.invalid";
    });
    await notifySessionChange(page);
    await sessionRefresh;
    await expect(page.getByText(nextAgent.name).first()).toBeVisible();

    await releaseRuns();
    await page.waitForTimeout(100);
    await expect(page.getByText("Stale account run")).toHaveCount(0);
    expect(eventRequests).toBe(0);
  });

  test("a delayed mutation cannot publish success after an account switch", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies("first@example.invalid"));
    let sessionOverride: Record<string, unknown> | undefined;
    await page.route("**/api/auth/session", (route) =>
      sessionOverride === undefined
        ? route.continue()
        : route.fulfill({ json: sessionOverride })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    const nextAgent = {
      ...retainedAgent,
      id: OTHER_AGENT_ID,
      name: "New account agent",
    };
    let agentRequests = 0;
    let releaseMutation!: () => Promise<void>;
    let mutationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/api/agents") {
        agentRequests += 1;
        return route.fulfill({
          json: { agents: agentRequests === 1 ? [retainedAgent] : [nextAgent] },
        });
      }
      if (
        pathname === `/api/agents/${AGENT_ID}` &&
        request.method() === "PUT"
      ) {
        expect(request.headers().origin).toBe(new URL(request.url()).origin);
        expect(request.headers()["content-type"]).toContain("application/json");
        mutationStarted();
        return new Promise<void>((resolve) => {
          releaseMutation = async () => {
            await route.fulfill({
              json: {
                agent: { ...retainedAgent, name: "Stale renamed agent" },
              },
            });
            resolve();
          };
        });
      }
      if (
        pathname === `/api/agents/${AGENT_ID}/runs` ||
        pathname === `/api/agents/${OTHER_AGENT_ID}/runs`
      ) {
        return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");
    await expect(page.getByText(retainedAgent.name).first()).toBeVisible();
    const mutationAborted = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        request.method() === "PUT" &&
        new URL(request.url()).pathname === `/api/agents/${AGENT_ID}`,
    });
    await page.getByRole("button", { name: "More run actions" }).click();
    await page.getByRole("menuitem", { name: "Rename this agent" }).click();
    await page.getByLabel("Agent name").fill("Stale renamed agent");
    await page.getByRole("button", { name: "Save" }).click();
    await started;

    sessionOverride = {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { email?: string } };
      return body.user?.email === "second@example.invalid";
    });
    await notifySessionChange(page);
    await sessionRefresh;
    await mutationAborted;
    await expect(page.getByText(nextAgent.name).first()).toBeVisible();

    await releaseMutation();
    await page.waitForTimeout(100);
    await expect(page.getByText("Stale renamed agent")).toHaveCount(0);
    await expect(page.getByText("Renamed to Stale renamed agent.")).toHaveCount(
      0
    );
  });

  test("delayed settings list and save cannot publish after an account switch", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies("first@example.invalid"));
    let sessionOverride: Record<string, unknown> | undefined;
    await page.route("**/api/auth/session", (route) =>
      sessionOverride === undefined
        ? route.continue()
        : route.fulfill({ json: sessionOverride })
    );
    let delayNextList = false;
    let releaseList!: () => Promise<void>;
    let releaseSave!: () => Promise<void>;
    let saveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });
    await page.route("**/api/credentials", (route) => {
      if (route.request().method() === "GET") {
        if (!delayNextList) {
          return route.fulfill({ json: { harnessIds: [] } });
        }
        delayNextList = false;
        return new Promise<void>((resolve) => {
          releaseList = () => {
            route
              .fulfill({ json: { harnessIds: ["copilot"] } })
              .catch(() => undefined);
            resolve();
            return Promise.resolve();
          };
        });
      }
      saveStarted();
      return new Promise<void>((resolve) => {
        releaseSave = () => {
          route
            .fulfill({ json: { harnessId: "copilot", stored: true } })
            .catch(() => undefined);
          resolve();
          return Promise.resolve();
        };
      });
    });
    let agentRequests = 0;
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        agentRequests += 1;
        return route.fulfill({
          json: {
            agents:
              agentRequests === 1
                ? [retainedAgent]
                : [{ ...retainedAgent, id: OTHER_AGENT_ID }],
          },
        });
      }
      return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
    });

    await page.goto("/agents");
    await expect(page.getByTitle("first@example.invalid")).toBeVisible();
    delayNextList = true;
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page
      .getByLabel("GitHub Copilot CLI credential")
      .fill("old-account-token");
    await expect(page.getByText("Unsaved credential")).toBeVisible();
    await page.getByRole("button", { name: "Save" }).click();
    await started;

    sessionOverride = {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { email?: string } };
      return body.user?.email === "second@example.invalid";
    });
    await notifySessionChange(page);
    await sessionRefresh;
    await expect(page.getByTitle("second@example.invalid")).toBeVisible();
    await releaseList();
    await releaseSave();
    await page.waitForTimeout(100);
    await expect(page.getByLabel("GitHub Copilot CLI credential")).toHaveValue(
      ""
    );
    await expect(page.getByText("No unsaved changes")).toBeVisible();
    await expect(page.getByText("not set").first()).toBeVisible();
    await expect(page.getByText("Credential stored.")).toHaveCount(0);
  });

  test("a delayed settings delete cannot publish after sign-out", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let sessionOverride: Record<string, unknown> | null | undefined;
    await page.route("**/api/auth/session", (route) =>
      sessionOverride === undefined
        ? route.continue()
        : route.fulfill({ json: sessionOverride })
    );
    let releaseDelete!: () => Promise<void>;
    let deleteStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      deleteStarted = resolve;
    });
    await page.route("**/api/credentials", (route) => {
      if (route.request().method() === "GET") {
        return route.fulfill({ json: { harnessIds: ["copilot"] } });
      }
      deleteStarted();
      return new Promise<void>((resolve) => {
        releaseDelete = () => {
          route
            .fulfill({ json: { harnessId: "copilot", removed: true } })
            .catch(() => undefined);
          resolve();
          return Promise.resolve();
        };
      });
    });
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/api/agents"
          ? { json: { agents: [retainedAgent] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });

    await page.goto("/agents");
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page.getByRole("button", { name: "Remove" }).click();
    await started;

    sessionOverride = null;
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      return (await response.json()) === null;
    });
    await notifySessionChange(page);
    await sessionRefresh;
    await expect(
      page.getByRole("heading", { name: "Sign in to manage your account" })
    ).toBeVisible();

    await releaseDelete();
    await page.waitForTimeout(100);
    await expect(page.getByText("Credential removed.")).toHaveCount(0);
    await expect(
      page.getByText("Could not remove the credential.")
    ).toHaveCount(0);
  });

  test("a delayed chat wipe cannot publish after an account switch", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies("first@example.invalid"));
    let sessionOverride: Record<string, unknown> | undefined;
    await page.route("**/api/auth/session", (route) =>
      sessionOverride === undefined
        ? route.continue()
        : route.fulfill({ json: sessionOverride })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: [] } })
    );
    let releaseWipe!: () => Promise<void>;
    let wipeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      wipeStarted = resolve;
    });
    await page.route("**/api/history", (route) => {
      wipeStarted();
      return new Promise<void>((resolve) => {
        releaseWipe = () => {
          route.fulfill({ json: { ok: true } }).catch(() => undefined);
          resolve();
          return Promise.resolve();
        };
      });
    });
    let agentRequests = 0;
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        agentRequests += 1;
        return route.fulfill({
          json: {
            agents:
              agentRequests === 1
                ? [retainedAgent]
                : [{ ...retainedAgent, id: OTHER_AGENT_ID }],
          },
        });
      }
      return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
    });

    await page.goto("/agents");
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page.getByRole("button", { name: "Data" }).click();
    await page.getByRole("button", { name: "Delete all chats…" }).click();
    await page.getByRole("button", { name: "Yes, delete every chat" }).click();
    await started;

    sessionOverride = {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { email?: string } };
      return body.user?.email === "second@example.invalid";
    });
    await notifySessionChange(page);
    await sessionRefresh;
    await expect(page.getByTitle("second@example.invalid")).toBeVisible();

    await releaseWipe();
    await page.waitForTimeout(100);
    await expect(page.getByText("All chats deleted.")).toHaveCount(0);
    await expect(page.getByText("Could not delete your chats.")).toHaveCount(0);
    await expect(page.getByText("No unsaved changes")).toBeVisible();
  });
});
