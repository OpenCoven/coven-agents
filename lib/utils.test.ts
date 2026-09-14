import assert from "node:assert/strict";
import test from "node:test";
import { ChatbotError } from "./errors";
import { fetcher, fetchWithErrorHandlers } from "./utils";

test("chat transports preserve reauthentication errors from flat API 401 envelopes", async (context) => {
  context.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }))
  );
  await Promise.all(
    [fetcher, fetchWithErrorHandlers].map((request) =>
      assert.rejects(
        request("/api/messages"),
        (error: unknown) =>
          error instanceof ChatbotError &&
          error.type === "unauthorized" &&
          error.surface === "auth"
      )
    )
  );
});

test("chat transport outages retain their original error code", async (context) => {
  context.mock.method(globalThis, "fetch", () =>
    Promise.resolve(Response.json({ code: "offline:chat" }, { status: 503 }))
  );
  await assert.rejects(
    fetchWithErrorHandlers("/api/chat"),
    (error: unknown) =>
      error instanceof ChatbotError && error.type === "offline"
  );
});
