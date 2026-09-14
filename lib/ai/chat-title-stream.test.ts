import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createUIMessageStream } from "ai";
import { scheduleChatTitle } from "./chat-title-stream";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("only a successfully persisted title is emitted, after the durable write", async () => {
  const saved = deferred<{ title: string } | null>();
  const calls: string[] = [];
  let task: Promise<void> | undefined;
  scheduleChatTitle({
    emit: (title) => calls.push(`emit:${title}`),
    generate: () => Promise.resolve("Candidate"),
    persist: (title) => {
      calls.push(`persist:${title}`);
      return saved.promise;
    },
    report: () => assert.fail("unexpected failure"),
    waitUntil: (pending) => {
      task = pending;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls, ["persist:Candidate"]);
  saved.resolve({ title: "Durable title" });
  await task;
  assert.deepEqual(calls, ["persist:Candidate", "emit:Durable title"]);
});

for (const stale of [true, false]) {
  test(`${stale ? "stale writer" : "persistence failure"} produces no committed event`, async () => {
    const reports: string[] = [];
    let task: Promise<void> | undefined;
    scheduleChatTitle({
      emit: () => assert.fail("uncommitted title was emitted"),
      generate: () => Promise.resolve("Candidate"),
      persist: () =>
        stale
          ? Promise.resolve(null)
          : Promise.reject(new Error("private DB details")),
      report: (reason) => reports.push(reason),
      waitUntil: (pending) => {
        task = pending;
      },
    });
    await task;
    assert.deepEqual(reports, stale ? [] : ["persistence_failed"]);
  });
}

test("main response does not wait for a pending durable write", async () => {
  const saved = deferred<{ title: string } | null>();
  let retained: Promise<void> | undefined;
  const stream = createUIMessageStream({
    execute({ writer }) {
      writer.write({ data: "response", type: "data-main" });
      scheduleChatTitle({
        emit: () => assert.fail("failed write cannot emit"),
        generate: () => Promise.resolve("Candidate"),
        persist: () => saved.promise,
        report: () => assert.fail("unexpected failure"),
        waitUntil: (task) => {
          retained = task;
        },
      });
    },
  });
  const reader = stream.getReader();
  assert.equal((await reader.read()).value?.type, "data-main");
  assert.equal((await reader.read()).done, true);
  saved.resolve(null);
  await retained;
});

test("main response completes while title generation is pending and retained", async () => {
  const generated = deferred<string>();
  let retained: Promise<void> | undefined;
  let persisted = false;
  const stream = createUIMessageStream({
    execute({ writer }) {
      writer.write({ data: "response", type: "data-main" });
      scheduleChatTitle({
        emit: (title) => writer.write({ data: title, type: "data-chat-title" }),
        generate: () => generated.promise,
        persist: (title) => {
          persisted = true;
          return Promise.resolve({ title });
        },
        report: () => assert.fail("unexpected failure"),
        waitUntil: (task) => {
          retained = task;
        },
      });
    },
  });
  const reader = stream.getReader();
  assert.equal((await reader.read()).value?.type, "data-main");
  assert.equal((await reader.read()).done, true);
  assert.equal(persisted, false);
  assert.ok(retained);
  generated.resolve("A late title");
  await retained;
  assert.equal(persisted, true);
});

test("the production route retains title work without awaiting stream execute", () => {
  const route = readFileSync(
    new URL("../../app/(chat)/api/chat/route.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(route, /titlePromise|await scheduleChatTitle/u);
  assert.match(route, /scheduleChatTitle\(/u);
  assert.match(route, /waitUntil: after/u);
  assert.ok(
    route.indexOf("dataStream.merge(") < route.indexOf("scheduleChatTitle({")
  );
});

test("unexpected title failures are logged as fixed codes without leaking error details", async (context) => {
  const logs: unknown[][] = [];
  let retained: Promise<void> | undefined;
  context.mock.method(console, "warn", (...args: unknown[]) => logs.push(args));
  scheduleChatTitle({
    emit: () => assert.fail("failed generation cannot emit"),
    generate: () => {
      throw new Error("sensitive generation details");
    },
    persist: () => assert.fail("failed generation cannot persist"),
    waitUntil: (task) => {
      retained = task;
    },
  });
  await retained;
  assert.deepEqual(logs, [["[chat-title]", "generation_failed"]]);
});
