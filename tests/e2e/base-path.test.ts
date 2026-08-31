import { expect, test } from "@playwright/test";
import { E2E_USER_ID } from "./session";

const IS_DEMO = process.env.IS_DEMO === "1";

test.describe("Demo base path", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("billing surfaces call APIs beneath /demo", async ({ page }) => {
    test.skip(!IS_DEMO, "This contract runs with IS_DEMO=1.");
    const requestedPaths: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (
        pathname.endsWith("/api/subscription") ||
        pathname.endsWith("/api/checkout")
      ) {
        requestedPaths.push(pathname);
      }
    });
    await page.route("**/demo/api/auth/session", (route) =>
      route.fulfill({
        json: {
          expires: "2099-01-01T00:00:00.000Z",
          user: {
            authVersion: 1,
            email: "e2e-user@example.invalid",
            id: E2E_USER_ID,
            image: null,
            name: "E2E subscriber",
            type: "demo",
          },
        },
      })
    );
    await page.route("**/demo/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: [] } })
    );
    await page.route("**/demo/api/subscription", (route) =>
      route.fulfill({
        json: {
          active: false,
          checkoutEnabled: true,
          subscribedUntil: null,
        },
      })
    );
    await page.route("**/demo/api/checkout", (route) =>
      route.fulfill({
        json: { error: "checkout_refused" },
        status: 400,
      })
    );

    await page.goto("/demo/account?checkout=success");
    await expect(page.getByRole("tab", { name: "Billing" })).toBeVisible();
    await expect.poll(() => requestedPaths).toContain("/demo/api/subscription");

    await page.goto("/demo/account");
    await page.getByRole("tab", { name: "Billing" }).click();
    await page
      .getByRole("button", { name: "Continue to secure checkout" })
      .click();

    await expect.poll(() => requestedPaths).toContain("/demo/api/checkout");
    expect(requestedPaths).not.toContain("/api/subscription");
    expect(requestedPaths).not.toContain("/api/checkout");
  });
});
