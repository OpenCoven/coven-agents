import assert from "node:assert/strict";
import test from "node:test";
import {
  DaytonaGoneError,
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  type Sandbox,
} from "@daytona/sdk";
import type { DaytonaPreparationClaim, DaytonaProcessSandbox } from "./process";
import {
  DaytonaProcessError,
  snapshotDaytonaProcess,
  startDaytonaProcess,
  stopDaytonaProcess,
  sweepDaytonaCredentials,
} from "./process";
import { classifyDaytonaProviderError } from "./sandbox";

const RUN_ID = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
const SECRET = "copilot-credential-9f3b";
const SESSION = `coven-run-${RUN_ID}`;
const PATH = `/tmp/${SESSION}.credential`;
const PREPARATION_CLAIM = "preparation-claim-a" as DaytonaPreparationClaim;

type Call = { command: string; env?: Record<string, string>; kind: string };

function processDouble(
  options: {
    command?: { exitCode?: number; status?: string };
    cleanupError?: Error;
    cleanupExitCode?: number;
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
  let commandCalls = 0;
  let deleteCalls = 0;
  let listCalls = 0;
  let sessions = [...(options.sessions ?? [])];
  const sandbox: DaytonaProcessSandbox = {
    process: {
      createSession: () => {
        calls.push({ command: SESSION, kind: "create" });
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
        commandCalls += 1;
        if (commandCalls === 1 && command.includes("umask 077")) {
          if (options.stageError) {
            return Promise.reject(options.stageError);
          }
          return Promise.resolve({ exitCode: options.stageExitCode ?? 0 });
        }
        if (command.includes("rm -f --") && options.cleanupError) {
          return Promise.reject(options.cleanupError);
        }
        return Promise.resolve({
          exitCode:
            command.includes("rm -f --") &&
            options.cleanupExitCode !== undefined
              ? options.cleanupExitCode
              : 0,
        });
      },
      executeSessionCommand: (_sessionId, request) => {
        calls.push({ command: request.command, kind: "start" });
        if (options.startError) {
          return Promise.reject(options.startError);
        }
        return Promise.resolve({ cmdId: options.startId ?? "cmd-1" });
      },
      getSessionCommand: () => {
        calls.push({ command: "cmd-1", kind: "status" });
        return Promise.resolve({
          command: "safe command",
          exitCode: options.command?.exitCode,
          id: "cmd-1",
          status: options.command?.status,
        });
      },
      getSessionCommandLogs: () => {
        calls.push({ command: "cmd-1", kind: "logs" });
        return Promise.resolve({
          output: options.logs?.output ?? options.logs?.stdout,
          stderr: options.logs?.stderr,
          stdout: options.logs?.stdout,
        });
      },
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
  return {
    calls,
    sandbox,
    sessionIds: () => sessions.map((session) => session.sessionId),
  };
}

const startInput = (sandbox: DaytonaProcessSandbox) => ({
  authorizeLaunch: async () => true,
  authorizePreparation: async () => PREPARATION_CLAIM,
  credential: { credential: SECRET },
  instructions: "Use tests.",
  model: "auto",
  runId: RUN_ID,
  runtime: "copilot",
  sandbox,
  task: "Print safe output.",
  workspace: "repo",
});

const stopInput = { runId: RUN_ID, sessionId: SESSION };

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
  assert.deepEqual(
    calls.slice(0, 5).map((call) => call.kind),
    ["command", "list", "list", "create", "start"]
  );
});

test("prepares durably and passes its exact claim before executing", async () => {
  const { calls, sandbox } = processDouble();
  const authorizations: unknown[] = [];
  let persistedSessionId: string | null = null;

  await startDaytonaProcess({
    ...startInput(sandbox),
    authorizeLaunch: (launch) => {
      calls.push({ command: launch.sessionId, kind: "authorize" });
      authorizations.push(launch);
      persistedSessionId = launch.sessionId;
      return Promise.resolve(true);
    },
    authorizePreparation: (preparation) => {
      calls.push({ command: preparation.runId, kind: "prepare" });
      return Promise.resolve(PREPARATION_CLAIM);
    },
  });

  const authorizationIndex = calls.findIndex(
    (call) => call.kind === "authorize"
  );
  const executeIndex = calls.findIndex((call) => call.kind === "start");
  assert.deepEqual(authorizations, [
    {
      preparationClaim: PREPARATION_CLAIM,
      runId: RUN_ID,
      sessionId: SESSION,
    },
  ]);
  assert.equal(
    (authorizations[0] as { preparationClaim: DaytonaPreparationClaim })
      .preparationClaim,
    PREPARATION_CLAIM
  );
  assert.equal(persistedSessionId, SESSION);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["prepare", "command", "list", "list", "create", "authorize", "start"]
  );
  assert.ok(authorizationIndex > -1);
  assert.ok(executeIndex > -1);
  assert.ok(authorizationIndex < executeIndex);
  assert.equal(
    calls.slice(0, executeIndex).some((call) => call.kind === "list"),
    true
  );
});

test("performs zero SDK mutations when durable preparation is stale", async () => {
  const { calls, sandbox } = processDouble();

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        authorizePreparation: () => Promise.resolve(null),
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "process_start_failed"
  );

  assert.deepEqual(calls, []);
});

test("cleans only its prepared resources when launch authorization is rejected", async () => {
  const { calls, sandbox, sessionIds } = processDouble();
  const cancellation = { recorded: false };

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        authorizeLaunch: () => {
          cancellation.recorded = true;
          return Promise.resolve(false);
        },
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "process_start_failed"
  );

  assert.equal(cancellation.recorded, true);
  assert.equal(
    calls.some((call) => call.kind === "start"),
    false
  );
  assert.equal(
    calls.some((call) => call.kind === "delete"),
    true
  );
  assert.ok(
    calls.some(
      (call) =>
        call.kind === "command" &&
        call.command === `rm -f -- '${PATH}' && test ! -e '${PATH}'`
    )
  );
  assert.deepEqual(sessionIds(), []);
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

test("a rejected interleaved preparation cannot delete the first claim's session", async () => {
  const { calls, sandbox, sessionIds } = processDouble();
  let releaseFirstLaunch: ((authorized: boolean) => void) | undefined;
  let signalFirstLaunch: (() => void) | undefined;
  const firstLaunchReached = new Promise<void>((resolve) => {
    signalFirstLaunch = resolve;
  });
  const first = startDaytonaProcess({
    ...startInput(sandbox),
    authorizeLaunch: () =>
      new Promise((resolve) => {
        releaseFirstLaunch = resolve;
        signalFirstLaunch?.();
      }),
  });

  await firstLaunchReached;
  assert.deepEqual(sessionIds(), [SESSION]);
  const mutationsBeforeSecond = calls.length;

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        authorizePreparation: () => Promise.resolve(null),
      }),
    (error: unknown) => error instanceof DaytonaProcessError
  );

  assert.equal(calls.length, mutationsBeforeSecond);
  assert.deepEqual(sessionIds(), [SESSION]);
  if (!releaseFirstLaunch) {
    throw new Error("First launch authorization did not become pending.");
  }
  releaseFirstLaunch(true);
  await first;
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
    ["command", "list", "list", "create", "command", "list", "delete", "list"]
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

  assert.equal(calls[6]?.kind, "delete");
  assert.equal(calls[6]?.command, SESSION);
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
  assert.equal(live.logsSettled, true);

  const completed = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: `${line}\nnot-json-${SECRET}\n` },
    }).sandbox,
    sessionId: SESSION,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.cursor, `${line}\nnot-json-${SECRET}\n`.length);
  assert.equal(
    completed.events.filter((event) => event.kind === "error").length,
    1
  );
  assert.equal(JSON.stringify(completed).includes(SECRET), false);

  const noDuplicate = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: completed.cursor,
    harness: "copilot",
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: `${line}\nnot-json-${SECRET}\n` },
    }).sandbox,
    sessionId: SESSION,
  });
  assert.deepEqual(noDuplicate.events, []);
});

test("leaves a terminal partial tail pending until the complete event arrives", async () => {
  const line = JSON.stringify({
    data: { content: "trailing event" },
    type: "assistant.message",
  });
  const partial = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: line.slice(0, -1) },
    }).sandbox,
    sessionId: SESSION,
  });

  assert.equal(partial.status, "completed");
  assert.equal(partial.logsSettled, false);
  assert.equal(partial.cursor, 0);
  assert.deepEqual(partial.events, []);

  const completed = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: partial.cursor,
    harness: "copilot",
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: line },
    }).sandbox,
    sessionId: SESSION,
  });
  assert.equal(completed.logsSettled, true);
  assert.equal(completed.cursor, line.length);
  assert.equal(completed.events.length, 1);

  const duplicate = await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: completed.cursor,
    harness: "copilot",
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: line },
    }).sandbox,
    sessionId: SESSION,
  });
  assert.deepEqual(duplicate.events, []);
});

test("reads Daytona command status before its log snapshot", async () => {
  const { calls, sandbox } = processDouble({
    command: { exitCode: 0 },
    logs: { stdout: "" },
  });
  await snapshotDaytonaProcess({
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    sandbox,
    sessionId: SESSION,
  });
  assert.deepEqual(
    calls
      .filter((call) => call.kind === "status" || call.kind === "logs")
      .map((call) => call.kind),
    ["status", "logs"]
  );
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
  const stopped = await stopDaytonaProcess(processDouble().sandbox, stopInput);
  assert.deepEqual(stopped, { kind: "stopped" });

  const reset = await stopDaytonaProcess(
    processDouble({
      deleteLeavesSession: true,
      sessions: [{ commands: [], sessionId: SESSION }],
    }).sandbox,
    stopInput
  );
  assert.equal(reset.kind, "sandbox_reset_required");
  assert.equal(
    reset.kind === "sandbox_reset_required" && reset.error.code,
    "sandbox_reset_required"
  );

  const deleteFailed = await stopDaytonaProcess(
    processDouble({ deleteError: new Error(SECRET) }).sandbox,
    stopInput
  );
  assert.equal(deleteFailed.kind, "sandbox_reset_required");
  assert.equal(JSON.stringify(deleteFailed).includes(SECRET), false);

  const retryableDeleteFailed = await stopDaytonaProcess(
    processDouble({ deleteError: new DaytonaTimeoutError("timeout") }).sandbox,
    stopInput
  );
  assert.equal(retryableDeleteFailed.kind, "sandbox_reset_required");
  assert.equal(
    retryableDeleteFailed.kind === "sandbox_reset_required" &&
      retryableDeleteFailed.error.retryable,
    true
  );
});

test("requires deterministic credential cleanup and verification before stopped", async () => {
  const { calls, sandbox } = processDouble();
  assert.deepEqual(await stopDaytonaProcess(sandbox, stopInput), {
    kind: "stopped",
  });
  assert.ok(
    calls.some(
      (call) =>
        call.kind === "command" &&
        call.command === `rm -f -- '${PATH}' && test ! -e '${PATH}'` &&
        call.env === undefined
    )
  );

  const reset = await stopDaytonaProcess(
    processDouble({ cleanupExitCode: 1 }).sandbox,
    stopInput
  );
  assert.equal(reset.kind, "sandbox_reset_required");
  assert.equal(JSON.stringify(reset).includes(SECRET), false);

  const cleanupAmbiguous = await stopDaytonaProcess(
    processDouble({ cleanupError: new Error(SECRET) }).sandbox,
    stopInput
  );
  assert.equal(cleanupAmbiguous.kind, "sandbox_reset_required");
  assert.equal(JSON.stringify(cleanupAmbiguous).includes(SECRET), false);
});

test("treats Daytona 404 and 410 session deletion responses as stopped only after credential cleanup", async () => {
  const absenceErrors = [
    new DaytonaNotFoundError("session missing", 404),
    new DaytonaGoneError("session gone", 410),
  ];

  await Promise.all(
    absenceErrors.map(async (error) => {
      assert.equal(classifyDaytonaProviderError(error), "not_found");
      const { calls, sandbox } = processDouble({ deleteError: error });

      assert.deepEqual(await stopDaytonaProcess(sandbox, stopInput), {
        kind: "stopped",
      });
      assert.deepEqual(await stopDaytonaProcess(sandbox, stopInput), {
        kind: "stopped",
      });
      assert.deepEqual(
        calls.map((call) => call.kind),
        ["delete", "command", "delete", "command"]
      );
      assert.equal(
        calls
          .filter((call) => call.kind === "command")
          .every(
            (call) =>
              call.command === `rm -f -- '${PATH}' && test ! -e '${PATH}'`
          ),
        true
      );
    })
  );
});

test("sweeps only deterministic credential paths", async () => {
  const { calls, sandbox } = processDouble();
  await sweepDaytonaCredentials(sandbox, [RUN_ID, RUN_ID]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.command.includes(PATH));
  assert.equal(calls[0]?.command.includes(SECRET), false);
  assert.equal(calls[0]?.env, undefined);
});
