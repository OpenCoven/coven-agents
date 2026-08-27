import assert from "node:assert/strict";
import test from "node:test";
import {
  type ChatActionDependencies,
  deleteTrailingMessagesForSession,
  updateChatVisibilityForSession,
} from "@/lib/auth/chat-actions";

const session = {
  user: {
    authVersion: 4,
    id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    type: "subscriber" as const,
  },
};

function deniedDependencies(calls: string[]): ChatActionDependencies {
  return {
    authorize: () => {
      calls.push("authorize");
      return Promise.resolve({ kind: "subscription_required" });
    },
    deleteMessages: (() => {
      calls.push("delete");
      return Promise.resolve();
    }) as unknown as ChatActionDependencies["deleteMessages"],
    getChat: () => {
      calls.push("chat");
      return Promise.resolve(null);
    },
    getMessage: () => {
      calls.push("message");
      return Promise.resolve([]);
    },
    updateVisibility: (() => {
      calls.push("update");
      return Promise.resolve();
    }) as unknown as ChatActionDependencies["updateVisibility"],
  };
}

test("lapsed chat deletion is denied before any database read or mutation", async () => {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      deleteTrailingMessagesForSession(
        { id: "message-1" },
        session,
        deniedDependencies(calls)
      ),
    /subscription required/i
  );

  assert.deepEqual(calls, ["authorize"]);
});

test("lapsed chat visibility updates are denied before any database read or mutation", async () => {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      updateChatVisibilityForSession(
        { chatId: "chat-1", visibility: "private" },
        session,
        deniedDependencies(calls)
      ),
    /subscription required/i
  );

  assert.deepEqual(calls, ["authorize"]);
});
