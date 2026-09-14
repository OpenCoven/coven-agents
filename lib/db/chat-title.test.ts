import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createUIMessageStream } from "ai";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pg-proxy";
import { scheduleChatTitle } from "@/lib/ai/chat-title-stream";
import { generateTitleFromUserMessageInternal } from "@/lib/ai/title";
import { automaticChatTitleWhere } from "./chat-title";
import { db, updateChatTitleById } from "./queries";
import { chat } from "./schema";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("automatic write compares chat identity, user authority and unchanged placeholder atomically", () => {
  const query = new QueryBuilder()
    .select({ title: chat.title })
    .from(chat)
    .where(automaticChatTitleWhere({ chatId: "chat-1", userId: "user-1" }))
    .toSQL();
  assert.match(query.sql, /"Chat"\."id" = \$1/u);
  assert.match(query.sql, /"Chat"\."userId" = \$2/u);
  assert.match(query.sql, /"Chat"\."title" = \$3/u);
  assert.deepEqual(query.params, ["chat-1", "user-1", "New chat"]);
});

test("the actual update returns no row for stale, deleted, or wrong-owner writes", async (context) => {
  let current: { title: string; userId: string } | null = {
    title: "New chat",
    userId: "user-1",
  };
  const remote = drizzle((sql, params) => {
    assert.match(sql, /^update "Chat" set "title" = \$1 where/u);
    assert.match(sql, /"Chat"\."id" = \$2/u);
    assert.match(sql, /"Chat"\."userId" = \$3/u);
    assert.match(sql, /"Chat"\."title" = \$4/u);
    assert.match(sql, /returning "title"$/u);
    assert.equal(params[1], "chat-1");
    assert.equal(params[3], "New chat");
    if (current?.userId !== params[2] || current?.title !== params[3]) {
      return Promise.resolve({ rows: [] });
    }
    current.title = String(params[0]);
    return Promise.resolve({ rows: [[current.title]] });
  });
  context.mock.method(db, "update", remote.update.bind(remote));
  const input = {
    chatId: "chat-1",
    title: "First automatic title",
    userId: "user-1",
  };
  assert.deepEqual(await updateChatTitleById(input), { title: input.title });
  assert.equal(
    await updateChatTitleById({ ...input, title: "Stale automatic title" }),
    null
  );
  current = { title: "Manually selected title", userId: "user-1" };
  assert.equal(await updateChatTitleById(input), null);
  current = { title: "New chat", userId: "another-user" };
  assert.equal(await updateChatTitleById(input), null);
  current = null;
  assert.equal(await updateChatTitleById(input), null);
});

test("the actual title query propagates persistence failures and does not rearm the placeholder", async (context) => {
  let writes = 0;
  const remote = drizzle(() => {
    writes += 1;
    return Promise.reject(new Error("database unavailable"));
  });
  context.mock.method(db, "update", remote.update.bind(remote));
  const input = { chatId: "chat-1", title: "New chat", userId: "user-1" };
  assert.equal(await updateChatTitleById(input), null);
  assert.equal(writes, 0);
  await assert.rejects(updateChatTitleById({ ...input, title: "Candidate" }));
  assert.equal(writes, 1);
});

test("actual title writer uses the atomic guard and returns durable title without swallowing failures", () => {
  const source = readFileSync(new URL("./queries.ts", import.meta.url), "utf8");
  const writer = source.slice(
    source.indexOf("export async function updateChatTitleById("),
    source.indexOf("export async function getMessageCountByUserId(")
  );
  assert.match(
    writer,
    /\.where\(automaticChatTitleWhere\(\{ chatId, userId \}\)\)/u
  );
  assert.match(writer, /\.returning\(\{ title: chat\.title \}\)/u);
  assert.doesNotMatch(writer, /catch/u);
  assert.match(writer, /title === DEFAULT_CHAT_TITLE/u);
});

test("model failure flows through the actual fallback and durable writer before a legacy title event", async (context) => {
  const acknowledgement = deferred<{ rows: string[][] }>();
  const writeStarted = deferred<void>();
  const reports: string[] = [];
  let retained: Promise<void> | undefined;
  let finishMain!: () => void;
  const remote = drizzle((_sql, params) => {
    assert.deepEqual(params, ["Plan a garden", "chat-1", "user-1", "New chat"]);
    writeStarted.resolve();
    return acknowledgement.promise;
  });
  context.mock.method(db, "update", remote.update.bind(remote));
  const stream = createUIMessageStream({
    execute({ writer }) {
      writer.merge(
        new ReadableStream({
          start(controller) {
            controller.enqueue({ data: "response", type: "data-main" });
            finishMain = () => controller.close();
          },
        })
      );
      scheduleChatTitle({
        emit: (title) => writer.write({ data: title, type: "data-chat-title" }),
        generate: () =>
          generateTitleFromUserMessageInternal(
            {
              message: {
                id: "message-1",
                parts: [{ text: "Plan a garden", type: "text" }],
                role: "user",
              },
            },
            {
              generate: () =>
                Promise.reject(new Error("sensitive model details")),
              report: (reason) => reports.push(reason),
            }
          ),
        persist: (title) =>
          updateChatTitleById({ chatId: "chat-1", title, userId: "user-1" }),
        report: (reason) => reports.push(reason),
        waitUntil: (task) => {
          retained = task;
        },
      });
    },
  });
  const reader = stream.getReader();
  assert.equal((await reader.read()).value?.type, "data-main");
  await writeStarted.promise;
  acknowledgement.resolve({ rows: [["Plan a garden"]] });
  await retained;
  assert.deepEqual((await reader.read()).value, {
    data: "Plan a garden",
    type: "data-chat-title",
  });
  finishMain();
  assert.equal((await reader.read()).done, true);
  assert.deepEqual(reports, ["generation_failed"]);
});
