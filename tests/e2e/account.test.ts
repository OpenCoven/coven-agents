import { expect, test } from "@playwright/test";
import { subscriberCookies } from "./session";

test.describe("Account settings", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("signed-out visitors see a sign-in gate without protected requests", async ({
    page,
  }) => {
    const protectedRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        pathname === "/api/credentials" ||
        pathname === "/api/account/avatar" ||
        pathname === "/api/usage"
      ) {
        protectedRequests.push(pathname);
      }
    });

    await page.goto("/account");

    await expect(
      page.getByRole("heading", { name: "Sign in to manage your account" })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Sign in with GitHub" })
    ).toHaveAttribute("href", "/login");
    await expect(page.getByLabel("GitHub Copilot credential")).toHaveCount(0);
    expect(protectedRequests).toEqual([]);
  });

  test("subscriber account navigation and controls fit a phone viewport", async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/credentials", (route) =>
      route.fulfill({
        body: JSON.stringify({ harnessIds: [] }),
        contentType: "application/json",
        status: 200,
      })
    );

    await page.goto("/account");
    await expect(
      page.getByRole("heading", { name: "Harness credentials" })
    ).toBeVisible();
    const navigation = await page.locator("nav").boundingBox();
    expect(navigation).not.toBeNull();
    expect(navigation?.width ?? 0).toBeGreaterThanOrEqual(360);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });
});
