import { expect, test } from "@playwright/test";

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
});
