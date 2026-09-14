import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Chat } from "@ai-sdk/react";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  DefaultChatTransport,
} from "ai";
import {
  createChatTitleReconciler,
  createChatTitleReconciliationManager,
} from "../lib/chat-title-reconciliation";
import type { ChatMessage } from "../lib/types";

const chatId = "new-cloud-chat";
const pendingTitle = { chatId, messageId: "first" };
const finishedMessages = [{ id: "first" }, { id: "answer" }];
const history = (title: string) => [{ chats: [{ id: chatId, title }] }];
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("SDK response and first history fetch finish before late persistence, then history reconciles", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const saved = deferred<void>();
  let retained: Promise<void> | undefined;
  let persistedTitle = "New chat";
  let sidebarTitle = "New chat";
  let reads = 0;
  const revalidateHistory = () => {
    reads += 1;
    sidebarTitle = persistedTitle;
    return Promise.resolve(history(sidebarTitle));
  };
  const reconciler = createChatTitleReconciler({ chatId, revalidateHistory });
  context.after(() => reconciler.dispose());
  const events: string[] = [];
  let streamOpen = true;
  const chat = new Chat<ChatMessage>({
    id: chatId,
    onData: (part) => {
      events.push(part.type);
      if (part.type === "data-chat-title-pending") {
        reconciler.markPending(part.data);
      }
    },
    onError: (error) => assert.fail(error.message),
    onFinish: ({ messages }) => {
      revalidateHistory();
      reconciler.responseSettled(messages);
    },
    transport: new DefaultChatTransport({
      fetch: () =>
        Promise.resolve(
          createUIMessageStreamResponse({
            stream: createUIMessageStream<ChatMessage>({
              execute({ writer }) {
                writer.write({
                  data: pendingTitle,
                  transient: true,
                  type: "data-chat-title-pending",
                });
                writer.write({ messageId: "answer", type: "start" });
                writer.write({ id: "text", type: "text-start" });
                writer.write({
                  delta: "Here is a plan",
                  id: "text",
                  type: "text-delta",
                });
                writer.write({ id: "text", type: "text-end" });
                writer.write({ finishReason: "stop", type: "finish" });
                retained = new Promise<string>((resolve) => {
                  setTimeout(() => resolve("Plan a garden"), 1500);
                }).then(async (title) => {
                  await saved.promise;
                  persistedTitle = title;
                  if (streamOpen) {
                    writer.write({ data: title, type: "data-chat-title" });
                  }
                });
              },
              onEnd: () => {
                streamOpen = false;
              },
            }),
          })
        ),
    }),
  });

  await chat.sendMessage({
    id: "first",
    parts: [{ text: "Plan a garden", type: "text" }],
    role: "user",
  });
  assert.equal(chat.status, "ready");
  assert.equal(sidebarTitle, "New chat");
  assert.equal(reads, 1);
  assert.ok(retained);

  context.mock.timers.tick(1000);
  await flush();
  assert.equal(sidebarTitle, "New chat");
  context.mock.timers.tick(500);
  await flush();
  assert.equal(persistedTitle, "New chat");
  saved.resolve();
  await retained;
  assert.equal(persistedTitle, "Plan a garden");
  assert.equal(sidebarTitle, "New chat");
  assert.deepEqual(events, ["data-chat-title-pending"]);

  context.mock.timers.tick(500);
  await flush();
  assert.equal(sidebarTitle, "Plan a garden");
  assert.equal(reads, 3);
  context.mock.timers.tick(30_000);
  await flush();
  assert.equal(reads, 3);
});

test("legacy placeholders and another chat's pending event do not start polling", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const reconciler = createChatTitleReconciler({
    chatId,
    revalidateHistory: () => assert.fail("legacy history must not poll"),
  });
  context.after(() => reconciler.dispose());
  reconciler.responseSettled(finishedMessages);
  reconciler.markPending({ ...pendingTitle, chatId: "another-chat" });
  reconciler.responseSettled(finishedMessages);
  context.mock.timers.tick(60_000);
  await flush();
});

test("the reconciliation window starts after the response, not while it streams", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let reads = 0;
  const reconciler = createChatTitleReconciler({
    chatId,
    revalidateHistory: () => {
      reads += 1;
      return Promise.resolve(history("Already persisted"));
    },
  });
  context.after(() => reconciler.dispose());
  reconciler.markPending(pendingTitle);
  context.mock.timers.tick(60_000);
  await flush();
  assert.equal(reads, 0);
  reconciler.responseSettled(finishedMessages);
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 1);
  context.mock.timers.tick(60_000);
  await flush();
  assert.equal(reads, 1);
});

test("a stale SDK completion cannot start the newly mounted chat's retry window", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let reads = 0;
  const reconciler = createChatTitleReconciler({
    chatId,
    revalidateHistory: () => {
      reads += 1;
      return Promise.resolve(history("Current title"));
    },
  });
  context.after(() => reconciler.dispose());
  reconciler.markPending(pendingTitle);
  reconciler.responseSettled([{ id: "previous-chat-message" }]);
  context.mock.timers.tick(60_000);
  await flush();
  assert.equal(reads, 0);
  reconciler.responseSettled(finishedMessages);
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 1);
});

test("reconciliation checks the pending chat across history pages, not another row's title", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let title = "New chat";
  let reads = 0;
  const reconciler = createChatTitleReconciler({
    chatId,
    revalidateHistory: () => {
      reads += 1;
      return Promise.resolve([
        { chats: [{ id: "other-chat", title: "Unrelated title" }] },
        ...history(title),
      ]);
    },
  });
  context.after(() => reconciler.dispose());
  reconciler.markPending(pendingTitle);
  reconciler.responseSettled(finishedMessages);
  context.mock.timers.tick(1000);
  await flush();
  title = "New title";
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 2);
  context.mock.timers.tick(60_000);
  await flush();
  assert.equal(reads, 2);
});

for (const result of ["placeholder", "missing", "unmounted-history", "error"]) {
  test(`${result} history stops within ten seconds and duplicate signals do not restart it`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let reads = 0;
    const reconciler = createChatTitleReconciler({
      chatId,
      revalidateHistory: () => {
        reads += 1;
        if (result === "error") {
          return Promise.reject(new Error("unavailable"));
        }
        return Promise.resolve(
          result === "missing"
            ? []
            : result === "unmounted-history"
              ? undefined
              : history("New chat")
        );
      },
    });
    context.after(() => reconciler.dispose());
    reconciler.markPending(pendingTitle);
    reconciler.responseSettled(finishedMessages);
    for (let second = 0; second < 30; second += 1) {
      context.mock.timers.tick(1000);
      // biome-ignore lint/performance/noAwaitInLoops: Each simulated second must settle before the next tick.
      await flush();
      reconciler.markPending(pendingTitle);
      reconciler.responseSettled(finishedMessages);
    }
    assert.equal(reads, 9);
  });
}

for (const inFlight of [false, true]) {
  test(`unmount/navigation cancels ${inFlight ? "in-flight follow-ups" : "scheduled retries"}`, async (context) => {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const response = deferred<ReturnType<typeof history>>();
    let reads = 0;
    const reconciler = createChatTitleReconciler({
      chatId,
      revalidateHistory: () => {
        reads += 1;
        return response.promise;
      },
    });
    reconciler.markPending(pendingTitle);
    reconciler.responseSettled(finishedMessages);
    if (inFlight) {
      context.mock.timers.tick(1000);
      await flush();
    }
    reconciler.dispose();
    response.resolve(history("New chat"));
    await flush();
    reconciler.markPending(pendingTitle);
    reconciler.responseSettled(finishedMessages);
    context.mock.timers.tick(60_000);
    await flush();
    assert.equal(reads, inFlight ? 1 : 0);
  });
}

test("a hung history request cannot extend the retry deadline or overlap requests", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const response = deferred<ReturnType<typeof history>>();
  let reads = 0;
  const reconciler = createChatTitleReconciler({
    chatId,
    revalidateHistory: () => {
      reads += 1;
      return response.promise;
    },
  });
  context.after(() => reconciler.dispose());
  reconciler.markPending(pendingTitle);
  reconciler.responseSettled(finishedMessages);
  context.mock.timers.tick(1000);
  await flush();
  context.mock.timers.tick(20_000);
  await flush();
  assert.equal(reads, 1);
  response.resolve(history("New chat"));
  await flush();
  context.mock.timers.tick(20_000);
  await flush();
  assert.equal(reads, 1);
});

test("reconciliation releases its owner once, including later disposal", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let completed = 0;
  const reconciler = createChatTitleReconciler({
    chatId,
    onComplete: () => {
      completed += 1;
    },
    revalidateHistory: () => Promise.resolve(history("Plan a garden")),
  });
  reconciler.markPending(pendingTitle);
  reconciler.responseSettled(finishedMessages);
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(completed, 1);
  reconciler.dispose();
  assert.equal(completed, 1);
});

test("a provider-owned manager retains an earlier chat and correlates each completion", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let title = "New chat";
  let reads = 0;
  const manager = createChatTitleReconciliationManager({
    revalidateHistory: () => {
      reads += 1;
      return Promise.resolve(history(title));
    },
  });
  context.after(() => manager.dispose());
  manager.markPending(pendingTitle);
  manager.responseSettled(finishedMessages);
  manager.markPending({ chatId: "next-chat", messageId: "next-message" });
  manager.responseSettled([{ id: "unrelated-completion" }]);
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 1);
  title = "Plan a garden";
  context.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 2);
  context.mock.timers.tick(20_000);
  await flush();
  assert.equal(reads, 2);
  manager.responseSettled([{ id: "next-message" }]);
  manager.dispose();
  context.mock.timers.tick(20_000);
  await flush();
  assert.equal(reads, 2);
});

test("the cloud route and provider-lifetime UI wire pending titles without changing legacy title events", () => {
  const route = readFileSync(
    new URL("../app/(chat)/api/chat/route.ts", import.meta.url),
    "utf8"
  );
  const ui = readFileSync(
    new URL("../hooks/use-active-chat.tsx", import.meta.url),
    "utf8"
  );
  assert.match(
    route,
    /if \(shouldGenerateTitle && message\) \{[\s\S]*?data: \{ chatId: id, messageId: message.id \},[\s\S]*?transient: true,[\s\S]*?type: "data-chat-title-pending"/u
  );
  assert.match(route, /data: title, type: "data-chat-title"/u);
  assert.match(ui, /createChatTitleReconciliationManager\(/u);
  assert.match(
    ui,
    /titleReconcilerRef\.current = null;[\s\S]*?\}, \[mutate\]\)/u
  );
  assert.match(
    ui,
    /revalidateHistory: \(\) =>[\s\S]*?mutate[\s\S]*?unstable_serialize\(getChatHistoryPaginationKey\)/u
  );
  assert.match(
    ui,
    /titleReconcilerRef\.current\?\.markPending\(dataPart\.data\)/u
  );
  assert.match(
    ui,
    /onFinish: \(\{ messages: finishedMessages \}\) => \{[\s\S]*?titleReconcilerRef\.current\?\.responseSettled\(finishedMessages\)/u
  );
  assert.match(ui, /return \(\) => \{[\s\S]*?reconciler\.dispose\(\)/u);
});
