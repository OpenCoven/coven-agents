import assert from "node:assert/strict";
import test from "node:test";
import {
  DaytonaGoneError,
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  type Sandbox,
} from "@daytona/sdk";
import type { RunnerDispatchAuthority } from "../types";
import { daytonaRunCredentialPath, daytonaRunSessionName } from "./names";
import type { DaytonaAttemptId, DaytonaProcessSandbox } from "./process";
import {
  DaytonaProcessError,
  probeDaytonaHarnesses,
  snapshotDaytonaProcess,
  startDaytonaProcess,
  stopDaytonaProcess,
  sweepDaytonaCredentials,
} from "./process";
import { classifyDaytonaProviderError } from "./sandbox";

const RUN_ID = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
const SECRET = "copilot-credential-9f3b";
const PREPARATION_CLAIM =
  "53af1a29-4e98-43d6-ac5b-3b9dcba5e731" as DaytonaAttemptId;
const SESSION = daytonaRunSessionName(RUN_ID, PREPARATION_CLAIM);
const PATH = daytonaRunCredentialPath(RUN_ID, PREPARATION_CLAIM);
const LAUNCH_AUTHORITY = {
  expectedVersion: 9,
  leaseToken: "lease-a",
  runId: RUN_ID,
} as RunnerDispatchAuthority;

test("normal harness probes retain native bounded executeCommand behavior", async () => {
  const timeouts: number[] = [];
  const sandbox = {
    process: {
      executeCommand: (
        _command: string,
        _cwd?: string,
        _env?: Record<string, string>,
        timeout?: number
      ) => {
        timeouts.push(timeout ?? 0);
        return Promise.resolve({ exitCode: 0, result: "1.0.0" });
      },
    },
  } as DaytonaProcessSandbox;

  await probeDaytonaHarnesses(sandbox, { timeoutSeconds: 2 });
  assert.ok(timeouts.length > 0);
  assert.ok(timeouts.every((timeout) => timeout === 2));
});

test("an in-flight prewarm probe abort deletes its provider session and resolves", async () => {
  const controller = new AbortController();
  const sessions = new Set<string>();
  const commandRejectors: ((error: Error) => void)[] = [];
  let commandStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  let deletes = 0;
  const sandbox = {
    process: {
      createSession: (sessionId: string) => {
        sessions.add(sessionId);
        return Promise.resolve();
      },
      deleteSession: (sessionId: string) => {
        deletes += 1;
        sessions.delete(sessionId);
        for (const reject of commandRejectors) {
          reject(new Error("probe session deleted"));
        }
        return Promise.resolve();
      },
      executeCommand: () =>
        Promise.reject(new Error("prewarm must use a cancellable session")),
      executeSessionCommand: (
        _sessionId: string,
        _request: unknown,
        timeout?: number
      ) => {
        assert.ok(timeout && timeout > 0 && timeout <= 5);
        commandStarted();
        return new Promise((_resolve, reject) => {
          commandRejectors.push(reject);
        });
      },
      getSessionCommand: () => Promise.resolve({}),
      getSessionCommandLogs: () => Promise.resolve({}),
      listSessions: () =>
        Promise.resolve(
          [...sessions].map((sessionId) => ({ commands: [], sessionId }))
        ),
    },
  } as DaytonaProcessSandbox;

  const pending = probeDaytonaHarnesses(sandbox, {
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await Promise.race([
    started,
    pending.then(() => {
      throw new Error("cancellable probe session was not started");
    }),
  ]);
  controller.abort(new Error("prewarm deadline exceeded"));

  await assert.rejects(pending, /prewarm deadline exceeded/);
  assert.equal(deletes, 1);
  assert.equal(sessions.size, 0);
});

test("a successful cancellable prewarm probe cleans its attempt session", async () => {
  const sessions = new Set<string>();
  let deletes = 0;
  const sandbox = {
    process: {
      createSession: (sessionId: string) => {
        sessions.add(sessionId);
        return Promise.resolve();
      },
      deleteSession: (sessionId: string) => {
        deletes += 1;
        sessions.delete(sessionId);
        return Promise.resolve();
      },
      executeCommand: () =>
        Promise.reject(new Error("prewarm must use a cancellable session")),
      executeSessionCommand: () =>
        Promise.resolve({
          cmdId: "probe-command",
          exitCode: 0,
          stdout: "1.0.0",
        }),
      getSessionCommand: () => Promise.resolve({}),
      getSessionCommandLogs: () => Promise.resolve({}),
      listSessions: () =>
        Promise.resolve(
          [...sessions].map((sessionId) => ({ commands: [], sessionId }))
        ),
    },
  } as DaytonaProcessSandbox;

  const result = await probeDaytonaHarnesses(sandbox, {
    signal: new AbortController().signal,
    timeoutSeconds: 5,
  });

  assert.ok(result.every(({ installed }) => installed));
  assert.equal(deletes, 1);
  assert.equal(sessions.size, 0);
});

test("abort racing probe completion still deletes the session and reports cancellation", async () => {
  const controller = new AbortController();
  const sessions = new Set<string>();
  let deletes = 0;
  const sandbox = {
    process: {
      createSession: (sessionId: string) => {
        sessions.add(sessionId);
        return Promise.resolve();
      },
      deleteSession: (sessionId: string) => {
        deletes += 1;
        sessions.delete(sessionId);
        return Promise.resolve();
      },
      executeCommand: () =>
        Promise.reject(new Error("prewarm must use a cancellable session")),
      executeSessionCommand: () => {
        controller.abort(new Error("prewarm deadline exceeded"));
        return Promise.resolve({
          cmdId: "probe-command",
          exitCode: 0,
          stdout: "1.0.0",
        });
      },
      getSessionCommand: () => Promise.resolve({}),
      getSessionCommandLogs: () => Promise.resolve({}),
      listSessions: () =>
        Promise.resolve(
          [...sessions].map((sessionId) => ({ commands: [], sessionId }))
        ),
    },
  } as DaytonaProcessSandbox;

  await assert.rejects(
    probeDaytonaHarnesses(sandbox, {
      signal: controller.signal,
      timeoutSeconds: 5,
    }),
    /prewarm deadline exceeded/
  );

  assert.equal(deletes, 1);
  assert.equal(sessions.size, 0);
});

test("abort racing an ambiguous session create removes the late session", async () => {
  const controller = new AbortController();
  const sessions = new Set<string>();
  let createdSessionId = "";
  let createStarted!: () => void;
  let finishCreate!: () => void;
  const started = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  const creation = new Promise<void>((resolve) => {
    finishCreate = () => {
      sessions.add(createdSessionId);
      resolve();
    };
  });
  let deletes = 0;
  const sandbox = {
    process: {
      createSession: (sessionId: string) => {
        createdSessionId = sessionId;
        createStarted();
        return creation;
      },
      deleteSession: (sessionId: string) => {
        deletes += 1;
        sessions.delete(sessionId);
        return Promise.resolve();
      },
      executeCommand: () =>
        Promise.reject(new Error("prewarm must use a cancellable session")),
      executeSessionCommand: () =>
        Promise.reject(new Error("aborted create must not execute")),
      getSessionCommand: () => Promise.resolve({}),
      getSessionCommandLogs: () => Promise.resolve({}),
      listSessions: () =>
        Promise.resolve(
          [...sessions].map((sessionId) => ({ commands: [], sessionId }))
        ),
    },
  } as DaytonaProcessSandbox;

  const pending = probeDaytonaHarnesses(sandbox, {
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  controller.abort(new Error("prewarm deadline exceeded"));
  finishCreate();

  await assert.rejects(pending, /prewarm deadline exceeded/);
  assert.equal(deletes, 1);
  assert.equal(sessions.size, 0);
});

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
      createSession: (sessionId) => {
        calls.push({ command: sessionId, kind: "create" });
        if (options.createError) {
          if (options.createCreatesSession) {
            sessions.push({ commands: [], sessionId });
          }
          return Promise.reject(options.createError);
        }
        sessions.push({ commands: [], sessionId });
        return Promise.resolve();
      },
      deleteSession: (sessionId) => {
        deleteCalls += 1;
        calls.push({ command: sessionId, kind: "delete" });
        if (
          options.deleteError &&
          (options.deleteErrorOnCall === undefined ||
            deleteCalls === options.deleteErrorOnCall)
        ) {
          return Promise.reject(options.deleteError);
        }
        if (!options.deleteLeavesSession) {
          sessions = sessions.filter(
            (session) => session.sessionId !== sessionId
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
  authorizeLaunch: async () => LAUNCH_AUTHORITY,
  authorizePreparation: async () => PREPARATION_CLAIM,
  credential: { credential: SECRET },
  deleteAttemptRedaction: async () => true,
  instructions: "Use tests.",
  model: "auto",
  persistAttemptRedaction: async () => true,
  releasePreparation: async () => LAUNCH_AUTHORITY,
  runId: RUN_ID,
  runtime: "copilot",
  sandbox,
  task: "Print safe output.",
  workspace: "repo",
});

const stopInput = { attemptId: PREPARATION_CLAIM, runId: RUN_ID };

function allReturnedText(value: unknown): string {
  return JSON.stringify(value, Object.getOwnPropertyNames(value));
}

test("stages only through per-call env and starts a safe asynchronous session", async () => {
  const { calls, sandbox } = processDouble();
  const started = await startDaytonaProcess(startInput(sandbox));
  const stage = calls.find(
    (call) => call.kind === "command" && call.command.includes("umask 077")
  );
  const launch = calls.find((call) => call.kind === "start");

  assert.deepEqual(started, {
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credentialPath: PATH,
    dispatchAuthority: LAUNCH_AUTHORITY,
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
    ["list", "list", "command", "create", "start"]
  );
});

test("attaches the exact attempt and command only after execution accepts", async () => {
  const { calls, sandbox } = processDouble();
  const authorizations: unknown[] = [];
  let persistedSessionId: string | null = null;

  await startDaytonaProcess({
    ...startInput(sandbox),
    authorizeLaunch: (launch) => {
      calls.push({ command: launch.sessionId, kind: "authorize" });
      authorizations.push(launch);
      persistedSessionId = launch.sessionId;
      return Promise.resolve(LAUNCH_AUTHORITY);
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
      attemptId: PREPARATION_CLAIM,
      commandId: "cmd-1",
      runId: RUN_ID,
      sessionId: SESSION,
    },
  ]);
  assert.equal(
    (authorizations[0] as { attemptId: DaytonaAttemptId }).attemptId,
    PREPARATION_CLAIM
  );
  assert.equal(persistedSessionId, SESSION);
  assert.deepEqual(
    calls.map((call) => call.kind),
    ["prepare", "list", "list", "command", "create", "start", "authorize"]
  );
  assert.ok(authorizationIndex > -1);
  assert.ok(executeIndex > -1);
  assert.ok(authorizationIndex > executeIndex);
  assert.equal(
    calls.slice(0, executeIndex).some((call) => call.kind === "list"),
    true
  );
});

test("persists attempt redaction before staging and retires it after proven failed cleanup", async () => {
  const { sandbox } = processDouble({ stageError: new Error("stage failed") });
  const redaction: string[] = [];

  await assert.rejects(() =>
    startDaytonaProcess({
      ...startInput(sandbox),
      deleteAttemptRedaction: ({ attemptId, runId }) => {
        redaction.push(`delete:${attemptId}:${runId}`);
        return Promise.resolve(true);
      },
      persistAttemptRedaction: ({ attemptId, credential, runId }) => {
        assert.equal(credential, SECRET);
        redaction.push(`persist:${attemptId}:${runId}`);
        return Promise.resolve(true);
      },
    })
  );

  assert.deepEqual(redaction, [
    `persist:${PREPARATION_CLAIM}:${RUN_ID}`,
    `delete:${PREPARATION_CLAIM}:${RUN_ID}`,
  ]);
});

test("performs zero SDK mutations when durable preparation is stale or explicitly denied", async () => {
  await Promise.all(
    [null, false].map(async (claim) => {
      const { calls, sandbox } = processDouble();

      await assert.rejects(
        () =>
          startDaytonaProcess({
            ...startInput(sandbox),
            authorizePreparation: () => Promise.resolve(claim as never),
          }),
        (error: unknown) =>
          error instanceof DaytonaProcessError &&
          error.code === "process_start_failed" &&
          error.retryable === false
      );

      assert.deepEqual(calls, []);
    })
  );
});

test("rejects an invalid durable attempt before any SDK mutation", async () => {
  const { calls, sandbox } = processDouble();

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        authorizePreparation: async () => "../unsafe" as DaytonaAttemptId,
      }),
    /UUID attempt id/u
  );

  assert.deepEqual(calls, []);
});

test("treats a failed durable preparation callback as a safe retryable start error", async () => {
  const { calls, sandbox } = processDouble();

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        authorizePreparation: () => Promise.reject(new Error(SECRET)),
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "process_start_failed" &&
      error.retryable === true &&
      allReturnedText(error).includes(SECRET) === false
  );

  assert.deepEqual(calls, []);
});

test("cleans only its prepared resources when launch authorization is rejected", async () => {
  const { calls, sandbox, sessionIds } = processDouble();
  const cancellation = { recorded: false };
  const releases: unknown[] = [];

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        authorizeLaunch: () => {
          cancellation.recorded = true;
          return Promise.resolve(null);
        },
        releasePreparation: (release) => {
          releases.push(release);
          return Promise.resolve(LAUNCH_AUTHORITY);
        },
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "process_start_failed" &&
      error.retryable === false
  );

  assert.equal(cancellation.recorded, true);
  assert.equal(
    calls.some((call) => call.kind === "start"),
    true
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
  assert.deepEqual(releases, [{ attemptId: PREPARATION_CLAIM, runId: RUN_ID }]);
});

test("cleans prepared resources when launch authorization throws and returns a retryable error", async () => {
  const { calls, sandbox, sessionIds } = processDouble();
  const releases: unknown[] = [];

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        authorizeLaunch: () => Promise.reject(new Error(SECRET)),
        releasePreparation: (release) => {
          releases.push(release);
          return Promise.resolve(LAUNCH_AUTHORITY);
        },
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "process_start_failed" &&
      error.retryable === true &&
      allReturnedText(error).includes(SECRET) === false
  );

  assert.equal(
    calls.some((call) => call.kind === "start"),
    true
  );
  assert.ok(
    calls.some(
      (call) =>
        call.kind === "command" &&
        call.command === `rm -f -- '${PATH}' && test ! -e '${PATH}'`
    )
  );
  assert.ok(calls.some((call) => call.kind === "delete"));
  assert.deepEqual(sessionIds(), []);
  assert.deepEqual(releases, [{ attemptId: PREPARATION_CLAIM, runId: RUN_ID }]);
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
      const releases: unknown[] = [];
      await assert.rejects(() =>
        startDaytonaProcess({
          ...startInput(sandbox),
          releasePreparation: (release) => {
            releases.push(release);
            return Promise.resolve(LAUNCH_AUTHORITY);
          },
        })
      );
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
      assert.deepEqual(releases, [
        { attemptId: PREPARATION_CLAIM, runId: RUN_ID },
      ]);
    })
  );
});

test("a rejected interleaved preparation cannot delete the first claim's session", async () => {
  const { calls, sandbox, sessionIds } = processDouble();
  let releaseFirstLaunch:
    | ((authorized: RunnerDispatchAuthority | null) => void)
    | undefined;
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
  releaseFirstLaunch(LAUNCH_AUTHORITY);
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
    ["list", "list", "command", "create", "command", "list", "delete", "list"]
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

test("removes and confirms a stale deterministic session before staging a new credential", async () => {
  const { calls, sandbox } = processDouble({
    sessions: [{ commands: [], sessionId: SESSION }],
  });

  await startDaytonaProcess(startInput(sandbox));

  assert.deepEqual(
    calls.slice(0, 4).map((call) => call.kind),
    ["list", "delete", "list", "command"]
  );
  assert.equal(calls.filter((call) => call.kind === "start").length, 1);
});

test("aborts with zero credential staging when stale-session cleanup is ambiguous", async () => {
  const { calls, sandbox } = processDouble({
    deleteError: new Error(SECRET),
    sessions: [{ commands: [], sessionId: SESSION }],
  });

  await assert.rejects(
    () => startDaytonaProcess(startInput(sandbox)),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "sandbox_reset_required" &&
      allReturnedText(error).includes(SECRET) === false
  );

  assert.deepEqual(
    calls.map((call) => call.kind),
    ["list", "delete", "command", "list", "delete"]
  );
  assert.equal(
    calls.some(
      (call) => call.kind === "command" && call.command.includes("umask 077")
    ),
    false
  );
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
      assert.equal(error.code, "sandbox_reset_required");
      assert.equal(allReturnedText(error).includes(SECRET), false);
      assert.ok(error.cause instanceof DaytonaProcessError);
      assert.equal(error.cause.code, "session_create_failed");
      return true;
    }
  );
});

test("retains the claim with a retryable durable-release error when cleanup succeeds but release fails", async () => {
  const { calls, sandbox, sessionIds } = processDouble({
    stageError: new Error(SECRET),
  });
  const releases: unknown[] = [];

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        releasePreparation: (release) => {
          releases.push(release);
          return Promise.reject(new Error(SECRET));
        },
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "durable_release_failed" &&
      error.retryable === true &&
      allReturnedText(error).includes(SECRET) === false
  );

  assert.deepEqual(releases, [{ attemptId: PREPARATION_CLAIM, runId: RUN_ID }]);
  assert.deepEqual(sessionIds(), []);
  assert.ok(
    calls.some(
      (call) =>
        call.kind === "command" &&
        call.command === `rm -f -- '${PATH}' && test ! -e '${PATH}'`
    )
  );
});

test("a stale attempt release cannot request a reset of a replacement attempt's sandbox", async () => {
  const attemptB = "53af1a29-4e98-43d6-ac5b-3b9dcba5e732" as DaytonaAttemptId;
  const sessionB = daytonaRunSessionName(RUN_ID, attemptB);
  const { calls, sandbox, sessionIds } = processDouble({
    sessions: [{ commands: [], sessionId: sessionB }],
    stageError: new Error(SECRET),
  });
  const releases: unknown[] = [];

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        releasePreparation: (release) => {
          releases.push(release);
          return Promise.resolve(null);
        },
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "durable_release_failed" &&
      error.retryable === true &&
      error.message.includes("reset") === false &&
      allReturnedText(error).includes(SECRET) === false
  );

  assert.deepEqual(releases, [{ attemptId: PREPARATION_CLAIM, runId: RUN_ID }]);
  assert.deepEqual(sessionIds(), [sessionB]);
  assert.equal(
    calls
      .filter((call) => call.kind === "delete")
      .some((call) => call.command === sessionB),
    false
  );
});

test("snapshots complete JSONL once, flushes terminal fragments, and redacts malformed output", async () => {
  const line = JSON.stringify({
    data: { content: `hello ${SECRET}` },
    type: "assistant.message",
  });
  const { sandbox } = processDouble({ logs: { stdout: line } });
  const live = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    now: () => new Date("2026-08-28T09:00:00.000Z"),
    runId: RUN_ID,
    sandbox,
  });
  assert.equal(live.cursor, 0);
  assert.deepEqual(live.events, []);
  assert.equal(live.logsSettled, true);

  const completed = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: `${line}\nnot-json-${SECRET}\n` },
    }).sandbox,
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.cursor, `${line}\nnot-json-${SECRET}\n`.length);
  assert.equal(
    completed.events.filter((event) => event.kind === "error").length,
    1
  );
  assert.equal(JSON.stringify(completed).includes(SECRET), false);

  const noDuplicate = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: completed.cursor,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: `${line}\nnot-json-${SECRET}\n` },
    }).sandbox,
  });
  assert.deepEqual(noDuplicate.events, []);
});

test("continues polling after malformed structured JSONL records", async () => {
  const malformed = [
    JSON.stringify({ type: "result", usage: [SECRET] }),
    JSON.stringify({
      type: "result",
      usage: { codeChanges: { filesModified: [42] } },
    }),
    JSON.stringify({
      type: "result",
      usage: { codeChanges: { filesModified: SECRET } },
    }),
  ];
  const valid = JSON.stringify({
    exitCode: 0,
    sessionId: "safe-session",
    type: "result",
  });
  const stdout = `${malformed.join("\n")}\n${valid}\n`;
  const snapshot = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout },
    }).sandbox,
  });

  assert.equal(snapshot.cursor, stdout.length);
  assert.equal(snapshot.status, "completed");
  assert.equal(
    snapshot.events.filter((event) => event.kind === "error").length,
    malformed.length
  );
  const finished = snapshot.events.at(-1);
  assert.equal(finished?.kind === "finished" && finished.status, "completed");
  assert.equal(JSON.stringify(snapshot).includes(SECRET), false);

  const replay = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: snapshot.cursor,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout },
    }).sandbox,
  });
  assert.deepEqual(replay.events, []);
});

test("leaves a terminal partial tail pending until the complete event arrives", async () => {
  const line = JSON.stringify({
    data: { content: "trailing event" },
    type: "assistant.message",
  });
  const partial = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: line.slice(0, -1) },
    }).sandbox,
  });

  assert.equal(partial.status, "completed");
  assert.equal(partial.logsSettled, false);
  assert.equal(partial.cursor, 0);
  assert.deepEqual(partial.events, []);

  const completed = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: partial.cursor,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: line },
    }).sandbox,
  });
  assert.equal(completed.logsSettled, true);
  assert.equal(completed.cursor, line.length);
  assert.equal(completed.events.length, 1);

  const duplicate = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: completed.cursor,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: line },
    }).sandbox,
  });
  assert.deepEqual(duplicate.events, []);
});

test("reads Daytona command status before its log snapshot", async () => {
  const { calls, sandbox } = processDouble({
    command: { exitCode: 0 },
    logs: { stdout: "" },
  });
  await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox,
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
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    harness: "copilot" as const,
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout },
    }).sandbox,
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
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({
      command: { exitCode: 0 },
      logs: { stdout: result },
    }).sandbox,
  });
  assert.equal(fromResult.status, "failed");
  assert.equal(fromResult.exitCode, 1);

  const fallback = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({ command: { exitCode: 1 } }).sandbox,
  });
  assert.equal(fallback.status, "failed");
  assert.equal(fallback.exitCode, 1);
});

test("normalizes optional Daytona log and command fields", async () => {
  const logsAbsent = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({ command: {} }).sandbox,
  });
  assert.deepEqual(logsAbsent.events, []);
  assert.equal(logsAbsent.exitCode, null);
  assert.equal(logsAbsent.status, "running");

  const completedByStatus = await snapshotDaytonaProcess({
    attemptId: PREPARATION_CLAIM,
    commandId: "cmd-1",
    credential: SECRET,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: processDouble({ command: { status: "completed" } }).sandbox,
  });
  assert.equal(completedByStatus.exitCode, null);
  assert.equal(completedByStatus.status, "completed");
});

test("the Daytona SDK Sandbox process shape is assignable", () => {
  const acceptsSdkSandbox = (sandbox: Sandbox): DaytonaProcessSandbox =>
    sandbox;
  assert.equal(typeof acceptsSdkSandbox, "function");
});

test("derives its stop target from run and attempt IDs and ignores caller session IDs", async () => {
  const externalSessionId = "coven-run-8f5c24f2-9dc2-4874-b635-e1d4bf03674a";
  const legacyInput = {
    attemptId: PREPARATION_CLAIM,
    runId: RUN_ID,
    sessionId: externalSessionId,
  };
  const { calls, sandbox, sessionIds } = processDouble({
    sessions: [
      { commands: [], sessionId: SESSION },
      { commands: [], sessionId: externalSessionId },
    ],
  });

  assert.deepEqual(await stopDaytonaProcess(sandbox, legacyInput), {
    kind: "stopped",
  });
  assert.deepEqual(
    calls.filter((call) => call.kind === "delete").map((call) => call.command),
    [SESSION]
  );
  assert.deepEqual(sessionIds(), [externalSessionId]);
});

test("rejects invalid stop IDs before any Daytona mutation", async () => {
  const { calls, sandbox } = processDouble();

  await assert.rejects(
    () =>
      stopDaytonaProcess(sandbox, {
        attemptId: PREPARATION_CLAIM,
        runId: "../unsafe",
      }),
    /UUID run id/u
  );
  await assert.rejects(
    () =>
      stopDaytonaProcess(sandbox, {
        attemptId: "../unsafe" as DaytonaAttemptId,
        runId: RUN_ID,
      }),
    /UUID attempt id/u
  );

  assert.deepEqual(calls, []);
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
  await sweepDaytonaCredentials(sandbox, [
    { attemptId: PREPARATION_CLAIM, runId: RUN_ID },
    { attemptId: PREPARATION_CLAIM, runId: RUN_ID },
  ]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.command.includes(PATH));
  assert.equal(calls[0]?.command.includes(SECRET), false);
  assert.equal(calls[0]?.env, undefined);
});

test("a delayed old attempt can only clean its own names after replacement starts", async () => {
  const attemptB = "53af1a29-4e98-43d6-ac5b-3b9dcba5e732" as DaytonaAttemptId;
  const sessionB = daytonaRunSessionName(RUN_ID, attemptB);
  const pathB = daytonaRunCredentialPath(RUN_ID, attemptB);
  const { calls, sandbox, sessionIds } = processDouble();

  await startDaytonaProcess(startInput(sandbox));
  assert.deepEqual(sessionIds(), [SESSION]);
  assert.deepEqual(await stopDaytonaProcess(sandbox, stopInput), {
    kind: "stopped",
  });
  await startDaytonaProcess({
    ...startInput(sandbox),
    authorizePreparation: async () => attemptB,
  });
  assert.deepEqual(sessionIds(), [sessionB]);

  const delayedCleanupCalls = calls.length;
  await stopDaytonaProcess(sandbox, stopInput);
  assert.deepEqual(sessionIds(), [sessionB]);
  assert.equal(
    calls
      .slice(delayedCleanupCalls)
      .filter((call) => call.kind === "delete")
      .some((call) => call.command === sessionB),
    false
  );
  assert.equal(
    calls
      .slice(delayedCleanupCalls)
      .filter((call) => call.kind === "command")
      .some((call) => call.command.includes(pathB)),
    false
  );

  const beforeDeniedStart = calls.length;
  await assert.rejects(() =>
    startDaytonaProcess({
      ...startInput(sandbox),
      authorizePreparation: async () => null,
    })
  );
  assert.equal(calls.length, beforeDeniedStart);
});
