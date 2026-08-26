import { expect, type Page, test } from "@playwright/test";

test.describe("Authentication Pages", () => {
  test("login offers GitHub-only guest account creation", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Create or access your account" })
    ).toBeVisible();
    await expect(
      page.getByText(
        "New accounts start with guest access, and signing in never starts an agent, sandbox, or run."
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

  test("rate-limited GitHub sign-in stays on login and offers a retry", async ({
    page,
  }) => {
    let releaseAuthResponse: (() => void) | undefined;
    let signInAttempts = 0;
    const authResponseReady = new Promise<void>((resolve) => {
      releaseAuthResponse = resolve;
    });

    await mockGitHubAuthSupport(page);
    await page.route("**/api/auth/signin/github*", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }

      signInAttempts += 1;
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
    await expect.poll(() => signInAttempts).toBe(1);
    await expect(githubButton).toBeDisabled();
    await githubButton.evaluate((button) =>
      (button as HTMLButtonElement).click()
    );
    expect(signInAttempts).toBe(1);

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
    expect(signInAttempts).toBe(1);
  });

  test("successful GitHub sign-in follows the authorization URL", async ({
    page,
  }) => {
    const authorizationUrl =
      "https://github.com/login/oauth/authorize?client_id=test-client";

    await mockGitHubAuthSupport(page);
    await page.route("**/api/auth/signin/github*", async (route) => {
      await route.fulfill({ json: { url: authorizationUrl } });
    });
    await page.route(authorizationUrl, async (route) => {
      await route.fulfill({
        body: "<title>GitHub authorization</title>",
        contentType: "text/html",
      });
    });

    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with GitHub" }).click();

    await expect(page).toHaveURL(authorizationUrl);
    await expect(page).toHaveTitle("GitHub authorization");
  });

  test("register redirects to GitHub account creation", async ({ page }) => {
    await page.goto("/register");
    await expect(page).toHaveURL("/login");
  });
});

async function mockGitHubAuthSupport(page: Page) {
  await page.route("**/api/auth/providers", async (route) => {
    const { origin } = new URL(route.request().url());
    await route.fulfill({
      json: {
        github: {
          callbackUrl: `${origin}/api/auth/callback/github`,
          id: "github",
          name: "GitHub",
          signinUrl: `${origin}/api/auth/signin/github`,
          type: "oauth",
        },
      },
    });
  });
  await page.route("**/api/auth/csrf", async (route) => {
    await route.fulfill({ json: { csrfToken: "test-csrf-token" } });
  });
}
