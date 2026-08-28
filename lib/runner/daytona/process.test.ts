import assert from "node:assert/strict";
import test from "node:test";
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
    command?: { exitCode?: number };
    cleanupError?: Error;
    createError?: Error;
    deleteError?: Error;
    logs?: string;
    sessions?: readonly { commands: readonly []; sessionId: string }[];
    stageExitCode?: number;
    stageError?: Error;
    startError?: Error;
    startId?: string;
  } = {}
) {
  const calls: Call[] = [];
  const sandbox: DaytonaProcessSandbox = {
    process: {
      createSession: () => {
        if (options.createError) {
          return Promise.reject(options.createError);
        }
        return Promise.resolve();
      },
      deleteSession: () => {
        calls.push({ command: SESSION, kind: "delete" });
        if (options.deleteError) {
          return Promise.reject(options.deleteError);
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
        }),
      getSessionCommandLogs: () =>
        Promise.resolve({
          output: options.logs ?? "",
          stderr: "",
          stdout: options.logs ?? "",
        }),
      listSessions: () => Promise.resolve(options.sessions ?? []),
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
  assert.ok(launch?.command.includes("unset ANTHROPIC_API_KEY OPENAI_API_KEY"));
  assert.ok(launch?.command.includes("export CI=true"));
  assert.ok(launch?.command.includes("export HOME='/workspace/repo'"));
  assert.ok(launch?.command.includes("exec 'copilot'"));
  assert.equal(allReturnedText(started).includes(SECRET), false);
});

test("cleans deterministic credentials at every failed start boundary", async () => {
  await Promise.all(
    [
      { options: { stageError: new Error(SECRET) }, sessionCreated: false },
      { options: { createError: new Error(SECRET) }, sessionCreated: false },
      { options: { startError: new Error(SECRET) }, sessionCreated: true },
      { options: { startId: "" }, sessionCreated: true },
    ].map(async ({ options, sessionCreated }) => {
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
        sessionCreated
      );
    })
  );
});

test("surfaces safe combined cleanup failure without retaining provider secrets", async () => {
  const { sandbox } = processDouble({
    cleanupError: new Error(SECRET),
    stageExitCode: 0,
    startError: new Error(SECRET),
  });
  await assert.rejects(
    () => startDaytonaProcess(startInput(sandbox)),
    (error: unknown) => {
      assert.ok(error instanceof DaytonaProcessError);
      assert.equal(error.code, "credential_cleanup_failed");
      assert.equal(allReturnedText(error).includes(SECRET), false);
      return true;
    }
  );
});

test("snapshots complete JSONL once, flushes terminal fragments, and redacts malformed output", async () => {
  const line = JSON.stringify({
    data: { content: `hello ${SECRET}` },
    type: "assistant.message",
  });
  const { sandbox } = processDouble({ logs: line });
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
      logs: `${line}\nnot-json-${SECRET}`,
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
      logs: `${line}\nnot-json-${SECRET}`,
    }).sandbox,
    sessionId: SESSION,
  });
  assert.deepEqual(noDuplicate.events, []);
});

test("harness result status outranks exit code and exit code remains the fallback", async () => {
  const result = JSON.stringify({ exitCode: 1, type: "result" });
  const fromResult = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox: processDouble({ command: { exitCode: 0 }, logs: result }).sandbox,
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

test("stops sessions only after API absence confirmation and asks caller to reset on failure", async () => {
  const stopped = await stopDaytonaProcess(processDouble().sandbox, SESSION);
  assert.deepEqual(stopped, { kind: "stopped" });

  const reset = await stopDaytonaProcess(
    processDouble({ sessions: [{ commands: [], sessionId: SESSION }] }).sandbox,
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
