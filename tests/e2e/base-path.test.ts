import { expect, type Page, type Route, test } from "@playwright/test";
import { E2E_USER_ID, subscriberCookies } from "./session";

const IS_DEMO = process.env.IS_DEMO === "1";

test.describe("Demo base path", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("account and console sign-out callbacks use one demo prefix", async ({
    page,
  }) => {
    test.skip(!IS_DEMO, "This contract runs with IS_DEMO=1.");
    const callbacks: Array<string | null> = [];
    const applicationRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.includes("/api/")) {
        applicationRequests.push(pathname);
      }
    });
    await page.route("**/demo/api/credentials", (route) =>
      route.fulfill({ json: { harnessIds: [] } })
    );
    await page.route("**/demo/api/usage", (route) =>
      route.fulfill({
        json: {
          cap: 750,
          resetsAt: "2099-02-01T00:00:00.000Z",
          used: 0,
        },
      })
    );
    await page.route("**/demo/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route(/\/demo\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/demo/api/agents"
          ? { json: { agents: [] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });
    await page.route("**/demo/api/subscription", (route) =>
      route.fulfill({
        json: {
          active: true,
          checkoutEnabled: true,
          subscribedUntil: "2099-01-15T12:00:00.000Z",
        },
      })
    );
    await page.route("**/demo/api/auth/**", (route) => {
      const request = route.request();
      const { pathname } = new URL(request.url());
      if (pathname === "/demo/api/auth/session") {
        return route.fulfill({
          json: {
            expires: "2099-01-01T00:00:00.000Z",
            user: {
              authVersion: 1,
              email: "e2e-user@example.invalid",
              id: E2E_USER_ID,
              image: null,
              name: "E2E subscriber",
              type: "subscriber",
            },
          },
        });
      }
      if (pathname === "/demo/api/auth/csrf") {
        return route.fulfill({ json: { csrfToken: "demo-signout-csrf" } });
      }
      if (pathname === "/demo/api/auth/signout") {
        callbacks.push(
          new URLSearchParams(request.postData() ?? "").get("callbackUrl")
        );
        return route.fulfill({ json: { url: "/demo/login" } });
      }
      throw new Error(`Unexpected demo Auth.js path: ${pathname}`);
    });

    await page.goto("/demo/account");
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect.poll(() => callbacks).toEqual(["/demo/login"]);

    await page.goto("/demo/agents");
    await page.getByRole("button", { name: "Account and settings" }).click();
    await page.getByRole("tab", { exact: true, name: "Account" }).click();
    await page.getByRole("button", { name: "Sign out" }).click();

    await expect.poll(() => callbacks).toEqual(["/demo/login", "/demo/login"]);
    expect(callbacks).not.toContain("/demo/demo/login");
    expect(applicationRequests).toContain("/demo/api/credentials");
    expect(applicationRequests).not.toContain("/api/credentials");
    expect(applicationRequests).not.toContain("/api/agents");
    expect(applicationRequests).not.toContain("/api/runs");
  });

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

  test("signed-out console settings preserve the demo return path", async ({
    page,
  }) => {
    test.skip(!IS_DEMO, "This contract runs with IS_DEMO=1.");
    await page.route("**/demo/api/auth/session", (route) =>
      route.fulfill({ body: "null", contentType: "application/json" })
    );
    await page.route("**/demo/api/tenant/prewarm", (route) =>
      route.fulfill({ status: 204 })
    );
    await page.route(/\/demo\/api\/(?:agents|runs)(?:\/|$)/, (route) => {
      const { pathname } = new URL(route.request().url());
      return route.fulfill(
        pathname === "/demo/api/agents"
          ? { json: { agents: [] } }
          : { json: { apiVersion: "1.0", runs: [] } }
      );
    });

    await page.goto("/demo/agents");
    await page.getByRole("button", { name: "Account and settings" }).click();

    await expect(
      page.getByRole("link", { name: "Sign in with GitHub" })
    ).toHaveAttribute("href", "/demo/login?callbackUrl=%2Fdemo%2Fagents");
  });

  test("credential read, write, delete, device start, and poll use one demo prefix", async ({
    context,
    page,
  }) => {
    test.skip(!IS_DEMO, "This contract runs with IS_DEMO=1.");
    await context.addCookies(await subscriberCookies());
    const credentialRequests: Array<{ method: string; pathname: string }> = [];
    let configured = false;
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.includes("/api/credentials")) {
        credentialRequests.push({ method: request.method(), pathname });
      }
    });
    await page.addInitScript(() => {
      window.open = () => null;
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
            type: "subscriber",
          },
        },
      })
    );
    await page.route("**/demo/api/credentials", (route) => {
      const method = route.request().method();
      if (method === "GET") {
        return route.fulfill({
          json: { harnessIds: configured ? ["copilot"] : [] },
        });
      }
      if (method === "POST") {
        configured = true;
        return route.fulfill({
          json: { harnessId: "copilot", stored: true },
        });
      }
      configured = false;
      return route.fulfill({
        json: { harnessId: "copilot", removed: true },
      });
    });
    await page.route("**/demo/api/credentials/device", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({
            json: {
              deviceCode: "demo-device-secret",
              expiresIn: 900,
              interval: 0.01,
              userCode: "DEMO-CODE",
              verificationUri: "https://github.com/login/device",
            },
          })
        : route.fulfill({ json: { status: "denied" } })
    );

    await page.goto("/demo/account");
    await page.getByRole("button", { name: "Connect GitHub Copilot" }).click();
    await expect(page.getByText("DEMO-CODE")).toBeVisible();
    await expect(page.getByText("Authorization was declined.")).toBeVisible();

    const input = page.getByLabel("GitHub Copilot");
    await input.fill("demo-token");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Remove GitHub Copilot CLI credential" })
      .click();
    await expect(page.getByText("Connected", { exact: true })).toHaveCount(0);

    await expect
      .poll(() => credentialRequests)
      .toEqual(
        expect.arrayContaining([
          { method: "GET", pathname: "/demo/api/credentials" },
          { method: "POST", pathname: "/demo/api/credentials" },
          { method: "DELETE", pathname: "/demo/api/credentials" },
          { method: "POST", pathname: "/demo/api/credentials/device" },
          { method: "PUT", pathname: "/demo/api/credentials/device" },
        ])
      );
    expect(
      credentialRequests.every(
        ({ pathname }) =>
          pathname.startsWith("/demo/api/credentials") &&
          !pathname.startsWith("/demo/demo/")
      )
    ).toBe(true);
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
