import { randomUUID } from "node:crypto";
import { type APIRequestContext, expect, test } from "@playwright/test";
import postgres from "postgres";
import { HERMETIC_USERS } from "./hermetic-db";
import { sessionCookies } from "./session";

const ownedChats = new Map<string, string[]>();

async function withTitlePersistencePaused(
  chatId: string,
  run: (release: () => Promise<void>) => Promise<void>
) {
  const url = process.env.POSTGRES_URL;
  if (
    process.env.E2E_HERMETIC_RUNNER !== "1" ||
    !url ||
    !new URL(url).pathname.startsWith("/coven_test_")
  ) {
    throw new Error(
      "Title persistence fixtures require an owned disposable database."
    );
  }
  const sql = postgres(url, { max: 1 });
  const lock = postgres(url, { max: 1 });
  const name = `e2e_title_${chatId.replaceAll("-", "")}`;
  let releasing: Promise<void> | undefined;
  const release = () => {
    releasing ??= lock.end({ timeout: 2 });
    return releasing;
  };
  try {
    // Pause only the title write, not the response or message persistence.
    await sql`CREATE FUNCTION ${sql(name)}() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(726419, hashtext(NEW."id"::text));
        RETURN NEW;
      END;
      $$`;
    await sql`CREATE TRIGGER ${sql(name)} BEFORE UPDATE OF "title" ON "Chat"
      FOR EACH ROW EXECUTE FUNCTION ${sql(name)}()`;
    await lock`SELECT pg_advisory_lock(726419, hashtext(${chatId}))`;
    await run(release);
  } finally {
    await release();
    try {
      await sql`DROP TRIGGER IF EXISTS ${sql(name)} ON "Chat"`;
      await sql`DROP FUNCTION IF EXISTS ${sql(name)}()`;
    } finally {
      await sql.end({ timeout: 2 });
    }
  }
}

async function persistedTitle(request: APIRequestContext, chatId: string) {
  const response = await request.get("/api/history?limit=100");
  expect(response.status()).toBe(200);
  const history: { chats: { id: string; title: string }[] } =
    await response.json();
  return history.chats.find((chat) => chat.id === chatId)?.title;
}

test.describe("Durable chat titles", () => {
  test.skip(
    process.env.E2E_HERMETIC_RUNNER !== "1",
    "Requires the hermetic runner's owned database and offline models."
  );
  test.afterEach(async ({ context }, info) => {
    const ids = ownedChats.get(info.testId) ?? [];
    ownedChats.delete(info.testId);
    await Promise.all(
      ids.map(async (id) => {
        const response = await context.request.delete(`/api/chat?id=${id}`);
        expect(response.status()).toBe(200);
      })
    );
  });

  for (const mode of [
    "without reloading",
    "after navigation",
    "after stop",
    "after disconnect",
  ] as const) {
    test(`a late title reaches the mounted sidebar ${mode}`, async ({
      context,
      page,
    }, info) => {
      test.setTimeout(60_000);
      const navigate = mode === "after navigation";
      const subscriber = HERMETIC_USERS.subscriberA;
      await context.addCookies([
        ...(await sessionCookies("subscriber", subscriber)),
        {
          domain: "localhost",
          name: "sidebar_state",
          path: "/",
          value: "true",
        },
      ]);
      const chatId = randomUUID();
      const otherId = randomUUID();
      const createdIds: string[] = [];
      ownedChats.set(info.testId, createdIds);
      const initialHistory = Promise.withResolvers<void>();
      await page.route(`**/api/messages?chatId=${chatId}`, async (route) => {
        const response = await route.fetch();
        await initialHistory.promise;
        await route.fulfill({ response });
      });
      await test.step("Create the navigation chat through the real route", async () => {
        const other = await page.request.post("/api/chat", {
          data: {
            id: otherId,
            message: {
              id: randomUUID(),
              parts: [{ text: "Plan a garden.", type: "text" }],
              role: "user",
            },
            selectedChatModel: "moonshotai/kimi-k2.5",
            selectedVisibilityType: "private",
          },
        });
        expect(other.status()).toBe(200);
        createdIds.push(otherId);
        await other.body();
      });
      await page.goto(`/chat/${chatId}`);
      const input = page.getByTestId("multimodal-input");
      await expect(input).toBeVisible();
      const row = page.locator(`a[href="/chat/${chatId}"]`);

      await withTitlePersistencePaused(chatId, async (release) => {
        await input.fill("Explain how rainbows form.");
        const responsePromise = page.waitForResponse(
          (candidate) =>
            new URL(candidate.url()).pathname === "/api/chat" &&
            candidate.request().method() === "POST"
        );
        await page.getByTestId("send-button").click();
        const response = await responsePromise;
        expect(response.status()).toBe(200);
        createdIds.push(chatId);
        initialHistory.resolve();
        if (mode === "after stop" || mode === "after disconnect") {
          await expect(page.getByTestId("message-assistant")).toBeVisible();
          await expect(page.getByTestId("stop-button")).toBeVisible();
          expect(await persistedTitle(context.request, chatId)).toBe(
            "New chat"
          );
          if (mode === "after disconnect") {
            await page.close();
            await release();
            await expect
              .poll(() => persistedTitle(context.request, chatId))
              .toBe("Test Conversation");
            page = await context.newPage();
            await page.goto(`/chat/${chatId}`);
            await expect(page.locator(`a[href="/chat/${chatId}"]`)).toHaveText(
              "Test Conversation"
            );
            return;
          }
          await page.getByTestId("stop-button").click();
        }
        if (mode !== "after stop") {
          await test.step("Wait for the response to close before releasing persistence", async () => {
            await response.finished();
          });
        }
        await expect(row).toHaveText("New chat");
        expect(await persistedTitle(page.request, chatId)).toBe("New chat");

        if (navigate) {
          await page.evaluate(() => {
            document.documentElement.dataset.titleNavigation = "retained";
          });
          await page.locator(`a[href="/chat/${otherId}"]`).click();
          await expect(page).toHaveURL(`/chat/${otherId}`);
          expect(
            await page.evaluate(
              () => document.documentElement.dataset.titleNavigation
            )
          ).toBe("retained");
          await expect(row).toHaveText("New chat");
        }

        await release();
        await expect
          .poll(() => persistedTitle(page.request, chatId))
          .toBe("Test Conversation");
        await expect(row).toHaveText("Test Conversation");
        await expect(page.getByTestId("message-user")).toContainText(
          navigate ? "Plan a garden." : "Explain how rainbows form."
        );
      });

      await page.reload();
      await expect(page.locator(`a[href="/chat/${chatId}"]`)).toHaveText(
        "Test Conversation"
      );
      const messages = await page.request.get(`/api/messages?chatId=${chatId}`);
      expect(messages.status()).toBe(200);
      const saved: { messages: { role: string }[] } = await messages.json();
      expect(saved.messages[0]?.role).toBe("user");
      if (mode === "without reloading" || navigate) {
        expect(saved.messages.map(({ role }) => role)).toEqual([
          "user",
          "assistant",
        ]);
      }
    });
  }
});
