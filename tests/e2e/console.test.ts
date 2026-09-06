import {
  type BrowserContext,
  expect,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { TEMPLATES } from "@/lib/agents/formations";
import { executionProfileForTemplate } from "@/lib/console/agent-profile";
import { sessionCookies, subscriberCookies } from "./session";

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

async function subscriberSessionSetCookie(
  email: string,
  id: string,
  authVersion = 1
): Promise<string> {
  const [cookie] = await sessionCookies("subscriber", {
    authVersion,
    email,
    id,
  });
  if (!cookie) {
    throw new Error("Subscriber session cookie was not created.");
  }
  return `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax`;
}

function fulfillSessionOverride(
  route: Route,
  sessionOverride: Record<string, unknown> | undefined,
  setCookie: string | undefined
) {
  return sessionOverride === undefined
    ? route.continue()
    : route.fulfill({
        headers: setCookie ? { "set-cookie": setCookie } : undefined,
        json: sessionOverride,
      });
}

async function openAuthenticatedProfileCreator(
  context: BrowserContext,
  page: Page
): Promise<void> {
  await context.addCookies(await subscriberCookies());
  await page.route("**/api/tenant/prewarm", (route) =>
    route.fulfill({ status: 204 })
  );
  await page.route("**/api/credentials", (route) =>
    route.fulfill({ json: { harnessIds: ["copilot"] } })
  );
  await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
    const { pathname } = new URL(route.request().url());
    return route.fulfill(
      pathname === "/api/agents"
        ? { json: { agents: [] } }
        : { json: { apiVersion: "1.0", runs: [] } }
    );
  });

  await page.goto("/agents");
  await expect(page.getByText("e2e-user@example.invalid")).toBeVisible();
  await page.getByRole("button", { name: "New agent" }).click();
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

  test("the selected agent offers role-specific quick chats", async ({
    context,
    page,
  }) => {
    const scoutAgent = {
      ...retainedAgent,
      description: "Surveys the workspace and reports. Changes nothing.",
      instructions:
        TEMPLATES.find((template) => template.id === "scout")?.instructions ??
        retainedAgent.instructions,
      name: "Scout",
    };
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/api/agents"
          ? { json: { agents: [scoutAgent] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });

    await page.goto("/agents");

    const quickChats = page.getByRole("region", {
      name: "Quick chats for Scout",
    });
    await expect(quickChats).toBeVisible();
    const recommendation =
      "Map the repository architecture and identify the three riskiest boundaries.";
    await quickChats.getByRole("button", { name: recommendation }).click();
    await expect(page.getByLabel("Proof brief")).toHaveValue(recommendation);
    await expect(
      page.getByRole("button", { name: "Run autonomously" })
    ).toBeEnabled();
  });

  test("every built-in profile can be selected and dispatches its own run", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    const roleAgents = TEMPLATES.map((template, index) => ({
      ...retainedAgent,
      description: template.blurb,
      id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      instructions: template.instructions,
      name: template.name,
    }));
    const startedAgentIds: string[] = [];

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
        return route.fulfill({ json: { agents: roleAgents } });
      }
      const runStart = pathname.match(/^\/api\/agents\/([^/]+)\/runs$/u);
      if (runStart && request.method() === "POST") {
        const agentId = runStart[1] ?? "";
        startedAgentIds.push(agentId);
        return route.fulfill({
          json: {
            run: {
              ...retainedRun,
              completedAt: "2026-08-27T06:01:00.000Z",
              id: `20000000-0000-4000-8000-${String(startedAgentIds.length).padStart(12, "0")}`,
              operationId: `30000000-0000-4000-8000-${String(startedAgentIds.length).padStart(12, "0")}`,
              status: "completed",
            },
          },
          status: 202,
        });
      }
      if (pathname.includes("/runs")) {
        return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");

    const selectAndRun = async (index = 0): Promise<void> => {
      const template = TEMPLATES[index];
      if (!template) {
        return;
      }
      const profile = executionProfileForTemplate(template);
      await page
        .getByRole("button", { name: "Choose execution profile" })
        .click();
      const selector = page.getByRole("dialog", {
        name: "Choose execution profile",
      });
      await expect(selector).toHaveAttribute("aria-modal", "true");
      await expect(
        selector.locator(`[data-profile-id="${template.id}"] img`)
      ).toBeVisible();
      await selector
        .getByRole("button", {
          name: new RegExp(`${template.name}.*${profile.mode}`, "u"),
        })
        .click();

      await expect(
        page.getByRole("heading", {
          name: `What should ${template.name} prove?`,
        })
      ).toBeVisible();
      await expect(page.getByText(profile.composerGuidance)).toBeVisible();
      const quickChats = page.getByRole("region", {
        name: `Quick chats for ${template.name}`,
      });
      await quickChats
        .getByRole("button", { name: profile.prompts[0] })
        .click();
      await page.getByRole("button", { name: "Run autonomously" }).click();
      await expect.poll(() => startedAgentIds.length).toBe(index + 1);
      expect(startedAgentIds.at(-1)).toBe(roleAgents[index]?.id);
      await selectAndRun(index + 1);
    };

    await selectAndRun();
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
    let sessionSetCookie: string | undefined;
    await page.route("**/api/auth/session", (route) =>
      fulfillSessionOverride(route, sessionOverride, sessionSetCookie)
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
    sessionSetCookie = await subscriberSessionSetCookie(
      "second@example.invalid",
      "00000000-0000-4000-8000-000000000002",
      0
    );
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { email?: string } };
      return body.user?.email === "second@example.invalid";
    });
    await notifySessionChange(page);
    await sessionRefresh;

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
    await expect(page).toHaveURL("/login?callbackUrl=%2Fagents");

    await page.goto("/agents");
    await page.getByRole("button", { name: "Search or run a command" }).click();
    await page.getByRole("button", { name: "action Create an agent" }).click();
    await expect(page).toHaveURL("/login?callbackUrl=%2Fagents");
  });

  test("profile creation opens with three parallel paths instead of numbered steps", async ({
    context,
    page,
  }) => {
    await openAuthenticatedProfileCreator(context, page);

    await expect(
      page.getByRole("heading", { name: "Choose how to begin" })
    ).toBeVisible();
    const paths = page.getByRole("group", {
      name: "Execution profile paths",
    });
    await expect(paths.getByRole("button")).toHaveCount(3);
    await expect(
      paths.getByRole("button", { name: /Start from a role/ })
    ).toContainText("1 profile · ~5 seconds");
    await expect(
      paths.getByRole("button", { name: /Create a crew/ })
    ).toContainText("2–3 profiles · one action");
    await expect(
      paths.getByRole("button", { name: /Forge a profile/ })
    ).toContainText("1 profile · full control");
    await expect(
      page.getByRole("heading", { name: "Start from a role" })
    ).toHaveCount(0);
    await expect(paths).not.toContainText(/(^|\s)[123](\s|$)/);

    await paths.getByRole("button", { name: /Start from a role/ }).click();
    await expect(page.getByText("How read-only is enforced")).toBeVisible();
    await Promise.all(
      TEMPLATES.map((template) => {
        const profile = executionProfileForTemplate(template);
        return expect(
          page.getByRole("button", {
            name: new RegExp(
              `Create ${template.name}.*${profile.mode}.*${profile.outcome}`,
              "u"
            ),
          })
        ).toBeVisible();
      })
    );
    await page.getByRole("button", { name: "All paths" }).click();
    await paths.getByRole("button", { name: /Create a crew/ }).click();
    await expect(page.getByText("Proposed: sequenced mode")).toBeVisible();
  });

  test("returning to all paths preserves the Forge draft and restores focus", async ({
    context,
    page,
  }) => {
    await openAuthenticatedProfileCreator(context, page);

    const forgePath = page.getByRole("button", { name: /Forge a profile/ });
    await forgePath.click();
    await expect(
      page.getByRole("heading", { name: "Forge a profile" })
    ).toBeFocused();
    await page.getByLabel("Name", { exact: true }).fill("Release steward");
    await page
      .getByLabel("Operating contract")
      .fill("Review the release evidence and report concrete blockers.");

    await page.getByRole("button", { name: "All paths" }).click();
    await expect(forgePath).toBeFocused();
    await forgePath.click();

    await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
      "Release steward"
    );
    await expect(page.getByLabel("Operating contract")).toHaveValue(
      "Review the release evidence and report concrete blockers."
    );
  });

  test("profile paths share a row on wide screens and stack without overflow on narrow screens", async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ height: 800, width: 1200 });
    await openAuthenticatedProfileCreator(context, page);

    const cards = page.locator(".oc-create-path-card");
    const wideBoxes = await cards.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { height: Math.round(box.height), top: Math.round(box.top) };
      })
    );
    expect(new Set(wideBoxes.map((box) => box.top)).size).toBe(1);
    expect(new Set(wideBoxes.map((box) => box.height)).size).toBe(1);

    await page.setViewportSize({ height: 844, width: 700 });
    const narrowTops = await cards.evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().top))
    );
    expect(new Set(narrowTops).size).toBe(3);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
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
    const billingRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === "/api/subscription" || pathname === "/api/checkout") {
        billingRequests.push(pathname);
      }
    });

    await page.goto("/agents");
    await expect(
      page
        .locator(".oc-console-header")
        .getByRole("button", { name: "Account and settings" })
    ).toHaveCount(0);
    await expect(
      page
        .locator(".oc-agent-rail")
        .getByRole("button", { name: "Account and settings" })
    ).toHaveCount(1);
    await page.getByRole("button", { name: "Account and settings" }).click();

    await expect(
      page.getByRole("heading", { name: "Sign in to manage your account" })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Sign in with GitHub" })
    ).toBeVisible();
    await expect(page.getByLabel("GitHub Copilot credential")).toHaveCount(0);
    expect(billingRequests).toEqual([]);
  });

  test("the navigation rail groups and filters profile conversations", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    const profiles = [
      {
        ...retainedAgent,
        description: "Audits evidence and verifies delivery timelines.",
        status: "running",
      },
      {
        ...retainedAgent,
        description: "Finds source material before a run begins.",
        id: OTHER_AGENT_ID,
        name: "Research scout",
      },
      {
        ...retainedAgent,
        description: "Needs a credential before it can continue.",
        id: "77777777-7777-4777-8777-777777777777",
        name: "Blocked verifier",
        status: "error",
      },
    ];

    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        return route.fulfill({ json: { agents: profiles } });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return route.fulfill({
          json: { apiVersion: "1.0", runs: [retainedRun] },
        });
      }
      if (pathname.includes("/runs")) {
        return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");

    const navigation = page.getByRole("complementary", { name: "Navigation" });
    await expect(
      navigation.getByRole("searchbox", { name: "Search profiles and runs" })
    ).toBeVisible();
    await expect(navigation.getByText("Active", { exact: true })).toBeVisible();
    await expect(
      navigation.getByText("Profiles", { exact: true })
    ).toBeVisible();
    await expect(
      navigation.getByText("Needs attention", { exact: true })
    ).toBeVisible();
    await expect(
      navigation
        .getByRole("button", { name: "Timeline auditor" })
        .locator(".oc-agent-conversation__preview")
    ).toBeVisible();
    await expect(
      navigation.getByRole("button", { name: "Timeline auditor" })
    ).toHaveAccessibleName(
      "Timeline auditor, Verify timeline output, copilot, running"
    );
    await expect(
      navigation.getByRole("button", { name: "New agent" })
    ).toBeVisible();

    await navigation
      .getByRole("searchbox", { name: "Search profiles and runs" })
      .fill("source material");

    await expect(
      navigation.getByRole("button", { name: "Research scout" })
    ).toBeVisible();
    await expect(
      navigation.getByRole("button", { name: "Timeline auditor" })
    ).toHaveCount(0);
    await expect(
      navigation.getByRole("button", { name: "Blocked verifier" })
    ).toHaveCount(0);
  });

  test("run-backed rail search stays pending until histories resolve", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let releaseHistory!: () => Promise<void>;

    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        return route.fulfill({ json: { agents: [retainedAgent] } });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return new Promise<void>((resolve) => {
          releaseHistory = async () => {
            await route.fulfill({
              json: { apiVersion: "1.0", runs: [retainedRun] },
            });
            resolve();
          };
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");

    const navigation = page.getByRole("complementary", { name: "Navigation" });
    await navigation
      .getByRole("searchbox", { name: "Search profiles and runs" })
      .fill(retainedRun.task);
    await expect(navigation.getByText("Searching run history…")).toBeVisible();

    await releaseHistory();

    await expect(
      navigation.getByRole("button", { name: retainedAgent.name })
    ).toBeVisible();
    await expect(navigation.getByText("Searching run history…")).toHaveCount(0);
  });

  test("a newer profile reload owns the rail history loading state", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let historyRequests = 0;
    let releaseFirstHistory!: () => Promise<void>;
    let releaseSecondHistory!: () => Promise<void>;

    await page.route("**/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route("**/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: ["copilot"] } })
    );
    await page.route(/\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
        return route.fulfill({ json: { agents: [retainedAgent] } });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        historyRequests += 1;
        return new Promise<void>((resolve) => {
          const release = async (runs: (typeof retainedRun)[]) => {
            await route.fulfill({ json: { apiVersion: "1.0", runs } });
            resolve();
          };
          if (historyRequests === 1) {
            releaseFirstHistory = () => release([]);
          } else {
            releaseSecondHistory = () => release([retainedRun]);
          }
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");

    const navigation = page.getByRole("complementary", { name: "Navigation" });
    await navigation
      .getByRole("searchbox", { name: "Search profiles and runs" })
      .fill(retainedRun.task);
    await page.getByRole("button", { name: "More run actions" }).click();
    await page.getByRole("menuitem", { name: "Reload profiles" }).click();
    await expect.poll(() => historyRequests).toBe(2);

    await releaseFirstHistory();
    await expect(navigation.getByText("Searching run history…")).toBeVisible();

    await releaseSecondHistory();
    await expect(
      navigation.getByRole("button", { name: retainedAgent.name })
    ).toBeVisible();
    await expect(navigation.getByText("Searching run history…")).toHaveCount(0);
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
    const navigationRail = page.locator(".oc-agent-rail");
    await expect(navigationRail).toHaveCSS("position", "absolute");
    const resizeHandle = page.getByRole("separator", {
      name: "Resize the navigation rail",
    });
    await resizeHandle.press("End");
    const renderedWidth = await navigationRail.evaluate((element) =>
      Math.round(element.getBoundingClientRect().width)
    );
    await expect(resizeHandle).toHaveAttribute(
      "aria-valuenow",
      String(renderedWidth)
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  });

  test("collapsed profile controls include runtime and status context", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    const duplicateAgent = {
      ...retainedAgent,
      id: OTHER_AGENT_ID,
    };
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
          json: { agents: [retainedAgent, duplicateAgent] },
        });
      }
      if (pathname.includes("/runs")) {
        return route.fulfill({ json: { apiVersion: "1.0", runs: [] } });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.setViewportSize({ height: 844, width: 390 });
    await page.goto("/agents");

    const collapsed = page.getByLabel("Navigation, collapsed");
    await expect(
      collapsed.getByRole("button", {
        name: "Timeline auditor, copilot, idle, profile 1 of 2",
      })
    ).toBeVisible();
    await expect(
      collapsed.getByRole("button", {
        name: "Timeline auditor, copilot, idle, profile 2 of 2",
      })
    ).toBeVisible();
  });

  test("the empty console stacks before it crowds and scrolls in short landscapes", async ({
    page,
  }) => {
    await page.setViewportSize({ height: 600, width: 721 });
    await page.goto("/agents");

    const copy = page.locator(".oc-empty-console-copy");
    const boundary = page.locator(".oc-empty-console-boundary");
    const [copyBox, boundaryBox] = await Promise.all([
      copy.boundingBox(),
      boundary.boundingBox(),
    ]);
    expect(copyBox).not.toBeNull();
    expect(boundaryBox).not.toBeNull();
    expect(boundaryBox?.y ?? 0).toBeGreaterThanOrEqual(
      (copyBox?.y ?? 0) + (copyBox?.height ?? 0) - 1
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);

    await page.setViewportSize({ height: 375, width: 667 });
    const emptyConsole = page.locator(".oc-empty-console");
    await expect(emptyConsole).toHaveCSS("overflow-y", "auto");
    await expect
      .poll(() =>
        emptyConsole.evaluate(
          (element) => element.scrollHeight > element.clientHeight
        )
      )
      .toBe(true);
    await emptyConsole.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(boundary).toBeInViewport();
  });

  test("a retained run exposes resizable rich side rails and the global collapse control", async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ height: 720, width: 1024 });
    const markdownRun = {
      ...retainedRun,
      output:
        "## Verification\n\n**Timeline verified.**\n\n```bash\n# install dependencies\npnpm install\n```\n\n- Events stayed ordered\n- Evidence stayed bounded",
    };
    const retainedRuns = Array.from({ length: 20 }, (_, index) =>
      index === 0
        ? markdownRun
        : index === 1
          ? {
              ...retainedRun,
              completedAt: "2026-08-27T06:01:31.000Z",
              id: "22222222-2222-4222-8222-000000000002",
              operationId: "33333333-3333-4333-8333-000000000002",
              output: "4",
              task: "Answer 2+2 and nothing else",
            }
          : {
              ...retainedRun,
              id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
              operationId: `33333333-3333-4333-8333-${String(index + 1).padStart(12, "0")}`,
              task: `Retained proof ${String(index + 1).padStart(2, "0")}`,
            }
    );
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
          json: { apiVersion: "1.0", runs: retainedRuns },
        });
      }
      if (pathname === `/api/runs/${RUN_ID}/events`) {
        const outputEvent = {
          at: "2026-08-27T06:00:10.000Z",
          id: 1,
          output: markdownRun.output,
          type: "output",
        };
        const commandEvent = {
          at: "2026-08-27T06:00:30.000Z",
          evidence: {
            command: "pnpm test",
            completedAt: "2026-08-27T06:00:30.000Z",
            exitCode: 0,
            startedAt: "2026-08-27T06:00:20.000Z",
            stderr: "",
            stdout: "first output line\nsecond output line",
          },
          id: 2,
          type: "command",
        };
        return route.fulfill({
          body: `data: ${JSON.stringify(outputEvent)}\n\ndata: ${JSON.stringify(commandEvent)}\n\n`,
          contentType: "text/event-stream",
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");
    const composerGrid = page.locator(".oc-composer-grid");
    const composerFootnote = page.locator(".oc-composer-footnote");
    const [composerGridBox, composerFootnoteBox] = await Promise.all([
      composerGrid.boundingBox(),
      composerFootnote.boundingBox(),
    ]);
    expect(composerGridBox).not.toBeNull();
    expect(composerFootnoteBox).not.toBeNull();
    expect(
      (composerFootnoteBox?.y ?? 0) + (composerFootnoteBox?.height ?? 0)
    ).toBeLessThanOrEqual(
      (composerGridBox?.y ?? 0) + (composerGridBox?.height ?? 0)
    );

    const sessionList = page.locator(".oc-session-list");
    await expect
      .poll(() =>
        sessionList.evaluate(
          (element) => element.scrollHeight > element.clientHeight
        )
      )
      .toBe(true);

    const missionGuidance = page.getByText("12 more characters", {
      exact: true,
    });
    const [guidanceColor, mutedColor] = await missionGuidance.evaluate(
      (element) => {
        const consoleRoot = element.closest(".oc-console");
        if (!consoleRoot) {
          throw new Error("Console root not found");
        }
        const expected = document.createElement("span");
        expected.style.color = "var(--text-muted)";
        consoleRoot.append(expected);
        const colors = [
          getComputedStyle(element).color,
          getComputedStyle(expected).color,
        ];
        expected.remove();
        return colors;
      }
    );
    expect(guidanceColor).toBe(mutedColor);

    const retainedRunButton = page
      .getByRole("complementary", { name: "Runs in this session" })
      .getByRole("button", {
        name: /^01 completed Verify timeline/,
      });
    await retainedRunButton.click();
    const runRecord = page.getByRole("log", { name: "Run record" });
    await expect(
      runRecord.getByRole("heading", { level: 3, name: "Agent output" })
    ).toBeVisible();
    await expect(
      runRecord.getByRole("heading", { level: 3, name: "Command finished" })
    ).toBeVisible();
    await expect(
      runRecord.getByRole("heading", { level: 3, name: "Run completed" })
    ).toBeVisible();
    await expect(runRecord.locator(".oc-run-event-card")).toHaveCount(3);

    const navigationRail = page.locator(".oc-agent-rail");
    const navigationWidth = await navigationRail.evaluate(
      (element) => element.getBoundingClientRect().width
    );
    const navigationResizeHandle = page.getByRole("separator", {
      name: "Resize the navigation rail",
    });
    const navigationHandleBox = await navigationResizeHandle.boundingBox();
    expect(navigationHandleBox).not.toBeNull();
    await page.mouse.move(
      (navigationHandleBox?.x ?? 0) + (navigationHandleBox?.width ?? 0) / 2,
      (navigationHandleBox?.y ?? 0) + 20
    );
    await page.mouse.down();
    await page.mouse.move(
      (navigationHandleBox?.x ?? 0) +
        (navigationHandleBox?.width ?? 0) / 2 +
        32,
      (navigationHandleBox?.y ?? 0) + 20
    );
    await page.mouse.up();
    await expect
      .poll(() =>
        navigationRail.evaluate(
          (element) => element.getBoundingClientRect().width
        )
      )
      .toBeGreaterThan(navigationWidth);

    const stepsResizeHandle = page.getByRole("separator", {
      name: "Resize the steps panel",
    });
    const stepsRail = stepsResizeHandle.locator("..");
    const stepsWidth = await stepsRail.evaluate(
      (element) => element.getBoundingClientRect().width
    );
    await stepsResizeHandle.press("ArrowLeft");
    await expect
      .poll(() =>
        stepsRail.evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThan(stepsWidth);
    await navigationResizeHandle.press("End");
    await stepsResizeHandle.press("End");
    await expect
      .poll(() =>
        page
          .locator(".oc-console-main-pane")
          .evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThanOrEqual(359);

    await expect(stepsRail).not.toContainText("second output line");
    await expect(
      stepsRail.getByRole("button", { name: /Standard output: 2 lines/u })
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Verification" }).first()
    ).toBeVisible();
    const evidenceReport = page.locator(".oc-evidence-report");
    await expect(evidenceReport).toBeVisible();
    const [reportBackground, deskBackground] = await evidenceReport.evaluate(
      (element) => {
        const consoleRoot = element.closest(".oc-console");
        if (!consoleRoot) {
          throw new Error("Console root not found");
        }
        const expected = document.createElement("span");
        expected.style.background = "var(--bg-desk)";
        consoleRoot.append(expected);
        const colors = [
          getComputedStyle(element).backgroundColor,
          getComputedStyle(expected).backgroundColor,
        ];
        expected.remove();
        return colors;
      }
    );
    expect(reportBackground).toBe(deskBackground);
    await expect(evidenceReport.locator(".oc-markdown-report")).toBeVisible();
    await expect(
      evidenceReport.getByRole("heading", {
        level: 2,
        name: "Verification",
      })
    ).toHaveCSS("font-family", /EB Garamond/);
    await expect
      .poll(() =>
        evidenceReport
          .getByRole("heading", { level: 2, name: "Verification" })
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).fontSize)
          )
      )
      .toBeGreaterThan(27);
    await expect(
      page
        .locator(".oc-markdown strong", { hasText: "Timeline verified." })
        .first()
    ).toBeVisible();
    await expect(page.getByText("Events stayed ordered").first()).toBeVisible();
    await expect(stepsRail).not.toContainText("## Verification");
    await expect(stepsRail).not.toContainText("**Timeline verified.**");
    const reportStep = stepsRail.getByRole("button", {
      name: /Reported Markdown report/u,
    });
    await expect(reportStep).toContainText("8 lines");
    await reportStep.click();
    const reportReader = page.getByRole("dialog", {
      name: "Verify timeline output",
    });
    await expect(reportReader).toBeVisible();
    await expect(
      reportReader.getByRole("navigation", { name: "Report sections" })
    ).toBeVisible();
    await expect(
      reportReader.getByRole("button", { name: "01 Verification" })
    ).toBeVisible();
    await expect(
      reportReader.getByRole("button", { name: /02 install dependencies/iu })
    ).toHaveCount(0);
    await expect(
      reportReader.getByText("# install dependencies")
    ).toBeVisible();
    await expect(
      reportReader.getByRole("heading", { level: 2, name: "Verification" })
    ).toBeVisible();
    await page.keyboard.press("Meta+K");
    await expect(
      page.getByRole("dialog", { name: "Search runs, agents, and commands" })
    ).toHaveCount(0);
    await expect(
      reportReader.getByRole("button", { name: "Close report reader" })
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      reportReader.getByRole("button", { name: "01 Verification" })
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      reportReader.getByRole("button", { name: "Close report reader" })
    ).toBeFocused();
    await reportReader
      .getByRole("button", { name: "Close report reader" })
      .click();
    await expect(reportReader).toHaveCount(0);
    await expect(reportStep).toBeFocused();
    await expect
      .poll(() =>
        runRecord.evaluate(
          (element) => element.scrollHeight > element.clientHeight
        )
      )
      .toBe(true);
    await runRecord.evaluate((element) => {
      element.scrollTop = 0;
    });
    await page
      .locator(".oc-agent-rail")
      .getByRole("button", { name: /completed Verify timeline/u })
      .click();
    await expect
      .poll(() => runRecord.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);

    await page
      .locator(".oc-agent-rail")
      .getByRole("button", { name: /completed Answer 2\+2 and nothing else/u })
      .click();
    const compactReceipt = page.locator(
      '.oc-evidence-card[data-layout="compact"]'
    );
    await expect(compactReceipt).toBeVisible();
    await expect(compactReceipt.getByText("Run complete")).toBeVisible();
    await expect(compactReceipt.getByText("Result")).toBeVisible();
    await expect(compactReceipt.getByText("Direct response")).toBeVisible();
    await expect(compactReceipt.getByText("Completed in 1m 30s")).toBeVisible();
    await expect(
      compactReceipt.getByText("No file changes reported")
    ).toBeVisible();
    await expect(
      compactReceipt.getByText("Commands", { exact: true })
    ).toHaveCount(0);
    await expect(
      compactReceipt.getByText("Files", { exact: true })
    ).toHaveCount(0);
    await expect(
      compactReceipt.getByText("Exited 0", { exact: true })
    ).toHaveCount(0);
    await expect(
      compactReceipt.getByRole("button", { name: "Ask a follow-up" })
    ).toBeVisible();
    await expect
      .poll(() =>
        compactReceipt.evaluate(
          (element) => element.getBoundingClientRect().height
        )
      )
      .toBeLessThan(380);
    await expect
      .poll(() =>
        compactReceipt
          .locator(".oc-markdown-report")
          .evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).fontSize)
          )
      )
      .toBeGreaterThanOrEqual(24);

    await page
      .locator(".oc-agent-rail")
      .getByRole("button", { name: /completed Verify timeline/u })
      .click();
    await expect(
      page.getByRole("heading", { level: 2, name: "Verification" }).first()
    ).toBeVisible();
    await page.getByRole("button", { exact: true, name: "collapse" }).click();
    await expect(page.getByText("second output line")).toHaveCount(0);
    await expect(
      page.getByRole("button", { exact: true, name: "expand" })
    ).toBeVisible();

    await page.setViewportSize({ height: 844, width: 1440 });
    await navigationResizeHandle.press("End");
    await stepsResizeHandle.press("End");
    await page.setViewportSize({ height: 844, width: 981 });
    const resizeFrames = await page.evaluate(async () => {
      const samples: {
        agentMax: number;
        agentNow: number;
        mainWidth: number;
        stepsMax: number;
        stepsNow: number;
      }[] = [];

      const captureFrame = () => {
        const main = document.querySelector(".oc-console-main-pane");
        const agentHandle = document.querySelector(
          '[aria-label="Resize the navigation rail"]'
        );
        const stepsHandle = document.querySelector(
          '[aria-label="Resize the steps panel"]'
        );
        if (!(main && agentHandle && stepsHandle)) {
          throw new Error("Console panes were not rendered");
        }
        samples.push({
          agentMax: Number(agentHandle.getAttribute("aria-valuemax")),
          agentNow: Number(agentHandle.getAttribute("aria-valuenow")),
          mainWidth: main.getBoundingClientRect().width,
          stepsMax: Number(stepsHandle.getAttribute("aria-valuemax")),
          stepsNow: Number(stepsHandle.getAttribute("aria-valuenow")),
        });
      };
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          captureFrame();
          requestAnimationFrame(() => {
            captureFrame();
            requestAnimationFrame(() => {
              captureFrame();
              resolve();
            });
          });
        });
      });

      return samples;
    });
    for (const frame of resizeFrames) {
      expect(frame.mainWidth).toBeGreaterThanOrEqual(359);
      expect(frame.agentNow).toBeLessThanOrEqual(frame.agentMax);
      expect(frame.stepsNow).toBeLessThanOrEqual(frame.stepsMax);
    }

    await page.setViewportSize({ height: 844, width: 390 });
    const commandCard = runRecord
      .getByRole("heading", { level: 3, name: "Command finished" })
      .locator("..")
      .locator("..");
    await expect
      .poll(() =>
        commandCard.evaluate(
          (element) => element.scrollWidth <= element.clientWidth
        )
      )
      .toBe(true);
    await expect
      .poll(() =>
        runRecord
          .locator(".oc-run-event-card")
          .evaluateAll((elements) =>
            elements.every(
              (element) => element.scrollWidth <= element.clientWidth
            )
          )
      )
      .toBe(true);
    const completionCard = runRecord
      .getByRole("heading", { level: 3, name: "Run completed" })
      .locator("..")
      .locator("..");
    const copyReceiptButton = completionCard.getByRole("button", {
      name: "Copy receipt",
    });
    await expect
      .poll(async () => {
        const [cardBox, buttonBox] = await Promise.all([
          completionCard.boundingBox(),
          copyReceiptButton.boundingBox(),
        ]);
        return Boolean(
          cardBox &&
            buttonBox &&
            buttonBox.x + buttonBox.width <= cardBox.x + cardBox.width
        );
      })
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Expand the steps panel" })
    ).toBeVisible();
    const mainPaneWidth = await page
      .locator(".oc-console-main-pane")
      .evaluate((element) => element.getBoundingClientRect().width);
    await page.getByRole("button", { name: "Expand the steps panel" }).click();
    await expect(page.locator(".oc-steps-timeline")).toHaveCSS(
      "position",
      "absolute"
    );
    await expect
      .poll(() =>
        page
          .locator(".oc-console-main-pane")
          .evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThanOrEqual(mainPaneWidth);
    await expect
      .poll(() =>
        evidenceReport
          .locator(".oc-markdown-report")
          .evaluate((element) => element.getBoundingClientRect().width)
      )
      .toBeGreaterThan(150);
    await expect
      .poll(() =>
        evidenceReport
          .getByRole("heading", { level: 2, name: "Verification" })
          .evaluate((element) => element.getBoundingClientRect().height)
      )
      .toBeLessThan(200);

    expect(applicationRequests).toEqual([
      "GET /api/agents",
      `GET /api/agents/${AGENT_ID}/runs`,
      `GET /api/runs/${RUN_ID}/events`,
      `GET /api/runs/${RUN_ID}`,
      "GET /api/runs/22222222-2222-4222-8222-000000000002/events",
    ]);
  });

  for (const scenario of [
    {
      agentStatus: "idle",
      event: {
        error: {
          code: "historical_failure_code_that_wraps_on_narrow_screens",
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

      if (scenario.historicalStatus === "failed") {
        await page.setViewportSize({ height: 844, width: 390 });
      }
      await page.goto("/agents");
      if (scenario.historicalStatus === "failed") {
        await page
          .getByRole("button", { name: "Expand the navigation" })
          .click();
      }
      await page
        .locator(".oc-agent-rail")
        .getByRole("button", {
          name: new RegExp(`${scenario.historicalStatus} Verify timeline`, "u"),
        })
        .click();

      await expect(page.getByText(scenario.transcript).first()).toBeVisible();
      if (scenario.historicalStatus === "failed") {
        await expect
          .poll(() =>
            page
              .locator('.oc-run-event-card[role="alert"]')
              .evaluate((element) => element.scrollWidth <= element.clientWidth)
          )
          .toBe(true);
      }
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
      .locator(".oc-agent-rail")
      .getByRole("button", { name: /running Verify timeline/ })
      .click();
    const liveActivity = page.getByRole("region", {
      name: "Live run activity",
    });
    await expect(liveActivity).toContainText("Runner active");
    await expect(liveActivity).toContainText(
      "The runner is checking the isolated process while waiting for the first sanitized update."
    );
    await expect(liveActivity).toContainText(
      "It will stop and report a run that reaches the execution limit."
    );
    await expect(liveActivity).toContainText("Safe updates");
    await expect(liveActivity).toContainText("Credential-safe stream");
    await page.getByRole("button", { exact: true, name: "Stop" }).click();

    await expect(page.getByText("Run cancelled.")).toBeVisible();
    await expect(page.getByRole("img", { name: "idle" })).toBeVisible();
    await expect(page.getByRole("img", { name: "running" })).toBeVisible();
    await releaseEvents();
  });

  test("a pending stop stays honest and the live record can be closed", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
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
          json: { agents: [{ ...retainedAgent, status: "running" }] },
        });
      }
      if (pathname === `/api/agents/${AGENT_ID}/runs`) {
        return route.fulfill({
          json: { apiVersion: "1.0", runs: [liveRun()] },
        });
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
          json: { apiVersion: "1.0", run: liveRun() },
          status: 202,
        });
      }
      if (pathname === `/api/runs/${RUN_ID}`) {
        return route.fulfill({
          json: { apiVersion: "1.0", run: liveRun() },
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");
    await page
      .locator(".oc-agent-rail")
      .getByRole("button", { name: /running Verify timeline/ })
      .click();
    await page.getByRole("button", { exact: true, name: "Stop" }).click();

    await expect(page.getByText("Stop requested.")).toBeVisible();
    await expect(
      page.getByRole("button", { exact: true, name: "Retry stop" }).first()
    ).toBeVisible();
    await expect(page.getByText("Run cancelled.")).toHaveCount(0);

    await page
      .getByRole("button", { exact: true, name: "Close run view" })
      .click();
    await expect(
      page.getByRole("region", { name: "Live run activity" })
    ).toHaveCount(0);
    await releaseEvents();
  });

  test("a completed live event leaves the owning agent idle", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    let releaseEvents!: () => Promise<void>;
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
        return new Promise<void>((resolve) => {
          releaseEvents = async () => {
            await route.fulfill({
              body: `data: ${JSON.stringify({
                id: 1,
                run: liveRun("completed"),
                type: "completed",
              })}\n\n`,
              contentType: "text/event-stream",
            });
            resolve();
          };
        });
      }
      return route.fulfill({ json: {}, status: 404 });
    });

    await page.goto("/agents");

    const agentButton = page.getByRole("button", {
      name: retainedAgent.name,
    });
    await agentButton.focus();
    await expect(agentButton).toBeFocused();
    await releaseEvents();

    await expect(agentButton.getByRole("img", { name: "idle" })).toBeVisible();
    await expect(agentButton).toBeFocused();
    await expect(
      page
        .locator(".oc-agent-rail")
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
      page.getByRole("button", { name: "Account and settings" })
    ).toHaveAttribute("title", "not signed in");

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
    let sessionSetCookie: string | undefined;
    await page.route("**/api/auth/session", (route) =>
      fulfillSessionOverride(route, sessionOverride, sessionSetCookie)
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
        authVersion: 1,
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    sessionSetCookie = await subscriberSessionSetCookie(
      "second@example.invalid",
      "00000000-0000-4000-8000-000000000002"
    );
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
    let sessionSetCookie: string | undefined;
    await page.route("**/api/auth/session", (route) =>
      fulfillSessionOverride(route, sessionOverride, sessionSetCookie)
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
        authVersion: 1,
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    sessionSetCookie = await subscriberSessionSetCookie(
      "second@example.invalid",
      "00000000-0000-4000-8000-000000000002"
    );
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
    let sessionSetCookie: string | undefined;
    await page.route("**/api/auth/session", (route) =>
      fulfillSessionOverride(route, sessionOverride, sessionSetCookie)
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
        authVersion: 1,
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    sessionSetCookie = await subscriberSessionSetCookie(
      "second@example.invalid",
      "00000000-0000-4000-8000-000000000002"
    );
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { email?: string } };
      return body.user?.email === "second@example.invalid";
    });
    await notifySessionChange(page);
    await sessionRefresh;
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page.getByRole("tab", { exact: true, name: "Account" }).click();
    await expect(
      page.getByText("second@example.invalid", { exact: true })
    ).toBeVisible();
    await page
      .getByRole("tab", { exact: true, name: "Harness credentials" })
      .click();
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
    let sessionSetCookie: string | undefined;
    await page.route("**/api/auth/session", (route) =>
      fulfillSessionOverride(route, sessionOverride, sessionSetCookie)
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
    await page.getByRole("tab", { name: "Data" }).click();
    await page.getByRole("button", { name: "Delete all chats…" }).click();
    await page.getByRole("button", { name: "Yes, delete every chat" }).click();
    await started;

    sessionOverride = {
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        authVersion: 1,
        email: "second@example.invalid",
        id: "00000000-0000-4000-8000-000000000002",
        image: null,
        name: "Second subscriber",
        type: "subscriber",
      },
    };
    sessionSetCookie = await subscriberSessionSetCookie(
      "second@example.invalid",
      "00000000-0000-4000-8000-000000000002"
    );
    const sessionRefresh = page.waitForResponse(async (response) => {
      if (new URL(response.url()).pathname !== "/api/auth/session") {
        return false;
      }
      const body = (await response.json()) as { user?: { email?: string } };
      return body.user?.email === "second@example.invalid";
    });
    await notifySessionChange(page);
    await sessionRefresh;
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page.getByRole("tab", { exact: true, name: "Account" }).click();
    await expect(
      page.getByText("second@example.invalid", { exact: true })
    ).toBeVisible();

    await releaseWipe();
    await page.waitForTimeout(100);
    await expect(page.getByText("All chats deleted.")).toHaveCount(0);
    await expect(page.getByText("Could not delete your chats.")).toHaveCount(0);
    await expect(page.getByText("No unsaved changes")).toBeVisible();
  });
});
