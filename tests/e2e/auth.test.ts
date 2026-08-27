import { expect, type Page, type Route, test } from "@playwright/test";

test.describe("Authentication Pages", () => {
  test.use({
    storageState: {
      cookies: [],
      origins: [],
    },
  });

  test("login offers GitHub-only guest account creation", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Create or access your account" })
    ).toBeVisible();
    await expect(
      page.getByText(
        /New accounts start with guest access, and signing in never starts an agent or a run\./
      )
    ).toBeVisible();
    await expect(
      page.getByText(
        /we begin warming the sandbox so the first mission starts fast/i
      )
    ).toBeVisible();
    const githubButton = page.getByRole("button", {
      name: "Continue with GitHub",
    });
    await expect(githubButton).toBeVisible();
    await expect(githubButton).toBeEnabled();
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
  });

  test("rate-limited POST GitHub sign-in stays on login and offers a retry", async ({
    page,
  }) => {
    let releaseAuthResponse: (() => void) | undefined;
    let postSignInAttempts = 0;
    const authResponseReady = new Promise<void>((resolve) => {
      releaseAuthResponse = resolve;
    });

    const authRequests = await mockGitHubAuthSupport(page, async (route) => {
      postSignInAttempts += 1;
      await authResponseReady;
      await route.fulfill({
        body: JSON.stringify({
          error: "rate_limited",
          message: "Too many requests. Try again later.",
        }),
        contentType: "application/json",
        headers: {
          "cache-control": "no-store",
          "retry-after": "60",
        },
        status: 429,
      });
    });

    await page.goto("/login");
    const loginUrl = page.url();
    const githubButton = page.getByRole("button", {
      name: /Continue with GitHub|Redirecting…/,
    });

    await githubButton.click();
    await expect.poll(() => postSignInAttempts).toBe(1);
    await expect
      .poll(() => authRequests)
      .toEqual([
        "GET /api/auth/providers",
        "GET /api/auth/csrf",
        "POST /api/auth/signin/github?",
      ]);
    await expect(githubButton).toBeDisabled();
    await githubButton.evaluate((button) =>
      (button as HTMLButtonElement).click()
    );
    expect(postSignInAttempts).toBe(1);

    releaseAuthResponse?.();

    const retryMessage = page.getByText(
      "We couldn’t start GitHub sign-in. Please try again.",
      { exact: true }
    );
    await expect(retryMessage).toBeVisible();
    await expect(retryMessage).toHaveAttribute("role", "alert");
    await expect(retryMessage).toHaveAttribute("aria-live", "assertive");
    await expect(githubButton).toBeEnabled();
    await expect(page).toHaveURL(loginUrl);
    await expect(
      page.getByText("Too many requests. Try again later.", { exact: true })
    ).toHaveCount(0);
    expect(postSignInAttempts).toBe(1);
  });

  test("GET sign-in pages stay harmless before a successful POST start", async ({
    page,
  }) => {
    const authorizationUrl =
      "https://github.com/login/oauth/authorize?client_id=test-client";

    const authRequests = await mockGitHubAuthSupport(page, async (route) => {
      await route.fulfill({ json: { url: authorizationUrl } });
    });
    await page.route(authorizationUrl, async (route) => {
      await route.fulfill({
        body: "<title>GitHub authorization</title>",
        contentType: "text/html",
      });
    });

    await page.goto("/login");
    await page.evaluate(async () => {
      const pages = [
        ["/api/auth/signin", await fetch("/api/auth/signin")],
        ["/api/auth/signin/github", await fetch("/api/auth/signin/github")],
      ] as const;
      for (const [pathname, response] of pages) {
        if (!response.ok) {
          throw new Error(`${pathname} returned ${response.status}`);
        }
      }
    });
    await page.getByRole("button", { name: "Continue with GitHub" }).click();

    await expect
      .poll(() => authRequests)
      .toEqual([
        "GET /api/auth/signin",
        "GET /api/auth/signin/github",
        "GET /api/auth/providers",
        "GET /api/auth/csrf",
        "POST /api/auth/signin/github?",
      ]);
    await expect(page).toHaveURL(authorizationUrl);
    await expect(page).toHaveTitle("GitHub authorization");
  });

  test("register redirects to GitHub account creation", async ({ page }) => {
    await page.goto("/register");
    await expect(page).toHaveURL("/login");
  });
});

async function mockGitHubAuthSupport(
  page: Page,
  handleSignIn: (route: Route) => Promise<void>
) {
  const authRequests: string[] = [];

  await page.route("**/api/auth/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const requestName = `${request.method()} ${url.pathname}`;

    if (requestName === "GET /api/auth/session") {
      await route.fulfill({
        body: "null",
        contentType: "application/json",
      });
      return;
    }

    if (
      requestName === "GET /api/auth/signin" ||
      requestName === "GET /api/auth/signin/github"
    ) {
      authRequests.push(requestName);
      await route.fulfill({
        body: "<title>Auth.js sign-in</title>",
        contentType: "text/html",
      });
      return;
    }

    if (requestName === "GET /api/auth/providers") {
      authRequests.push(requestName);
      await route.fulfill({
        json: {
          github: {
            callbackUrl: `${url.origin}/api/auth/callback/github`,
            id: "github",
            name: "GitHub",
            signinUrl: `${url.origin}/api/auth/signin/github`,
            type: "oauth",
          },
        },
      });
      return;
    }

    if (requestName === "GET /api/auth/csrf") {
      authRequests.push(requestName);
      await route.fulfill({ json: { csrfToken: "test-csrf-token" } });
      return;
    }

    if (
      requestName === "POST /api/auth/signin/github" &&
      request.url().endsWith("/api/auth/signin/github?")
    ) {
      authRequests.push(`${requestName}?`);
      expect(request.headers()["content-type"]).toContain(
        "application/x-www-form-urlencoded"
      );
      expect(request.headers()["x-auth-return-redirect"]).toBe("1");
      expect(
        Object.fromEntries(new URLSearchParams(request.postData() ?? ""))
      ).toEqual({
        callbackUrl: "/",
        csrfToken: "test-csrf-token",
      });
      await handleSignIn(route);
      return;
    }

    throw new Error(`Unexpected NextAuth request: ${request.method()} ${url}`);
  });

  return authRequests;
}
