import assert from "node:assert/strict";
import test from "node:test";
import {
  LineAssembler,
  MalformedHarnessEventError,
  normalizeCopilotEvent,
  normalizeEvent,
} from "./events";

const AT = "2026-08-20T17:00:00.000Z";

function one(line: string) {
  const events = normalizeCopilotEvent(line, AT);
  assert.equal(events.length, 1, `expected exactly one event from ${line}`);
  return events[0];
}

test("drops non-JSON chrome instead of surfacing it as an event", () => {
  assert.deepEqual(normalizeCopilotEvent("Run 'copilot update'", AT), []);
  assert.deepEqual(normalizeCopilotEvent("", AT), []);
});

test("drops unknown event types rather than guessing a rendering", () => {
  const line = JSON.stringify({
    data: { anything: true },
    type: "session.some_future_event",
  });
  assert.deepEqual(normalizeCopilotEvent(line, AT), []);
});

test("translates streamed assistant text", () => {
  const event = one(
    JSON.stringify({
      data: { deltaContent: "co", messageId: "m1" },
      timestamp: AT,
      type: "assistant.message_delta",
    })
  );
  assert.deepEqual(event, { at: AT, kind: "delta", text: "co" });
});

test("carries the model on a completed message", () => {
  const event = one(
    JSON.stringify({
      data: { content: "coven online", model: "claude-sonnet-5" },
      timestamp: AT,
      type: "assistant.message",
    })
  );
  assert.deepEqual(event, {
    at: AT,
    kind: "message",
    model: "claude-sonnet-5",
    text: "coven online",
  });
});

test("summarizes a tool call by the argument that identifies the work", () => {
  const event = one(
    JSON.stringify({
      data: {
        arguments: { file_text: "hello", path: "/tmp/notes.md" },
        toolCallId: "toolu_1",
        toolName: "create",
      },
      timestamp: AT,
      type: "tool.execution_start",
    })
  );
  assert.deepEqual(event, {
    at: AT,
    callId: "toolu_1",
    kind: "tool-start",
    summary: "create /tmp/notes.md",
    tool: "create",
  });
});

test("falls back to the bare tool name when no identifying argument exists", () => {
  const event = one(
    JSON.stringify({
      data: {
        arguments: { verbose: true },
        toolCallId: "t2",
        toolName: "think",
      },
      type: "tool.execution_start",
    })
  );
  assert.equal(event.kind === "tool-start" && event.summary, "think");
});

test("clamps a long tool summary so one call cannot flood the console", () => {
  const event = one(
    JSON.stringify({
      data: {
        arguments: { command: "x".repeat(500) },
        toolCallId: "t3",
        toolName: "bash",
      },
      type: "tool.execution_start",
    })
  );
  assert.equal(
    event.kind === "tool-start" && event.summary.length <= 160,
    true
  );
  assert.equal(
    event.kind === "tool-start" && event.summary.endsWith("…"),
    true
  );
});

test("treats a missing success flag as success but honours an explicit false", () => {
  const succeeded = one(
    JSON.stringify({
      data: { result: { content: "done" }, toolCallId: "t4" },
      type: "tool.execution_complete",
    })
  );
  const failed = one(
    JSON.stringify({
      data: { result: { content: "bad" }, success: false, toolCallId: "t5" },
      type: "tool.execution_complete",
    })
  );
  assert.equal(succeeded.kind === "tool-end" && succeeded.success, true);
  assert.equal(failed.kind === "tool-end" && failed.success, false);
});

test("maps file lifecycle notices and ignores unrelated session info", () => {
  const created = one(
    JSON.stringify({
      data: { infoType: "file_created", message: "/tmp/notes.md" },
      type: "session.info",
    })
  );
  assert.deepEqual(created, {
    at: AT,
    kind: "file",
    operation: "created",
    path: "/tmp/notes.md",
  });
  assert.deepEqual(
    normalizeCopilotEvent(
      JSON.stringify({
        data: { infoType: "context_compacted", message: "…" },
        type: "session.info",
      }),
      AT
    ),
    []
  );
});

test("a result yields usage and a terminal frame", () => {
  const events = normalizeCopilotEvent(
    JSON.stringify({
      exitCode: 0,
      sessionId: "sess-1",
      timestamp: AT,
      type: "result",
      usage: {
        codeChanges: {
          filesModified: ["/tmp/notes.md"],
          linesAdded: 1,
          linesRemoved: 0,
        },
        premiumRequests: 1,
      },
    }),
    AT
  );
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], {
    at: AT,
    exitCode: 0,
    filesModified: ["/tmp/notes.md"],
    kind: "finished",
    sessionId: "sess-1",
    status: "completed",
  });
});

test("a non-zero exit is reported as failed", () => {
  const events = normalizeCopilotEvent(
    JSON.stringify({ exitCode: 1, type: "result" }),
    AT
  );
  const finished = events.at(-1);
  assert.equal(finished?.kind === "finished" && finished.status, "failed");
});

test("rejects malformed nested structured result values", () => {
  for (const usage of [
    [42],
    { codeChanges: [] },
    { codeChanges: { filesModified: [42] } },
    { codeChanges: { filesModified: "not-an-array" } },
  ]) {
    assert.throws(
      () =>
        normalizeCopilotEvent(
          JSON.stringify({ exitCode: 0, type: "result", usage }),
          AT
        ),
      MalformedHarnessEventError
    );
  }
});

test("harnesses without a translation emit nothing rather than invented detail", () => {
  const line = JSON.stringify({
    data: { content: "hi" },
    type: "assistant.message",
  });
  assert.equal(normalizeEvent("copilot", line, AT).length, 1);
  assert.deepEqual(normalizeEvent("codex", line, AT), []);
  assert.deepEqual(normalizeEvent("claude", line, AT), []);
});

test("reassembles a JSON object split across chunk boundaries", () => {
  const assembler = new LineAssembler();
  const line = JSON.stringify({
    data: { content: "split", model: "m" },
    type: "assistant.message",
  });
  const cut = Math.floor(line.length / 2);

  assert.deepEqual(assembler.push(line.slice(0, cut)), []);
  const completed = assembler.push(`${line.slice(cut)}\n`);
  assert.deepEqual(completed, [line]);

  const events = normalizeCopilotEvent(completed[0] ?? "", AT);
  assert.equal(events[0]?.kind === "message" && events[0].text, "split");
});

test("flush releases a trailing line that never got its newline", () => {
  const assembler = new LineAssembler();
  assert.deepEqual(assembler.push('{"type":"a"}\n{"type":"b"}'), [
    '{"type":"a"}',
  ]);
  assert.deepEqual(assembler.flush(), ['{"type":"b"}']);
  assert.deepEqual(assembler.flush(), []);
});

test("Copilot tool-only assistant messages with empty content emit no text", () => {
  assert.deepEqual(
    normalizeCopilotEvent(
      JSON.stringify({
        data: { content: "", toolRequests: [] },
        type: "assistant.message",
      }),
      new Date(0).toISOString()
    ),
    []
  );
});

test("a missing-tool refusal is marked as not executed, unlike an ordinary tool failure", () => {
  const frame = (message: string) =>
    normalizeCopilotEvent(
      JSON.stringify({
        data: {
          error: { code: "failure", message },
          success: false,
          toolCallId: "denied",
        },
        type: "tool.execution_complete",
      }),
      new Date(0).toISOString()
    );
  assert.equal(
    (frame("Tool 'bash' does not exist.")[0] as { executionDenied?: boolean })
      .executionDenied,
    true
  );
  assert.equal(
    (frame("command exited with code 1")[0] as { executionDenied?: boolean })
      .executionDenied,
    undefined
  );
});

test("snapshot CLI JSON-encoded tool arguments normalize but malformed arguments refuse", () => {
  const event = (args: unknown) =>
    normalizeCopilotEvent(
      JSON.stringify({
        data: { arguments: args, toolCallId: "read", toolName: "view" },
        type: "tool.execution_start",
      }),
      new Date(0).toISOString()
    );
  assert.equal(
    (event(JSON.stringify({ path: "inside.txt" }))[0] as { summary: string })
      .summary,
    "view inside.txt"
  );
  assert.throws(() => event("not-json"));
  assert.throws(() => event("[]"));
});
