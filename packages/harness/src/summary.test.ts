import assert from "node:assert/strict";
import test from "node:test";
import type { RunEvent } from "./schema";
import { summarizeRun } from "./summary";

const AT = "2026-08-20T17:00:00.000Z";

test("messages win over deltas so the reply is not duplicated", () => {
  const events: RunEvent[] = [
    { at: AT, kind: "delta", text: "Hel" },
    { at: AT, kind: "delta", text: "lo" },
    { at: AT, kind: "message", model: "gpt-5", text: "Hello" },
  ];
  assert.equal(summarizeRun(events).output, "Hello");
});

test("deltas are used when the harness never emits a whole message", () => {
  const events: RunEvent[] = [
    { at: AT, kind: "delta", text: "par" },
    { at: AT, kind: "delta", text: "tial" },
  ];
  assert.equal(summarizeRun(events).output, "partial");
});

test("a tool result inherits the summary from its start frame", () => {
  const events: RunEvent[] = [
    {
      at: AT,
      callId: "c1",
      kind: "tool-start",
      summary: "bash ls -a",
      tool: "bash",
    },
    { at: AT, callId: "c1", kind: "tool-end", success: true, summary: "a b" },
  ];
  assert.deepEqual(summarizeRun(events).toolCalls, [
    { success: true, summary: "bash ls -a", tool: "bash" },
  ]);
});

test("the finish frame decides the run status", () => {
  const failed: RunEvent[] = [
    {
      at: AT,
      exitCode: 1,
      filesModified: [],
      kind: "finished",
      sessionId: "s1",
      status: "failed",
    },
  ];
  const summary = summarizeRun(failed);
  assert.equal(summary.status, "failed");
  assert.equal(summary.sessionId, "s1");
});

test("an error frame fails a run that never reported a finish frame", () => {
  const summary = summarizeRun([
    { at: AT, kind: "error", message: "harness crashed" },
  ]);
  assert.equal(summary.status, "failed");
  assert.ok(summary.output.includes("harness crashed"));
});

test("file operations are collected in order", () => {
  const summary = summarizeRun([
    { at: AT, kind: "file", operation: "created", path: "a.md" },
    { at: AT, kind: "file", operation: "edited", path: "b.md" },
  ]);
  assert.deepEqual(summary.fileOperations, [
    { operation: "created", path: "a.md" },
    { operation: "edited", path: "b.md" },
  ]);
});
