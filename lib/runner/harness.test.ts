import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHarnessCommand,
  HarnessError,
  parseHarnessLog,
  requireHarness,
  resolveSandboxWorkspace,
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

test("flushes a terminal trailing event and bounds malformed diagnostics", () => {
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
  assert.equal(malformed.diagnostics.length, 1);
  assert.equal(JSON.stringify(malformed).includes(SECRET), false);
  assert.equal(
    malformed.diagnostics[0]?.kind === "error" &&
      malformed.diagnostics[0].message,
    "Malformed harness JSONL event was ignored."
  );
});
