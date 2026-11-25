import { type BrowserContext, expect, test } from "@playwright/test";
import { HERMETIC_USERS } from "./hermetic-db";
import { sessionCookies, subscriberCookies } from "./session";

async function addSubscriberCookies(context: BrowserContext) {
  if (process.env.E2E_HERMETIC_RUNNER !== "1") {
    await context.addCookies(await subscriberCookies());
    return;
  }

  const subscriber = HERMETIC_USERS.subscriberA;
  await context.addCookies(
    await sessionCookies("subscriber", {
      authVersion: subscriber.authVersion,
      email: subscriber.email,
      id: subscriber.id,
      subscribedUntil: subscriber.subscribedUntil,
    })
  );
}

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
    await addSubscriberCookies(context);
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
    await expect(input).toBeFocused();
    await input.fill("Line 1\nLine 2");
    await expect(input).toHaveValue("Line 1\nLine 2");
    await expect(page.getByTestId("send-button")).toBeVisible();

    await page.getByTestId("model-selector").click();
    await expect(page.getByPlaceholder("Search models...")).toBeVisible();
    await expect(page.getByRole("option", { name: "Astra" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder("Search models...")).not.toBeVisible();
  });

  test("reasoning uses the OpenCoven reasoning activity card", async ({
    context,
    page,
  }) => {
    await addSubscriberCookies(context);
    await page.route("**/api/messages?**", (route) =>
      route.fulfill({
        body: JSON.stringify({
          isReadonly: false,
          messages: [
            {
              id: "reasoning-card-message",
              metadata: { createdAt: "2026-09-01T18:00:00.000Z" },
              parts: [
                {
                  state: "done",
                  text: "Compare the available sources before choosing a direction.",
                  type: "reasoning",
                },
                {
                  state: "output-denied",
                  toolCallId: "weather-denied",
                  type: "tool-getWeather",
                },
                {
                  text: "The newer source carries more weight.",
                  type: "text",
                },
              ],
              role: "assistant",
            },
          ],
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

    const card = page.getByTestId("message-reasoning");
    const trigger = card.getByRole("button", { name: /Reasoning/u });
    await expect(card).toBeVisible();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(trigger).toContainText(
      "Compare the available sources before choosing a direction."
    );
    await expect(trigger).toContainText("2 steps");
    await expect(trigger).toContainText("1 failed");

    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(card.getByText("Reasoning step 1")).toBeVisible();
    await expect(
      card.getByText("The call did not complete. No result was assumed.")
    ).toBeVisible();
    await expect(card.getByText("1 tool call")).toBeVisible();
    await page.waitForTimeout(1200);
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(trigger).toBeFocused();
  });
});
