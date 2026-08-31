import assert from "node:assert/strict";
import test from "node:test";
import { type RunEvent, runEventSchema } from "@opencoven/harness";
import {
  buildHarnessCommand,
  HarnessError,
  parseHarnessLog,
  requireHarness,
  resolveSandboxWorkspace,
  sanitizeHarnessEvent,
} from "./harness";

const AT = "2026-08-28T09:00:00.000Z";
const SECRET = "copilot-credential-9f3b";

test("bounds workspaces and only admits the supported Copilot harness", () => {
  assert.equal(resolveSandboxWorkspace(), "/workspace");
  assert.equal(
    resolveSandboxWorkspace("repo/../project"),
    "/workspace/project"
  );
  assert.throws(
    () => resolveSandboxWorkspace("../../etc"),
    (error: unknown) =>
      error instanceof HarnessError && error.code === "workspace_escape"
  );
  assert.equal(
    requireHarness("copilot", { credential: SECRET }).auth.name,
    "COPILOT_GITHUB_TOKEN"
  );
  assert.throws(
    () => requireHarness("codex", { credential: SECRET }),
    (error: unknown) =>
      error instanceof HarnessError && error.code === "harness_unsupported"
  );
});

test("quotes Copilot invocation and keeps incomplete JSONL outside the cursor", () => {
  const command = buildHarnessCommand({
    configDirectory: "/run/coven-agents/attempt/copilot",
    harness: "copilot",
    instructions: "Do not execute $(unsafe).",
    model: "auto",
    task: "Write 'quoted' output.",
    workspace: "/workspace/repo",
  });
  assert.ok(command.includes("'Do not execute $(unsafe)."));

  const line = JSON.stringify({
    data: { content: `safe ${SECRET}` },
    type: "assistant.message",
  });
  const partial = parseHarnessLog(
    "copilot",
    line.slice(0, 20),
    0,
    false,
    SECRET,
    AT
  );
  assert.deepEqual(partial.events, []);
  assert.equal(partial.cursor, 0);

  const complete = parseHarnessLog(
    "copilot",
    `${line}\n`,
    0,
    false,
    SECRET,
    AT
  );
  assert.equal(complete.events.length, 1);
  assert.equal(JSON.stringify(complete).includes(SECRET), false);
  assert.equal(complete.cursor, `${line}\n`.length);
  const duplicate = parseHarnessLog(
    "copilot",
    `${line}\n`,
    complete.cursor,
    false,
    SECRET,
    AT
  );
  assert.deepEqual(duplicate.events, []);
});

test("team child tasks cannot access shell, network, or GitHub tools", () => {
  const command = buildHarnessCommand({
    configDirectory: "/run/coven-agents/attempt/copilot",
    harness: "copilot",
    instructions: "Keep evidence concise.",
    model: "auto",
    task: "# Team Step Task\n\n## Mission\nEdit the requested files.",
    workspace: "/workspace/repo",
  });

  assert.doesNotMatch(command, /--yolo/u);
  assert.match(command, /--available-tools' 'view,edit,grep,glob/u);
  assert.match(command, /--allow-tool' 'read,write/u);
  assert.match(
    command,
    /--config-dir' '\/run\/coven-agents\/attempt\/copilot/u
  );
  assert.doesNotMatch(command, /shell|github-mcp|web_fetch|web_search/iu);
});

test("sanitizes every harness-controlled string field through the event contract", () => {
  const contaminatedAt = `not-a-timestamp-${SECRET}`;
  const events: RunEvent[] = [
    {
      at: contaminatedAt,
      harness: `copilot-${SECRET}`,
      kind: "started",
      runId: SECRET,
    } as unknown as RunEvent,
    { at: contaminatedAt, kind: "reasoning", text: SECRET },
    { at: contaminatedAt, kind: "delta", text: SECRET },
    { at: contaminatedAt, kind: "message", model: SECRET, text: SECRET },
    {
      at: contaminatedAt,
      callId: SECRET,
      kind: "tool-start",
      summary: SECRET,
      tool: SECRET,
    },
    {
      at: contaminatedAt,
      callId: SECRET,
      kind: "tool-end",
      success: true,
      summary: SECRET,
    },
    {
      at: contaminatedAt,
      kind: "file",
      operation: SECRET,
      path: SECRET,
    },
    {
      at: contaminatedAt,
      kind: "usage",
      linesAdded: null,
      linesRemoved: null,
      premiumRequests: null,
    },
    {
      at: contaminatedAt,
      exitCode: 0,
      filesModified: [SECRET],
      kind: "finished",
      sessionId: SECRET,
      status: "completed",
    },
    { at: contaminatedAt, kind: "error", message: SECRET },
  ];

  for (const event of events) {
    const sanitized = sanitizeHarnessEvent("copilot", event, SECRET, AT);
    assert.equal(JSON.stringify(sanitized).includes(SECRET), false);
    assert.equal(sanitized.at, AT);
    assert.equal(runEventSchema.safeParse(sanitized).success, true);
  }

  const canonical = sanitizeHarnessEvent(
    "copilot",
    { at: "2026-08-28T09:00:00Z", kind: "delta", text: "safe" },
    SECRET,
    AT
  );
  assert.equal(canonical.at, AT);
});

test("flushes a terminal trailing event and emits malformed diagnostics once", () => {
  const terminal = JSON.stringify({
    exitCode: 0,
    sessionId: "session",
    type: "result",
  });

  const parsed = parseHarnessLog("copilot", terminal, 0, true, SECRET, AT);
  assert.equal(parsed.cursor, terminal.length);
  assert.equal(
    parsed.events.some((event) => event.kind === "finished"),
    true
  );

  const malformed = parseHarnessLog(
    "copilot",
    `not JSON ${SECRET}\n`,
    0,
    false,
    SECRET,
    AT
  );
  assert.equal(JSON.stringify(malformed).includes(SECRET), false);
  assert.equal(
    malformed.events.filter((event) => event.kind === "error").length,
    1
  );
  assert.equal(
    malformed.events[0]?.kind === "error" && malformed.events[0].message,
    "Malformed harness JSONL event was ignored."
  );
  const replay = parseHarnessLog(
    "copilot",
    `not JSON ${SECRET}\n`,
    malformed.cursor,
    false,
    SECRET,
    AT
  );
  assert.deepEqual(replay.events, []);

  const partialTerminal = parseHarnessLog(
    "copilot",
    terminal.slice(0, -1),
    0,
    true,
    SECRET,
    AT
  );
  assert.equal(partialTerminal.cursor, 0);
  assert.equal(partialTerminal.pendingTail, true);
  assert.deepEqual(partialTerminal.events, []);

  const completedTerminal = parseHarnessLog(
    "copilot",
    terminal,
    partialTerminal.cursor,
    true,
    SECRET,
    AT
  );
  assert.equal(completedTerminal.pendingTail, false);
  assert.equal(completedTerminal.cursor, terminal.length);
  assert.equal(
    completedTerminal.events.some((event) => event.kind === "finished"),
    true
  );
});

test("skips malformed structured records without stopping later valid results", () => {
  const malformedRecords = [
    {
      type: "result",
      usage: [SECRET],
    },
    {
      type: "result",
      usage: { codeChanges: [SECRET] },
    },
    {
      type: "result",
      usage: { codeChanges: { filesModified: [42] } },
    },
    {
      type: "result",
      usage: { codeChanges: { filesModified: SECRET } },
    },
  ];
  const valid = JSON.stringify({
    exitCode: 0,
    sessionId: "safe-session",
    type: "result",
    usage: {
      codeChanges: { filesModified: ["safe.ts"], linesAdded: 1 },
      premiumRequests: 1,
    },
  });
  const stdout = `${malformedRecords
    .map((record) => JSON.stringify(record))
    .join("\n")}\n${valid}\n`;

  const parsed = parseHarnessLog("copilot", stdout, 0, false, SECRET, AT);
  assert.equal(parsed.cursor, stdout.length);
  assert.equal(JSON.stringify(parsed).includes(SECRET), false);
  assert.equal(
    parsed.events.filter((event) => event.kind === "error").length,
    malformedRecords.length
  );
  assert.deepEqual(parsed.events.at(-1), {
    at: AT,
    exitCode: 0,
    filesModified: ["safe.ts"],
    kind: "finished",
    sessionId: "safe-session",
    status: "completed",
  });

  const replay = parseHarnessLog(
    "copilot",
    stdout,
    parsed.cursor,
    false,
    SECRET,
    AT
  );
  assert.deepEqual(replay.events, []);
});
