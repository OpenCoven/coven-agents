import { expect, test } from "@playwright/test";

const IS_DEMO = process.env.IS_DEMO === "1";

test.describe("Anonymous fixture demo", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("replays committed synthetic evidence without authority or external requests", async ({
    page,
  }) => {
    test.skip(!IS_DEMO, "This contract runs with IS_DEMO=1.");
    const prohibitedRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin !== "http://localhost:3100" ||
        url.pathname.includes("/api/")
      ) {
        prohibitedRequests.push(`${request.method()} ${url.href}`);
      }
    });

    await page.goto("/demo/");

    await expect(
      page.getByRole("heading", {
        name: "Add a small task-summary formatter, cover edge cases, and verify the focused unit suite.",
      })
    ).toBeVisible();
    await expect(page.getByText("Curated guest preview")).toBeVisible();
    await expect(
      page.getByText(
        "This is a deterministic example built from sanitized evidence."
      )
    ).toBeVisible();

    await page.getByRole("button", { name: "Replay guest run" }).click();
    await expect(
      page.getByText("Implementation and focused verification are complete.")
    ).toBeVisible();

    expect(prohibitedRequests).toEqual([]);
  });
});
