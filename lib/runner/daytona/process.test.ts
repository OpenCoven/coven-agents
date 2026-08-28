import assert from "node:assert/strict";
import test from "node:test";
import type { Sandbox } from "@daytona/sdk";
import type { DaytonaProcessSandbox } from "./process";
import {
  DaytonaProcessError,
  snapshotDaytonaProcess,
  startDaytonaProcess,
  stopDaytonaProcess,
  sweepDaytonaCredentials,
} from "./process";

const RUN_ID = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
const SECRET = "copilot-credential-9f3b";
const SESSION = `coven-run-${RUN_ID}`;
const PATH = `/tmp/${SESSION}.credential`;

type Call = { command: string; env?: Record<string, string>; kind: string };

function processDouble(
  options: {
    command?: { exitCode?: number; status?: string };
    cleanupError?: Error;
    createError?: Error;
    createCreatesSession?: boolean;
    deleteError?: Error;
    deleteErrorOnCall?: number;
    deleteLeavesSession?: boolean;
    listErrorOnCall?: number;
    logs?: Readonly<{ output?: string; stderr?: string; stdout?: string }>;
    sessions?: readonly { commands: []; sessionId: string }[];
    stageExitCode?: number;
    stageError?: Error;
    startError?: Error;
    startId?: string;
  } = {}
) {
  const calls: Call[] = [];
  let deleteCalls = 0;
  let listCalls = 0;
  let sessions = [...(options.sessions ?? [])];
  const sandbox: DaytonaProcessSandbox = {
    process: {
      createSession: () => {
        if (options.createError) {
          if (options.createCreatesSession) {
            sessions.push({ commands: [], sessionId: SESSION });
          }
          return Promise.reject(options.createError);
        }
        sessions.push({ commands: [], sessionId: SESSION });
        return Promise.resolve();
      },
      deleteSession: () => {
        deleteCalls += 1;
        calls.push({ command: SESSION, kind: "delete" });
        if (
          options.deleteError &&
          (options.deleteErrorOnCall === undefined ||
            deleteCalls === options.deleteErrorOnCall)
        ) {
          return Promise.reject(options.deleteError);
        }
        if (!options.deleteLeavesSession) {
          sessions = sessions.filter(
            (session) => session.sessionId !== SESSION
          );
        }
        return Promise.resolve();
      },
      executeCommand: (command, _cwd, env) => {
        calls.push({ command, env, kind: "command" });
        if (calls.filter((call) => call.kind === "command").length === 1) {
          if (options.stageError) {
            return Promise.reject(options.stageError);
          }
          return Promise.resolve({ exitCode: options.stageExitCode ?? 0 });
        }
        if (options.cleanupError) {
          return Promise.reject(options.cleanupError);
        }
        return Promise.resolve({ exitCode: 0 });
      },
      executeSessionCommand: (_sessionId, request) => {
        calls.push({ command: request.command, kind: "start" });
        if (options.startError) {
          return Promise.reject(options.startError);
        }
        return Promise.resolve({ cmdId: options.startId ?? "cmd-1" });
      },
      getSessionCommand: () =>
        Promise.resolve({
          command: "safe command",
          exitCode: options.command?.exitCode,
          id: "cmd-1",
          status: options.command?.status,
        }),
      getSessionCommandLogs: () =>
        Promise.resolve({
          output: options.logs?.output ?? options.logs?.stdout,
          stderr: options.logs?.stderr,
          stdout: options.logs?.stdout,
        }),
      listSessions: () => {
        listCalls += 1;
        calls.push({ command: SESSION, kind: "list" });
        if (options.listErrorOnCall === listCalls) {
          return Promise.reject(new Error("lookup unavailable"));
        }
        return Promise.resolve(sessions);
      },
    },
  };
  return { calls, sandbox };
}

const startInput = (sandbox: DaytonaProcessSandbox) => ({
  credential: { credential: SECRET },
  instructions: "Use tests.",
  model: "auto",
  runId: RUN_ID,
  runtime: "copilot",
  sandbox,
  task: "Print safe output.",
  workspace: "repo",
});

function allReturnedText(value: unknown): string {
  return JSON.stringify(value, Object.getOwnPropertyNames(value));
}

test("stages only through per-call env and starts a safe asynchronous session", async () => {
  const { calls, sandbox } = processDouble();
  const started = await startDaytonaProcess(startInput(sandbox));
  const [stage] = calls;
  const launch = calls.find((call) => call.kind === "start");

  assert.deepEqual(started, {
    commandId: "cmd-1",
    credentialPath: PATH,
    sessionId: SESSION,
    workspace: "/workspace/repo",
  });
  assert.deepEqual(stage?.env, { COPILOT_GITHUB_TOKEN: SECRET });
  assert.ok(stage?.command.includes("umask 077"));
  assert.ok(
    stage?.command.includes(`printf '%s' "$COPILOT_GITHUB_TOKEN" > '${PATH}'`)
  );
  assert.ok(stage?.command.includes("chmod 600"));
  assert.equal(stage?.command.includes(SECRET), false);
  assert.equal(launch?.command.includes(SECRET), false);
  assert.ok(
    launch?.command.includes(`COPILOT_GITHUB_TOKEN="$(cat -- '${PATH}')"`) ??
      false
  );
  assert.ok(launch?.command.includes(`rm -f -- '${PATH}'`) ?? false);
  assert.equal(
    launch?.command,
    [
      "set -eu",
      `COPILOT_GITHUB_TOKEN="$(cat -- '${PATH}')"`,
      "export COPILOT_GITHUB_TOKEN",
      `rm -f -- '${PATH}'`,
      "unset GH_TOKEN GITHUB_TOKEN CODEX_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY AZURE_OPENAI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY",
      "export CI=true",
      "export HOME='/workspace/repo'",
      "mkdir -p -- '/workspace/repo'",
      "cd -- '/workspace/repo'",
      "exec 'copilot' '-s' '-p' 'Use tests.\n\nMission:\nPrint safe output.' '--yolo' '--no-ask-user' '--no-auto-update' '--no-color' '--output-format' 'json' '--log-level' 'none'",
    ].join("; ")
  );
  assert.ok(launch?.command.includes("export CI=true"));
  assert.ok(launch?.command.includes("export HOME='/workspace/repo'"));
  assert.ok(launch?.command.includes("exec 'copilot'"));
  assert.equal(allReturnedText(started).includes(SECRET), false);
});

test("cleans deterministic credentials and sessions at every failed start boundary", async () => {
  await Promise.all(
    [
      { options: { stageError: new Error(SECRET) }, sessionCleanup: false },
      { options: { createError: new Error(SECRET) }, sessionCleanup: false },
      { options: { startError: new Error(SECRET) }, sessionCleanup: true },
      { options: { startId: "" }, sessionCleanup: true },
    ].map(async ({ options, sessionCleanup }) => {
      const { calls, sandbox } = processDouble(options);
      await assert.rejects(() => startDaytonaProcess(startInput(sandbox)));
      assert.ok(
        calls.some(
          (call) =>
            call.kind === "command" &&
            call.command.includes(`rm -f -- '${PATH}'`)
        )
      );
      assert.equal(
        calls.every((call) => call.command.includes(SECRET) === false),
        true
      );
      assert.equal(
        calls.some((call) => call.kind === "delete"),
        sessionCleanup
      );
    })
  );
});

test("ambiguous session creation is looked up, deleted, and verified before retry", async () => {
  const { calls, sandbox } = processDouble({
    createCreatesSession: true,
    createError: new Error(SECRET),
  });

  await assert.rejects(
    () => startDaytonaProcess(startInput(sandbox)),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "session_create_failed"
  );

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["command", "list", "list", "command", "list", "delete", "list"]
  );
  assert.equal(
    calls
      .filter((call) => call.kind === "command")
      .every((call) => !call.command.includes(SECRET)),
    true
  );
});

test("an ambiguous creation still deletes its session when its first cleanup lookup fails", async () => {
  const { calls, sandbox } = processDouble({
    createCreatesSession: true,
    createError: new Error(SECRET),
    listErrorOnCall: 3,
  });

  await assert.rejects(
    () => startDaytonaProcess(startInput(sandbox)),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "session_create_failed"
  );

  assert.equal(calls[5]?.kind, "delete");
  assert.equal(calls[5]?.command, SESSION);
});

test("a stale deterministic session is removed before a retry creates a fresh one", async () => {
  const { calls, sandbox } = processDouble({
    sessions: [{ commands: [], sessionId: SESSION }],
  });

  await startDaytonaProcess(startInput(sandbox));

  assert.deepEqual(
    calls.slice(1, 4).map((call) => call.kind),
    ["list", "delete", "list"]
  );
  assert.equal(calls.filter((call) => call.kind === "start").length, 1);
});

test("surfaces safe combined cleanup failure without retaining provider secrets", async () => {
  const { sandbox } = processDouble({
    createCreatesSession: true,
    createError: new Error(SECRET),
    deleteError: new Error(SECRET),
    deleteErrorOnCall: 1,
  });
  await assert.rejects(
    () => startDaytonaProcess(startInput(sandbox)),
    (error: unknown) => {
      assert.ok(error instanceof DaytonaProcessError);
      assert.equal(error.code, "credential_cleanup_failed");
      assert.equal(allReturnedText(error).includes(SECRET), false);
      assert.ok(error.cause instanceof DaytonaProcessError);
      assert.equal(error.cause.code, "session_create_failed");
      return true;
    }
  );
});

test("snapshots complete JSONL once, flushes terminal fragments, and redacts malformed output", async () => {
  const line = JSON.stringify({
    data: { content: `hello ${SECRET}` },
    type: "assistant.message",
  });
  const { sandbox } = processDouble({ logs: { stdout: line } });
  const live = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    now: () => new Date("2026-08-28T09:00:00.000Z"),
    sandbox,
    sessionId: SESSION,
  });
  assert.equal(live.cursor, 0);
  assert.deepEqual(live.events, []);

  const completed = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: `${line}\nnot-json-${SECRET}` },
    }).sandbox,
    sessionId: SESSION,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.cursor, `${line}\nnot-json-${SECRET}`.length);
  assert.equal(JSON.stringify(completed).includes(SECRET), false);

  const noDuplicate = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: completed.cursor,
    harness: "copilot",
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: `${line}\nnot-json-${SECRET}` },
    }).sandbox,
    sessionId: SESSION,
  });
  assert.deepEqual(noDuplicate.events, []);
});

test("cursored snapshots retain the full terminal result and summary without replaying events", async () => {
  const stdout = `${JSON.stringify({
    data: { content: "authoritative answer" },
    type: "assistant.message",
  })}\n${JSON.stringify({ exitCode: 0, sessionId: "s1", type: "result" })}\n`;
  const input = {
    commandId: "cmd-1",
    credential: SECRET,
    harness: "copilot" as const,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout },
    }).sandbox,
    sessionId: SESSION,
  };

  const initial = await snapshotDaytonaProcess({ ...input, cursor: 0 });
  const later = await snapshotDaytonaProcess({
    ...input,
    cursor: initial.cursor,
  });

  assert.equal(initial.status, "completed");
  assert.equal(initial.summary.output, "authoritative answer");
  assert.deepEqual(later.events, []);
  assert.equal(later.status, "completed");
  assert.equal(later.exitCode, 0);
  assert.equal(later.summary.output, "authoritative answer");
});

test("harness result status outranks exit code and exit code remains the fallback", async () => {
  const result = JSON.stringify({ exitCode: 1, type: "result" });
  const fromResult = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: result },
    }).sandbox,
    sessionId: SESSION,
  });
  assert.equal(fromResult.status, "failed");
  assert.equal(fromResult.exitCode, 1);

  const fallback = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox: processDouble({ command: { exitCode: 1 } }).sandbox,
    sessionId: SESSION,
  });
  assert.equal(fallback.status, "failed");
  assert.equal(fallback.exitCode, 1);
});

test("normalizes optional Daytona log and command fields", async () => {
  const logsAbsent = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox: processDouble({ command: {} }).sandbox,
    sessionId: SESSION,
  });
  assert.deepEqual(logsAbsent.events, []);
  assert.equal(logsAbsent.exitCode, null);
  assert.equal(logsAbsent.status, "running");

  const completedByStatus = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox: processDouble({ command: { status: "completed" } }).sandbox,
    sessionId: SESSION,
  });
  assert.equal(completedByStatus.exitCode, null);
  assert.equal(completedByStatus.status, "completed");
});

test("the Daytona SDK Sandbox process shape is assignable", () => {
  const acceptsSdkSandbox = (sandbox: Sandbox): DaytonaProcessSandbox =>
    sandbox;
  assert.equal(typeof acceptsSdkSandbox, "function");
});

test("stops sessions only after API absence confirmation and asks caller to reset on failure", async () => {
  const stopped = await stopDaytonaProcess(processDouble().sandbox, SESSION);
  assert.deepEqual(stopped, { kind: "stopped" });

  const reset = await stopDaytonaProcess(
    processDouble({
      deleteLeavesSession: true,
      sessions: [{ commands: [], sessionId: SESSION }],
    }).sandbox,
    SESSION
  );
  assert.equal(reset.kind, "sandbox_reset_required");
  assert.equal(
    reset.kind === "sandbox_reset_required" && reset.error.code,
    "sandbox_reset_required"
  );

  const deleteFailed = await stopDaytonaProcess(
    processDouble({ deleteError: new Error(SECRET) }).sandbox,
    SESSION
  );
  assert.equal(deleteFailed.kind, "sandbox_reset_required");
  assert.equal(JSON.stringify(deleteFailed).includes(SECRET), false);
});

test("sweeps only deterministic credential paths", async () => {
  const { calls, sandbox } = processDouble();
  await sweepDaytonaCredentials(sandbox, [RUN_ID, RUN_ID]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.command.includes(PATH));
  assert.equal(calls[0]?.command.includes(SECRET), false);
  assert.equal(calls[0]?.env, undefined);
});
