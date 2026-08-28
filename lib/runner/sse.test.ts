import assert from "node:assert/strict";
import test from "node:test";
import type { RunEvent } from "@opencoven/agent-contracts";
import { createRunEventStream } from "./sse";

const createdAt = "2026-08-20T20:00:00.000Z";

function event(id: number): RunEvent {
  return { at: createdAt, id, output: `event ${id}`, type: "output" };
}

function terminalEvent(id: number): RunEvent {
  return { id, status: "cancelled", type: "status" };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const read = async (result: string): Promise<string> => {
    const chunk = await reader.read();
    if (chunk.done) {
      return result;
    }
    return read(result + decoder.decode(chunk.value, { stream: true }));
  };
  return read("");
}

test("resumes after an event ID, orders delivery, formats SSE, and avoids duplicates", async () => {
  const cursors: number[] = [];
  const payload = await readAll(
    createRunEventStream({
      lastEventId: 1,
      read: (afterEventId) => {
        cursors.push(afterEventId);
        return Promise.resolve({
          events: [event(3), event(1), event(2), event(3)],
          terminal: true,
        });
      },
    })
  );

  assert.deepEqual(cursors, [1]);
  assert.deepEqual(
    [...payload.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1])),
    [2, 3]
  );
  assert.ok(
    payload.includes(
      'id: 2\nevent: output\ndata: {"at":"2026-08-20T20:00:00.000Z","id":2,"output":"event 2","type":"output"}\n\n'
    )
  );
});

test("delivers a retained terminal event before closing a stale resume", async () => {
  const reader = createRunEventStream({
    lastEventId: 1,
    read: async () => ({
      events: [event(8), event(7), event(8), terminalEvent(9)],
      terminal: true,
    }),
  }).getReader();
  const decoder = new TextDecoder();
  const chunks = [
    decoder.decode((await reader.read()).value),
    decoder.decode((await reader.read()).value),
    decoder.decode((await reader.read()).value),
  ];

  assert.deepEqual(
    chunks.flatMap((chunk) =>
      [...chunk.matchAll(/^id: (\d+)$/gmu)].map((match) => Number(match[1]))
    ),
    [7, 8, 9]
  );
  assert.match(chunks[2] as string, /event: status/u);
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
});

test("limits slow-consumer buffering to one event per pull", async () => {
  let serialized = 0;
  const trackedEvent = (id: number): RunEvent =>
    ({
      at: createdAt,
      id,
      get output() {
        serialized += 1;
        return `event ${id}`;
      },
      type: "output",
    }) as RunEvent;
  const stream = createRunEventStream({
    lastEventId: 0,
    read: async () => ({
      events: [trackedEvent(1), trackedEvent(2), trackedEvent(3)],
      terminal: true,
    }),
  });
  const reader = stream.getReader();
  let closed = false;
  const closeObserver = reader.closed.then(() => {
    closed = true;
  });

  assert.match(new TextDecoder().decode((await reader.read()).value), /id: 1/u);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(serialized, 2);
  assert.equal(closed, false);
  assert.match(new TextDecoder().decode((await reader.read()).value), /id: 2/u);
  assert.match(new TextDecoder().decode((await reader.read()).value), /id: 3/u);
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
  await closeObserver;
});

test("keeps polling for later events and closes after a terminal snapshot", async () => {
  const nextPoll = deferred();
  let terminal = false;
  const events = [event(1)];
  const stream = createRunEventStream({
    lastEventId: 0,
    read: async (afterEventId) => ({
      events: events.filter((current) => current.id > afterEventId),
      terminal,
    }),
    sleep: async () => nextPoll.promise,
  });
  const reader = stream.getReader();

  const initial = await reader.read();
  assert.match(new TextDecoder().decode(initial.value), /id: 1/u);

  events.push(event(2));
  terminal = true;
  nextPoll.resolve();

  const final = await reader.read();
  assert.match(new TextDecoder().decode(final.value), /id: 2/u);
  assert.deepEqual(await reader.read(), { done: true, value: undefined });
});

test("closes after the configured idle period without waiting for wall-clock time", async () => {
  let now = 0;
  let reads = 0;
  const sleeps: number[] = [];
  const payload = await readAll(
    createRunEventStream({
      idleTimeoutMs: 2500,
      lastEventId: 0,
      now: () => now,
      read: () => {
        reads += 1;
        return Promise.resolve({ events: [], terminal: false });
      },
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
    })
  );

  assert.equal(payload, "");
  assert.equal(reads, 4);
  assert.deepEqual(sleeps, [1000, 1000, 500]);
});

test("closes and cleans up when the request is aborted", async () => {
  const controller = new AbortController();
  const sleeping = deferred();
  const stream = createRunEventStream({
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

test("cancelling aborts an in-flight injected sleep", async () => {
  const sleeping = deferred();
  let sleepSignal: AbortSignal | undefined;
  const stream = createRunEventStream({
    lastEventId: 0,
    read: async () => ({ events: [], terminal: false }),
    sleep: async (_milliseconds, signal) => {
      sleepSignal = signal;
      signal?.addEventListener("abort", sleeping.resolve, { once: true });
      await sleeping.promise;
    },
  });
  const reader = stream.getReader();
  const reading = reader.read();

  await Promise.resolve();
  await Promise.resolve();
  await reader.cancel();

  assert.ok(sleepSignal?.aborted);
  assert.deepEqual(await reading, { done: true, value: undefined });
});
