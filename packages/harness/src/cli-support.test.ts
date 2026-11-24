import assert from "node:assert/strict";
import test from "node:test";
import { MalformedHarnessEventError, normalizeEvent } from "./events";
import { buildInvocation } from "./invocation";
import { harnessSpec, isRunnableHarness } from "./registry";
import { runEventSchema } from "./schema";

const AT = "2026-11-22T12:00:00.000Z";
const frame = (harness: "codex" | "claude", value: unknown) => {
  const events = normalizeEvent(harness, JSON.stringify(value), AT);
  for (const event of events) {
    assert.ok(runEventSchema.safeParse(event).success);
  }
  return events;
};
for (const harness of ["codex", "claude"] as const) {
  test(`CLI support: ${harness} is runnable and emits structured arguments`, () => {
    assert.equal(isRunnableHarness(harness), true);
    assert.equal(harnessSpec(harness)?.streams, true);
    const input = {
      cwd: "/workspace",
      harness,
      instructions: "Synthetic instructions",
      model: "auto",
      stream: true,
      task: "Synthetic task",
    };
    const invocation = buildInvocation(input);
    assert.equal(invocation.command, harness);
    if (harness === "codex") {
      assert.ok(invocation.args.includes("--json"));
    } else {
      assert.ok(invocation.args.includes("stream-json"));
      assert.ok(invocation.args.includes("--verbose"));
    }
    for (const permissionMode of [
      "github_only",
      "workspace_read",
      "workspace_write",
    ] as const) {
      assert.throws(
        () => buildInvocation({ ...input, permissionMode }),
        /cannot enforce/
      );
    }
  });
  test(`CLI support: ${harness} malformed known messages refuse and unknown events drop`, () => {
    assert.deepEqual(normalizeEvent(harness, "ordinary CLI chrome", AT), []);
    assert.deepEqual(frame(harness, { type: "future.vendor.event" }), []);
    assert.throws(
      () =>
        frame(
          harness,
          harness === "codex"
            ? {
                item: { text: 3, type: "agent_message" },
                type: "item.completed",
              }
            : { message: { content: "malformed" }, type: "assistant" }
        ),
      MalformedHarnessEventError
    );
  });
}
test("CLI support: Codex maps messages, command completion, files and terminal failure", () => {
  assert.deepEqual(
    frame("codex", {
      item: { id: "synthetic-message", text: "done", type: "agent_message" },
      type: "item.completed",
    }),
    [{ at: AT, kind: "message", model: null, text: "done" }]
  );
  assert.deepEqual(
    frame("codex", {
      item: {
        command: "pwd",
        id: "synthetic-command",
        status: "in_progress",
        type: "command_execution",
      },
      type: "item.started",
    }),
    [
      {
        at: AT,
        callId: "synthetic-command",
        kind: "tool-start",
        summary: "command_execution pwd",
        tool: "command_execution",
      },
    ]
  );
  assert.equal(
    frame("codex", {
      item: {
        aggregated_output: "denied",
        command: "pwd",
        exit_code: 1,
        id: "synthetic-command",
        status: "failed",
        type: "command_execution",
      },
      type: "item.completed",
    })[0]?.kind,
    "tool-end"
  );
  const files = frame("codex", {
    item: {
      changes: [{ kind: "add", path: "notes.md" }],
      id: "synthetic-change",
      status: "completed",
      type: "file_change",
    },
    type: "item.completed",
  });
  assert.deepEqual(files, [
    { at: AT, kind: "file", operation: "created", path: "notes.md" },
  ]);
  const complete = frame("codex", {
    type: "turn.completed",
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  assert.ok(
    complete.some((e) => e.kind === "finished" && e.status === "completed")
  );
  const failed = frame("codex", {
    error: { message: "synthetic failure" },
    type: "turn.failed",
  });
  assert.ok(failed.some((e) => e.kind === "finished" && e.status === "failed"));
  assert.ok(failed.some((e) => e.kind === "error"));
});
test("CLI support: Claude maps assistant/tool/result frames without guessing token billing", () => {
  const reply = frame("claude", {
    message: {
      content: [
        { text: "done", type: "text" },
        {
          id: "synthetic-tool",
          input: { file_path: "notes.md" },
          name: "Read",
          type: "tool_use",
        },
      ],
      model: "synthetic-model",
    },
    type: "assistant",
  });
  assert.ok(reply.some((e) => e.kind === "message" && e.text === "done"));
  assert.ok(reply.some((e) => e.kind === "tool-start"));
  const tool = frame("claude", {
    message: {
      content: [
        {
          content: "denied",
          is_error: true,
          tool_use_id: "synthetic-tool",
          type: "tool_result",
        },
      ],
    },
    type: "user",
  });
  assert.ok(tool.some((e) => e.kind === "tool-end" && !e.success));
  for (const is_error of [false, true]) {
    const result = frame("claude", {
      is_error,
      result: "done",
      session_id: "synthetic-session",
      subtype: is_error ? "error_during_execution" : "success",
      type: "result",
    });
    assert.ok(
      result.some(
        (e) =>
          e.kind === "finished" &&
          e.status === (is_error ? "failed" : "completed")
      )
    );
    assert.ok(
      !result.some((e) => e.kind === "usage" && e.premiumRequests !== null)
    );
  }
});

test("CLI completion frames do not invent operating-system exit codes", () => {
  for (const harness of ["codex", "claude"] as const) {
    const events = frame(
      harness,
      harness === "codex"
        ? { type: "turn.completed", usage: {} }
        : { is_error: false, subtype: "success", type: "result" }
    );
    const finished = events.find((event) => event.kind === "finished");
    assert.ok(finished && finished.kind === "finished");
    assert.equal(finished.exitCode, null);
  }
});
