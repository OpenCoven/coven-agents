import { expect, test } from "@playwright/test";
import { subscriberCookies } from "./session";

test.describe("Legacy chat surface", () => {
  test("signed-out direct entries stop before protected chat requests", async ({
    page,
  }) => {
    const protectedRequests: string[] = [];
    page.on("request", (request) => {
      const { pathname } = new URL(request.url());
      if (pathname === "/api/messages" || pathname === "/api/history") {
        protectedRequests.push(pathname);
      }
    });

    await page.goto("/chat/e2e-chat");

    await expect(
      page.getByRole("heading", { name: "Sign in to use chat" })
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Sign in with GitHub" })
    ).toHaveAttribute("href", "/login");
    await expect(page.getByTestId("multimodal-input")).toHaveCount(0);
    expect(protectedRequests).toEqual([]);
  });

  test("subscriber chat input and model selection remain operable", async ({
    context,
    page,
  }) => {
    await context.addCookies(await subscriberCookies());
    await page.route("**/api/messages?**", (route) =>
      route.fulfill({
        body: JSON.stringify({
          isReadonly: false,
          messages: [],
          userId: null,
          visibility: "private",
        }),
        contentType: "application/json",
        status: 200,
      })
    );
    await page.route("**/api/history?**", (route) =>
      route.fulfill({
        body: JSON.stringify({ chats: [], hasMore: false }),
        contentType: "application/json",
        status: 200,
      })
    );
    await page.route("**/api/models", (route) =>
      route.fulfill({
        body: JSON.stringify({ capabilities: {} }),
        contentType: "application/json",
        status: 200,
      })
    );

    await page.goto("/chat/e2e-chat");

    const input = page.getByTestId("multimodal-input");
    await expect(input).toBeVisible();
    await input.fill("Line 1\nLine 2");
    await expect(input).toHaveValue("Line 1\nLine 2");
    await expect(page.getByTestId("send-button")).toBeVisible();

    await page.getByTestId("model-selector").click();
    await expect(page.getByPlaceholder("Search models...")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder("Search models...")).not.toBeVisible();
  });
});
