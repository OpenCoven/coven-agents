import { expect, test } from "@playwright/test";
import { E2E_USER_ID, subscriberCookies } from "./session";

const ADMIN_EMAIL = "e2e-admin@example.invalid";

const directory = {
  accounts: [
    {
      email: "e··@e··.invalid",
      id: E2E_USER_ID,
      lastRunDay: "2026-08-26",
      plan: "subscriber",
      runs: 5,
      signupDay: "2026-08-25",
      status: "active",
    },
  ],
  overview: {
    accountsTotal: 1,
    activeAccounts: 1,
    days: [
      { day: "2026-08-25", runs: 2 },
      { day: "2026-08-26", runs: 3 },
    ],
    newAccounts: 1,
    range: 30,
    runsPrevious: 1,
    runsTotal: 5,
  },
};

test.describe("Warden admin", () => {
  test("the page and data route stay undiscoverable when signed out", async ({
    page,
  }) => {
    const pageResponse = await page.goto("/admin");
    expect(pageResponse?.status()).toBe(404);

    const apiResponse = await page.request.get("/api/admin");
    expect(apiResponse.status()).toBe(404);
    expect(apiResponse.headers()["cache-control"]).toBe("no-store");
  });

  test("all Warden controls and account columns remain reachable on a phone", async ({
    context,
    page,
  }) => {
    await page.setViewportSize({ height: 844, width: 390 });
    await context.addCookies(await subscriberCookies(ADMIN_EMAIL));
    await page.route("**/api/admin?**", (route) =>
      route.fulfill({
        body: JSON.stringify(directory),
        contentType: "application/json",
        status: 200,
      })
    );

    await page.goto("/admin");
    await expect(
      page.getByRole("heading", { name: /The fleet/ })
    ).toBeVisible();

    const searchBox = await page.getByRole("searchbox").boundingBox();
    expect(searchBox).not.toBeNull();
    expect((searchBox?.x ?? 0) + (searchBox?.width ?? 0)).toBeLessThanOrEqual(
      390
    );

    await page.getByRole("button", { name: "Accounts" }).click();
    const tableScroller = page.locator(".oc-admin-table-scroll");
    await expect(tableScroller).toBeVisible();
    expect(
      await tableScroller.evaluate(
        (element) => element.scrollWidth > element.clientWidth
      )
    ).toBe(true);
    await page
      .getByRole("button", { name: "runs · 30d" })
      .scrollIntoViewIfNeeded();
    await expect(
      page.getByRole("button", { name: "runs · 30d" })
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
  });
});
