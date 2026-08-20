import assert from "node:assert/strict";
import test from "node:test";
import {
  HarnessError,
  parseHarnessStream,
  requireHarness,
  resolveSandboxWorkspace,
  runHarnessInSandbox,
} from "./harness-runner";

type Call = { command: string; options?: Record<string, unknown> };

/** `assert.throws` returns undefined, so capture the error to inspect its code. */
function caught(run: () => unknown): HarnessError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof HarnessError, "expected a HarnessError");
    return error;
  }
  throw new Error("expected the call to throw");
}

function fakeSandbox(
  responses: Record<string, { exitCode?: number; stdout?: string }>,
  calls: Call[]
) {
  return {
    exec(command: string, options?: Record<string, unknown>) {
      calls.push({ command, options });
      const key = Object.keys(responses).find((prefix) =>
        command.startsWith(prefix)
      );
      const response = key ? responses[key] : undefined;
      const exitCode = response?.exitCode ?? 0;
      return Promise.resolve({
        command,
        exitCode,
        stderr: "",
        stdout: response?.stdout ?? "",
        success: exitCode === 0,
      });
    },
  };
}

test("a missing harness credential is a harness error, not a provider error", () => {
  const error = caught(() => requireHarness("copilot", {}));
  assert.equal(error.code, "harness_unauthenticated");
  assert.ok(error.message.includes("COPILOT_GITHUB_TOKEN"));
  assert.ok(!error.message.includes("OPENAI_API_KEY"));
});

test("an unsupported harness is refused before anything is spawned", () => {
  const error = caught(() => requireHarness("codex", { CODEX_API_KEY: "x" }));
  assert.equal(error.code, "harness_unsupported");
});

test("the retired cloud runtime is not a harness", () => {
  const error = caught(() => requireHarness("cloud", {}));
  assert.equal(error.code, "unknown_harness");
});

test("workspace traversal is refused", () => {
  assert.equal(resolveSandboxWorkspace(), "/workspace");
  assert.equal(resolveSandboxWorkspace("repo"), "/workspace/repo");
  assert.equal(resolveSandboxWorkspace("/workspace/a/../b"), "/workspace/b");
  assert.throws(() => resolveSandboxWorkspace("/etc"), HarnessError);
  assert.throws(() => resolveSandboxWorkspace("../../etc"), HarnessError);
});

test("JSONL split across chunk boundaries still parses", () => {
  const line = JSON.stringify({
    data: { content: "done", model: "gpt-5" },
    type: "assistant.message",
  });
  const events = parseHarnessStream(
    "copilot",
    `noise\n${line}\n`,
    "2026-08-20T17:00:00.000Z"
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "message");
});

test("a run drives the harness CLI and passes only its own credential", async () => {
  const calls: Call[] = [];
  const result = JSON.stringify({
    exitCode: 0,
    sessionId: "s1",
    type: "result",
    usage: { codeChanges: { linesAdded: 2, linesRemoved: 0 } },
  });
  const message = JSON.stringify({
    data: { content: "Created notes.md", model: "gpt-5" },
    type: "assistant.message",
  });
  const sandbox = fakeSandbox(
    {
      "'copilot'": { stdout: `${message}\n${result}\n` },
      "copilot --version": { stdout: "GitHub Copilot CLI 1.0.80\n" },
    },
    calls
  );

  const run = await runHarnessInSandbox({
    env: { COPILOT_GITHUB_TOKEN: "harness-token" },
    instructions: "Be careful.",
    model: "auto",
    runtime: "copilot",
    sandbox: sandbox as never,
    task: "Create notes.md",
  });

  assert.equal(run.exitCode, 0);
  assert.equal(run.summary.status, "completed");
  assert.equal(run.summary.output, "Created notes.md");
  assert.equal(run.summary.sessionId, "s1");

  const invocation = calls.at(-1);
  assert.ok(invocation);
  assert.ok(invocation.command.startsWith("'copilot'"));
  const env = invocation.options?.env as Record<string, string>;
  assert.equal(env.COPILOT_GITHUB_TOKEN, "harness-token");
  assert.equal(env.OPENAI_API_KEY, "");
  assert.equal(env.ANTHROPIC_API_KEY, "");
});

test("a sandbox image without the CLI names the fix instead of failing opaquely", async () => {
  const calls: Call[] = [];
  const sandbox = fakeSandbox(
    { "copilot --version": { exitCode: 127 } },
    calls
  );
  await assert.rejects(
    runHarnessInSandbox({
      env: { COPILOT_GITHUB_TOKEN: "harness-token" },
      instructions: "Be careful.",
      model: "auto",
      runtime: "copilot",
      sandbox: sandbox as never,
      task: "Create notes.md",
    }),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === "harness_missing" &&
      error.message.includes("@github/copilot")
  );
});
