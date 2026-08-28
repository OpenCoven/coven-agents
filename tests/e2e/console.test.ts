import { expect, test } from "@playwright/test";
import { subscriberCookies } from "./session";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const RUNNER_IDENTITY = `${Buffer.from(
  JSON.stringify({ exp: 4_102_444_800 })
).toString("base64url")}.audit-signature`;

const retainedAgent = {
  backend: "cloud",
  createdAt: "2026-08-27T06:00:00.000Z",
  description: "Verifies the run timeline.",
  id: AGENT_ID,
  instructions: "Report evidence clearly.",
  lastRunAt: "2026-08-27T06:01:00.000Z",
  model: "auto",
  name: "Timeline auditor",
  runtime: "copilot",
  status: "idle",
  updatedAt: "2026-08-27T06:01:00.000Z",
  workspace: "/workspace",
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
        pathname === "/api/runner-connection"
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
    await page.route("**/api/runner-connection", (route) =>
      route.fulfill({
        json: { endpoint: "http://127.0.0.1:8787", token: "audit-token" },
      })
    );
    await page.route("**/api/runner-token", (route) =>
      route.fulfill({ json: { token: RUNNER_IDENTITY } })
    );
    await page.route("http://127.0.0.1:8787/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/agents") {
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
  });
});
