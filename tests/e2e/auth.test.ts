import { expect, test } from "@playwright/test";

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
    await expect(
      page.getByRole("button", { name: "Continue with GitHub" })
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Password")).toHaveCount(0);
  });

  test("register redirects to GitHub account creation", async ({ page }) => {
    await page.goto("/register");
    await expect(page).toHaveURL("/login");
  });
});
