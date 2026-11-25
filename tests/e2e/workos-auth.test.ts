import { expect, test } from "@playwright/test";

test.describe("WorkOS login", () => {
  test.skip(
    process.env.WORKOS_AUTH_ENABLED !== "1",
    "Requires isolated WorkOS test configuration"
  );
  test.use({ storageState: { cookies: [], origins: [] } });

  test("waitlist entry uses hosted AuthKit and exposes no direct GitHub bypass", async ({
    page,
  }) => {
    const effects: string[] = [];
    page.on("request", (request) => {
      if (
        /\/api\/(?:tenant\/prewarm|agents|runs|credentials)(?:\/|$)/u.test(
          new URL(request.url()).pathname
        )
      ) {
        effects.push(request.method());
      }
    });
    await page.route(
      "https://api.workos.com/user_management/authorize**",
      async (route) => {
        const authorization = new URL(route.request().url());
        expect(authorization.searchParams.get("provider")).toBe("authkit");
        expect(authorization.searchParams.get("screen_hint")).toBe("sign-up");
        expect(authorization.searchParams.get("code_challenge_method")).toBe(
          "S256"
        );
        expect(authorization.searchParams.get("state")).toBeTruthy();
        await route.fulfill({
          body: "<title>Isolated AuthKit test</title>",
          contentType: "text/html",
        });
      }
    );
    const providers = await page.request.get("/api/auth/providers");
    expect(providers.ok()).toBe(true);
    expect(Object.keys(await providers.json())).toEqual(["workos"]);
    await page.goto("/login");
    await expect(
      page.getByRole("button", { name: "Continue with WorkOS" })
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with GitHub" })
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Join the waitlist" }).click();
    await expect(page).toHaveTitle("Isolated AuthKit test");
    expect(effects).toEqual([]);
  });
});
