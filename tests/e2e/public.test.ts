import { expect, test } from "@playwright/test";

test("the public security statement renders at a phone viewport", async ({
  page,
}) => {
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/security");

  await expect(
    page.getByRole("heading", {
      name: "Autonomous agents, bounded by infrastructure.",
    })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Tenants are isolated by construction" })
  ).toBeVisible();
  await expect(page.getByText("security@opencoven.ai")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});
