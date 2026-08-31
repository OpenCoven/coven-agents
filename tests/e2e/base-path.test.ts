import { expect, type Page, type Route, test } from "@playwright/test";
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

  test("signed-out checkout recovery preserves the base path, query, and fragment through login", async ({
    page,
  }) => {
    test.skip(!IS_DEMO, "This contract runs with IS_DEMO=1.");
    const callbackUrl =
      "/demo/account?source=ledger&checkout=success#allowance";
    await mockDemoGitHubAuth(page, callbackUrl);

    await page.goto("/demo/account?source=ledger&checkout=success#allowance");
    const signIn = page.getByRole("link", { name: "Sign in with GitHub" });
    await expect(signIn).toHaveAttribute(
      "href",
      `/demo/login?callbackUrl=${encodeURIComponent(callbackUrl)}`
    );
    await signIn.click();
    await expect(page).toHaveURL(
      `/demo/login?callbackUrl=${encodeURIComponent(callbackUrl)}`
    );
    await page.getByRole("button", { name: "Continue with GitHub" }).click();

    await expect(page).toHaveURL(
      "https://github.com/login/oauth/authorize?client_id=demo-test"
    );
  });

  for (const callbackUrl of [
    "/account?checkout=success",
    "/demo-other/account?checkout=success",
    "https://attacker.test/account",
    "//attacker.test/account",
    "%68%74%74%70%73%3A%2F%2Fattacker.test",
  ]) {
    test(`demo login rejects callback outside its application path: ${callbackUrl}`, async ({
      page,
    }) => {
      test.skip(!IS_DEMO, "This contract runs with IS_DEMO=1.");
      await mockDemoGitHubAuth(page, "/demo");

      await page.goto(
        `/demo/login?callbackUrl=${encodeURIComponent(callbackUrl)}`
      );
      await page.getByRole("button", { name: "Continue with GitHub" }).click();

      await expect(page).toHaveURL(
        "https://github.com/login/oauth/authorize?client_id=demo-test"
      );
    });
  }
});

async function mockDemoGitHubAuth(
  page: Page,
  expectedCallbackUrl: string
): Promise<void> {
  const authorizationUrl =
    "https://github.com/login/oauth/authorize?client_id=demo-test";
  await page.route("**/demo/api/auth/**", async (route: Route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === "/demo/api/auth/session") {
      await route.fulfill({ body: "null", contentType: "application/json" });
      return;
    }
    if (pathname === "/demo/api/auth/providers") {
      await route.fulfill({
        json: {
          github: {
            callbackUrl: `${new URL(request.url()).origin}/demo/api/auth/callback/github`,
            id: "github",
            name: "GitHub",
            signinUrl: `${new URL(request.url()).origin}/demo/api/auth/signin/github`,
            type: "oauth",
          },
        },
      });
      return;
    }
    if (pathname === "/demo/api/auth/csrf") {
      await route.fulfill({ json: { csrfToken: "demo-test-csrf" } });
      return;
    }
    if (pathname === "/demo/api/auth/signin/github") {
      expect(
        Object.fromEntries(new URLSearchParams(request.postData() ?? ""))
      ).toEqual({
        callbackUrl: expectedCallbackUrl,
        csrfToken: "demo-test-csrf",
      });
      await route.fulfill({ json: { url: authorizationUrl } });
      return;
    }
    throw new Error(`Unexpected demo Auth.js path: ${pathname}`);
  });
  await page.route(authorizationUrl, (route) =>
    route.fulfill({
      body: "<title>GitHub authorization</title>",
      contentType: "text/html",
    })
  );
}
