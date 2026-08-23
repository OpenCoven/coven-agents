import assert from "node:assert/strict";
import test from "node:test";
import type { RunEvent } from "@opencoven/agent-contracts";
import { createRunEventStream } from "./sse.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function decode(chunk: Uint8Array | undefined): string {
  return new TextDecoder().decode(chunk);
}

test("keeps a cloud event stream open for deterministic future delivery and closes on terminal state", async () => {
  const runId = "3a3f2c72-9b1b-47f7-8c83-28d5f94bf4ce";
  const events: RunEvent[] = [
    {
      at: "2026-08-20T20:00:00.000Z",
      id: 1,
      operationId: "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
      runId,
      type: "accepted",
    },
  ];
  const nextPoll = deferred();
  let terminal = false;
  const stream = createRunEventStream({
    idleTimeoutMs: 10_000,
    lastEventId: 0,
    read: async (cursor) => ({
      events: events.filter((event) => event.id > cursor),
      terminal,
    }),
    sleep: async () => nextPoll.promise,
  });
  const reader = stream.getReader();

  const initial = await reader.read();
  assert.match(decode(initial.value), /id: 1\nevent: accepted/);

  events.push({
    at: "2026-08-20T20:00:01.000Z",
    id: 2,
    status: "completed",
    type: "status",
  });
  terminal = true;
  nextPoll.resolve();

  const future = await reader.read();
  assert.match(decode(future.value), /id: 2\nevent: status/);
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
});

test("closes a cloud event stream when its request is aborted", async () => {
  const controller = new AbortController();
  const sleeping = deferred();
  const stream = createRunEventStream({
    idleTimeoutMs: 10_000,
    lastEventId: 0,
    read: async () => ({ events: [], terminal: false }),
    signal: controller.signal,
    sleep: async (_milliseconds, signal) => {
      signal?.addEventListener("abort", sleeping.resolve, { once: true });
      await sleeping.promise;
    },
  });
  const reader = stream.getReader();

  controller.abort();

  assert.deepEqual(await reader.read(), { done: true, value: undefined });
});
