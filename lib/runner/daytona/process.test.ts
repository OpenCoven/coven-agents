// biome-ignore-all lint/suspicious/useAwait: Daytona doubles intentionally preserve SDK promise signatures.
import assert from "node:assert/strict";
import test from "node:test";
import {
  DaytonaGoneError,
  DaytonaNotFoundError,
  DaytonaTimeoutError,
  type Sandbox,
} from "@daytona/sdk";
import type { RunnerDispatchAuthority } from "../types";
import {
  daytonaRunCredentialPath,
  daytonaRunSessionName,
  daytonaRunWorkingDirectory,
} from "./names";
import type { DaytonaAttemptId, DaytonaProcessSandbox } from "./process";
import {
  DaytonaProbeCleanupPendingError,
  DaytonaProcessError,
  inspectRestrictedWorkspace,
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
const CONFIG_DIRECTORY = `/run/coven-agents/${SESSION}/copilot`;
const ATTEMPT_DIRECTORY = daytonaRunWorkingDirectory(RUN_ID, PREPARATION_CLAIM);
const PROBE_SESSION_ID = `coven-probe-${"a".repeat(40)}`;
const LAUNCH_AUTHORITY = {
  expectedVersion: 9,
  leaseToken: "lease-a",
  runId: RUN_ID,
} as RunnerDispatchAuthority;

function settlesWithin<T>(promise: Promise<T>, milliseconds = 100): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("operation did not settle promptly")),
      milliseconds
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

test("normal harness probes retain bounded executeCommand timeout configuration", async () => {
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
  const now = 1_800_000_000_000;
  const replacement = `coven-probe-${"b".repeat(40)}`;
  const sessions = new Set([replacement]);
  let rejectCommand!: (error: Error) => void;
  let ownedSession = "";
  let commandStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  let deletes = 0;
  const sandbox = {
    process: {
      createSession: (sessionId: string) => {
        ownedSession = sessionId;
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
      executeSessionCommand: (
        _sessionId: string,
        _request: unknown,
        timeout?: number
      ) => {
        assert.ok(timeout && timeout > 0 && timeout <= 5);
        commandStarted();
        return new Promise((_resolve, reject) => {
          rejectCommand = reject;
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
    now: () => now,
    sessionId: PROBE_SESSION_ID,
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

  await settlesWithin(assert.rejects(pending, /prewarm deadline exceeded/));
  assert.equal(deletes, 1);
  assert.equal(sessions.has(ownedSession), false);
  assert.equal(sessions.has(replacement), true);
  assert.ok(ownedSession.length <= 63);
  assert.equal(ownedSession, PROBE_SESSION_ID);
  rejectCommand(new Error("late SDK command rejection"));
  await Promise.resolve();
});

test("an aborted probe settles by its deadline when cleanup requests never return", async () => {
  const controller = new AbortController();
  let commandStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    commandStarted = resolve;
  });
  let cleanupLookups = 0;
  const sandbox = {
    process: {
      createSession: () => Promise.resolve(),
      deleteSession: () => Promise.resolve(),
      executeCommand: () =>
        Promise.reject(new Error("prewarm must use a cancellable session")),
      executeSessionCommand: () => {
        commandStarted();
        return new Promise(() => undefined);
      },
      getSessionCommand: () => Promise.resolve({}),
      getSessionCommandLogs: () => Promise.resolve({}),
      listSessions: () => {
        cleanupLookups += 1;
        return new Promise(() => undefined);
      },
    },
  } as DaytonaProcessSandbox;

  const pending = probeDaytonaHarnesses(sandbox, {
    deadline: Date.now() + 5,
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  controller.abort(new Error("prewarm deadline exceeded"));

  await settlesWithin(
    assert.rejects(
      pending,
      (error: unknown) => error instanceof DaytonaProbeCleanupPendingError
    )
  );
  assert.equal(cleanupLookups, 1);
});

test("abort cleanup retries a settled transient delete failure", async () => {
  const controller = new AbortController();
  const sessions = new Set<string>();
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
        if (deletes === 1) {
          return Promise.reject(new Error("transient delete failure"));
        }
        sessions.delete(sessionId);
        return Promise.resolve();
      },
      executeCommand: () =>
        Promise.reject(new Error("prewarm must use a cancellable session")),
      executeSessionCommand: () => {
        commandStarted();
        return new Promise(() => undefined);
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
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  controller.abort(new Error("prewarm deadline exceeded"));

  await settlesWithin(assert.rejects(pending, /prewarm deadline exceeded/));
  assert.equal(deletes, 2);
  assert.equal(sessions.size, 0);
});

test("abort cleanup fails closed when session deletion cannot be verified", async () => {
  const controller = new AbortController();
  const sessions = new Set<string>();
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
      deleteSession: () => {
        deletes += 1;
        return Promise.reject(new Error("persistent delete failure"));
      },
      executeCommand: () =>
        Promise.reject(new Error("prewarm must use a cancellable session")),
      executeSessionCommand: () => {
        commandStarted();
        return new Promise(() => undefined);
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
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  controller.abort(new Error("prewarm deadline exceeded"));

  await settlesWithin(
    assert.rejects(
      pending,
      (error: unknown) => error instanceof DaytonaProbeCleanupPendingError
    )
  );
  assert.equal(deletes, 2);
  assert.equal(sessions.size, 1);
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
    sessionId: PROBE_SESSION_ID,
    signal: new AbortController().signal,
    timeoutSeconds: 5,
  });

  assert.ok(result.every(({ installed }) => installed));
  assert.equal(deletes, 1);
  assert.equal(sessions.size, 0);
});

test("successful probe work reports cleanup pending when deletion is unconfirmed", async () => {
  const controller = new AbortController();
  const sandbox = {
    process: {
      createSession: () => Promise.resolve(),
      deleteSession: () => new Promise(() => undefined),
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
      listSessions: () => new Promise(() => undefined),
    },
  } as DaytonaProcessSandbox;

  await assert.rejects(
    probeDaytonaHarnesses(sandbox, {
      deadline: Date.now() + 5,
      sessionId: PROBE_SESSION_ID,
      signal: controller.signal,
      timeoutSeconds: 5,
    }),
    (error: unknown) => error instanceof DaytonaProbeCleanupPendingError
  );
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
      sessionId: PROBE_SESSION_ID,
      signal: controller.signal,
      timeoutSeconds: 5,
    }),
    /prewarm deadline exceeded/
  );

  assert.equal(deletes, 1);
  assert.equal(sessions.size, 0);
});

test("an aborted rejected create cleans a late session after early absence", async () => {
  const controller = new AbortController();
  const sessions = new Set<string>();
  let createdSessionId = "";
  let createStarted!: () => void;
  let finishCreate!: () => void;
  let earlyCleanupFinished!: () => void;
  const started = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  const earlyCleanup = new Promise<void>((resolve) => {
    earlyCleanupFinished = resolve;
  });
  const creation = new Promise<void>((_resolve, reject) => {
    finishCreate = () => {
      sessions.add(createdSessionId);
      reject(new Error("create response was ambiguous"));
    };
  });
  let deletes = 0;
  let lookups = 0;
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
      listSessions: () => {
        lookups += 1;
        if (lookups === 2) {
          earlyCleanupFinished();
        }
        return Promise.resolve(
          [...sessions].map((sessionId) => ({ commands: [], sessionId }))
        );
      },
    },
  } as DaytonaProcessSandbox;

  const pending = probeDaytonaHarnesses(sandbox, {
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  const abort = new Error("prewarm deadline exceeded");
  controller.abort(abort);
  await earlyCleanup;
  assert.equal(sessions.size, 0);
  finishCreate();

  await assert.rejects(pending, (error: unknown) => error === abort);
  assert.equal(lookups, 4);
  assert.equal(deletes, 1);
  assert.equal(sessions.size, 0);
});

test("an aborted rejected create cleans a recreated pre-existing session after create settles", async () => {
  const controller = new AbortController();
  const sessions = new Set([PROBE_SESSION_ID]);
  let createdSessionId = "";
  let createStarted!: () => void;
  let finishCreate!: () => void;
  let earlyCleanupFinished!: () => void;
  const started = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  const earlyCleanup = new Promise<void>((resolve) => {
    earlyCleanupFinished = resolve;
  });
  const creation = new Promise<void>((_resolve, reject) => {
    finishCreate = () => {
      sessions.add(createdSessionId);
      reject(new Error("create response was ambiguous"));
    };
  });
  let deletes = 0;
  let lookups = 0;
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
      listSessions: () => {
        lookups += 1;
        if (lookups === 2) {
          earlyCleanupFinished();
        }
        return Promise.resolve(
          [...sessions].map((sessionId) => ({ commands: [], sessionId }))
        );
      },
    },
  } as DaytonaProcessSandbox;

  const pending = probeDaytonaHarnesses(sandbox, {
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  const abort = new Error("prewarm deadline exceeded");
  controller.abort(abort);
  await earlyCleanup;
  assert.equal(sessions.size, 0);
  finishCreate();

  await assert.rejects(pending, (error: unknown) => error === abort);
  assert.equal(lookups, 4);
  assert.equal(deletes, 2);
  assert.equal(sessions.size, 0);
});

test("a late successful create sequences cleanup and retains its abort reason", async () => {
  const controller = new AbortController();
  const replacement = `coven-probe-${"b".repeat(40)}`;
  const sessions = new Set([replacement]);
  let createdSessionId = "";
  let createStarted!: () => void;
  let finishCreate!: () => void;
  let earlyCleanupStarted!: () => void;
  let finishEarlyCleanup!: () => void;
  const started = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  const earlyCleanupStartedPromise = new Promise<void>((resolve) => {
    earlyCleanupStarted = resolve;
  });
  const earlyCleanupResult = new Promise<readonly []>((resolve) => {
    finishEarlyCleanup = () => resolve([]);
  });
  const creation = new Promise<void>((resolve) => {
    finishCreate = () => {
      sessions.add(createdSessionId);
      resolve();
    };
  });
  let deletes = 0;
  let lookups = 0;
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
      listSessions: () => {
        lookups += 1;
        if (lookups === 2) {
          earlyCleanupStarted();
          return earlyCleanupResult;
        }
        return Promise.resolve(
          [...sessions].map((sessionId) => ({ commands: [], sessionId }))
        );
      },
    },
  } as DaytonaProcessSandbox;

  const pending = probeDaytonaHarnesses(sandbox, {
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  const abort = new Error("prewarm deadline exceeded");
  controller.abort(abort);
  await earlyCleanupStartedPromise;
  finishCreate();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lookups, 2);
  assert.equal(deletes, 0);
  finishEarlyCleanup();

  await assert.rejects(pending, (error: unknown) => error === abort);
  assert.equal(lookups, 4);
  assert.equal(deletes, 1);
  assert.deepEqual([...sessions], [replacement]);
});

test("a pending first delete prevents a concurrent late delete", async () => {
  const controller = new AbortController();
  const sessions = new Set([PROBE_SESSION_ID]);
  let createStarted!: () => void;
  let finishCreate!: () => void;
  let deleteStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  const creation = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  const deleteStartedPromise = new Promise<void>((resolve) => {
    deleteStarted = resolve;
  });
  let deletes = 0;
  const sandbox = {
    process: {
      createSession: () => {
        createStarted();
        return creation;
      },
      deleteSession: () => {
        deletes += 1;
        deleteStarted();
        return new Promise<void>(() => undefined);
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
    deadline: Date.now() + 20,
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  controller.abort(new Error("prewarm deadline exceeded"));
  await deleteStartedPromise;
  finishCreate();

  await settlesWithin(
    assert.rejects(
      pending,
      (error: unknown) => error instanceof DaytonaProbeCleanupPendingError
    )
  );
  assert.equal(deletes, 1);
  assert.deepEqual([...sessions], [PROBE_SESSION_ID]);
});

test("a late successful create retries a settled failed delete", async () => {
  const controller = new AbortController();
  const sessions = new Set([PROBE_SESSION_ID]);
  let createStarted!: () => void;
  let finishCreate!: () => void;
  let deleteStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  const creation = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  const deleteStartedPromise = new Promise<void>((resolve) => {
    deleteStarted = resolve;
  });
  let deletes = 0;
  const sandbox = {
    process: {
      createSession: () => {
        createStarted();
        return creation;
      },
      deleteSession: () => {
        deletes += 1;
        deleteStarted();
        if (deletes === 1) {
          return Promise.reject(new Error("transient delete failure"));
        }
        sessions.delete(PROBE_SESSION_ID);
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
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  controller.abort(new Error("prewarm deadline exceeded"));
  await deleteStartedPromise;
  finishCreate();

  await settlesWithin(assert.rejects(pending, /prewarm deadline exceeded/));
  assert.equal(deletes, 2);
  assert.equal(sessions.size, 0);
});

test("a late successful create retains cleanup pending after repeated delete failure", async () => {
  const controller = new AbortController();
  const sessions = new Set([PROBE_SESSION_ID]);
  let createStarted!: () => void;
  let finishCreate!: () => void;
  let deleteStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    createStarted = resolve;
  });
  const creation = new Promise<void>((resolve) => {
    finishCreate = resolve;
  });
  const deleteStartedPromise = new Promise<void>((resolve) => {
    deleteStarted = resolve;
  });
  let deletes = 0;
  const sandbox = {
    process: {
      createSession: () => {
        createStarted();
        return creation;
      },
      deleteSession: () => {
        deletes += 1;
        deleteStarted();
        return Promise.reject(new Error("persistent delete failure"));
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
    sessionId: PROBE_SESSION_ID,
    signal: controller.signal,
    timeoutSeconds: 5,
  });
  await started;
  controller.abort(new Error("prewarm deadline exceeded"));
  await deleteStartedPromise;
  finishCreate();

  await settlesWithin(
    assert.rejects(
      pending,
      (error: unknown) => error instanceof DaytonaProbeCleanupPendingError
    )
  );
  assert.equal(deletes, 2);
  assert.deepEqual([...sessions], [PROBE_SESSION_ID]);
});

type Call = { command: string; env?: Record<string, string>; kind: string };
type FileCall = { bytes?: Buffer; kind: string; mode?: string; path: string };

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
    inspectionExitCode?: number;
    listError?: Error;
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
  const fileCalls: FileCall[] = [];
  let deleteCalls = 0;
  let listCalls = 0;
  let sessions = [...(options.sessions ?? [])];
  const sandbox: DaytonaProcessSandbox = {
    fs: {
      createFolder: (path, mode) => {
        fileCalls.push({ kind: "createFolder", mode, path });
        return Promise.resolve();
      },
      deleteFile: (path) => {
        fileCalls.push({ kind: "deleteFile", path });
        return Promise.resolve();
      },
      setFilePermissions: (path, permissions) => {
        fileCalls.push({
          kind: "setFilePermissions",
          mode: permissions.mode,
          path,
        });
        return Promise.resolve();
      },
      uploadFile: (bytes, path) => {
        fileCalls.push({
          bytes: Buffer.from(bytes),
          kind: "uploadFile",
          path,
        });
        return Promise.resolve();
      },
    },
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
        if (
          options.inspectionExitCode !== undefined &&
          command.includes('root="$(pwd -P)"')
        ) {
          return Promise.resolve({ exitCode: options.inspectionExitCode });
        }
        if (command.includes("umask 077")) {
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
          return Promise.reject(
            options.listError ?? new Error("lookup unavailable")
          );
        }
        return Promise.resolve(sessions);
      },
    },
  };
  return {
    calls,
    fileCalls,
    sandbox,
    sessionIds: () => sessions.map((session) => session.sessionId),
  };
}

const startInput = (sandbox: DaytonaProcessSandbox) => ({
  authorizeLaunch: async () => LAUNCH_AUTHORITY,
  authorizePreparation: async () => PREPARATION_CLAIM,
  authorizeUnrestrictedExecution: async () => true,
  credential: { credential: SECRET },
  deleteAttemptRedaction: async () => true,
  executionPermission: "unrestricted" as const,
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

test("ambiguous staging or launch preserves redaction and the durable attempt fence", async () => {
  await Promise.all(
    [
      { stageError: new DaytonaTimeoutError(SECRET) },
      { startError: new DaytonaTimeoutError(SECRET) },
      { startId: "" },
    ].map(async (options) => {
      const { calls, sandbox } = processDouble(options);
      let retired = 0;
      let released = 0;
      await assert.rejects(
        startDaytonaProcess({
          ...startInput(sandbox),
          deleteAttemptRedaction: () => {
            retired += 1;
            return Promise.resolve(true);
          },
          releasePreparation: () => {
            released += 1;
            return Promise.resolve(LAUNCH_AUTHORITY);
          },
        }),
        (error: unknown) =>
          error instanceof DaytonaProcessError &&
          error.code === "sandbox_reuse_required" &&
          !allReturnedText(error).includes(SECRET)
      );
      assert.equal(retired, 0);
      assert.equal(released, 0);
      assert.ok(
        calls.some((call) => call.command.includes(`test ! -L '${PATH}'`))
      );
    })
  );
});

test("session stop errors never skip exact credential and capability cleanup", async () => {
  await Promise.all(
    [new Error(SECRET), new DaytonaTimeoutError(SECRET)].map(async (error) => {
      const { calls, fileCalls, sandbox } = processDouble({
        deleteError: error,
      });
      const stopped = await stopDaytonaProcess(sandbox, {
        attemptId: PREPARATION_CLAIM,
        runId: RUN_ID,
      });
      assert.ok(
        calls.some((call) => call.command.includes(`test ! -L '${PATH}'`))
      );
      assert.ok(fileCalls.some((call) => call.kind === "deleteFile"));
      assert.equal(JSON.stringify(stopped).includes(SECRET), false);
      assert.notEqual(stopped.kind, "stopped");
      assert.notEqual(stopped.kind, "provider_not_found");
    })
  );
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
  assert.deepEqual(Object.keys(stage?.env ?? {}), ["COPILOT_GITHUB_TOKEN"]);
  assert.equal(
    stage?.command,
    [
      "umask 077",
      `printf '%s' "$COPILOT_GITHUB_TOKEN" > '${PATH}'`,
      `chmod 600 '${PATH}'`,
      `[ "$(stat -c '%a' '${PATH}' 2>/dev/null || stat -f '%Lp' '${PATH}')" = 600 ]`,
    ].join(" && ")
  );
  assert.equal(
    calls.filter((call) => call.kind === "command" && call.env !== undefined)
      .length,
    1
  );
  for (const serverOnlySecret of [
    "AUTH_SECRET",
    "CREDENTIAL_KEK",
    "DAYTONA_API_KEY",
    "OPERATOR_DIAGNOSTIC_TOKEN",
    "RUNNER_MANUAL_RECONCILE_SECRET",
  ]) {
    assert.equal(
      Object.hasOwn(stage?.env ?? {}, serverOnlySecret),
      false,
      `${serverOnlySecret} must not enter the sandbox`
    );
  }
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
      `rm -rf -- '${CONFIG_DIRECTORY}'`,
      `mkdir -p -- '${CONFIG_DIRECTORY}'`,
      `chmod 700 '${CONFIG_DIRECTORY}'`,
      `export HOME='${CONFIG_DIRECTORY}'`,
      `COPILOT_GITHUB_TOKEN="$(cat -- '${PATH}')"`,
      "export COPILOT_GITHUB_TOKEN",
      `rm -f -- '${PATH}'`,
      "unset GH_TOKEN GITHUB_TOKEN CODEX_API_KEY CLAUDE_CODE_OAUTH_TOKEN AI_GATEWAY_API_KEY ANTHROPIC_API_KEY AZURE_OPENAI_API_KEY GOOGLE_API_KEY OPENAI_API_KEY ABUSE_KEY_SECRET AUTH_GITHUB_SECRET AUTH_SECRET BLOB_READ_WRITE_TOKEN CREDENTIAL_KEK CREDENTIAL_KEK_CURRENT_VERSION CREDENTIAL_KEK_V1 CREDENTIAL_KEK_V2 CRON_SECRET DAYTONA_API_KEY OPERATOR_DIAGNOSTIC_TOKEN POSTGRES_URL REDIS_URL RUNNER_MANUAL_RECONCILE_SECRET STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET",
      "export CI=true",
      "mkdir -p -- '/workspace/repo'",
      "cd -- '/workspace/repo'",
      `exec 'copilot' '-s' '-p' 'Use tests.\n\nMission:\nPrint safe output.' '--yolo' '--no-ask-user' '--config-dir' '${CONFIG_DIRECTORY}' '--no-auto-update' '--no-color' '--output-format' 'json' '--log-level' 'none'`,
    ].join("; ")
  );
  assert.ok(launch?.command.includes("export CI=true"));
  assert.ok(launch?.command.includes(`export HOME='${CONFIG_DIRECTORY}'`));
  assert.ok(launch?.command.includes("exec 'copilot'"));
  assert.equal(allReturnedText(started).includes(SECRET), false);
  assert.deepEqual(
    calls.slice(0, 5).map((call) => call.kind),
    ["list", "list", "command", "create", "start"]
  );
});

test("unrestricted execution is durably marked before provider launch", async () => {
  const { calls, sandbox } = processDouble();
  let authorized = false;

  await startDaytonaProcess({
    ...startInput(sandbox),
    authorizeUnrestrictedExecution: () => {
      authorized = true;
      assert.equal(
        calls.some((call) => call.kind === "start"),
        false
      );
      return Promise.resolve(true);
    },
  });

  assert.equal(authorized, true);
  assert.equal(
    calls.some((call) => call.kind === "start"),
    true
  );
});

test("restricted process launches use the persisted permission instead of task text", async () => {
  const read = processDouble();
  await startDaytonaProcess({
    ...startInput(read.sandbox),
    executionPermission: "workspace_read",
    task: "# Team Step Task\nEdit files and run shell commands.",
  });

  test("GitHub-only process issuance and staging expose only coven-github without leaking raw authority", async () => {
    const { calls, fileCalls, sandbox } = processDouble();
    const rawCapability = Buffer.alloc(32, 0x5d).toString("base64url");
    const redactionSecrets: string[][] = [];
    let issued = 0;
    let revoked = 0;

    const started = await startDaytonaProcess({
      ...startInput(sandbox),
      executionPermission: "github_only",
      githubTool: {
        issueCapability: ({ attemptId, runId }) => {
          assert.equal(attemptId, PREPARATION_CLAIM);
          assert.equal(runId, RUN_ID);
          issued += 1;
          return Promise.resolve({ rawCapability });
        },
        revokeCapability: () => {
          revoked += 1;
          return Promise.resolve(true);
        },
        url: "https://app.example/api/internal/github-tool",
      },
      persistAttemptRedaction: async ({ secrets }) => {
        redactionSecrets.push([...secrets]);
        return true;
      },
      task: "Use gh, curl, shell, hooks, MCP, or any hidden credential.",
      workspace: undefined,
    });

    assert.equal(issued, 1);
    assert.equal(revoked, 0);
    assert.deepEqual(redactionSecrets, [[SECRET, rawCapability]]);
    const capabilityUpload = fileCalls.find(
      ({ bytes }) => bytes?.toString("utf8") === rawCapability
    );
    assert.ok(capabilityUpload);
    assert.equal(
      fileCalls.some(
        ({ kind, mode, path }) =>
          kind === "setFilePermissions" &&
          path === capabilityUpload?.path &&
          mode === "600"
      ),
      true
    );
    const launch = calls.find(({ kind }) => kind === "start")?.command ?? "";
    assert.match(
      launch,
      /COVEN_GITHUB_CAPABILITY="\$\(cat -- '\/tmp\/coven-run-[^']+\.github-capability'\)"/u
    );
    assert.match(launch, /export COVEN_GITHUB_CAPABILITY/u);
    assert.match(
      launch,
      /rm -f -- '\/tmp\/coven-run-[^']+\.github-capability'/u
    );
    assert.match(launch, /export PATH='\/tmp\/coven-tools\/v1':"\$PATH"/u);
    assert.match(
      launch,
      /export COVEN_GITHUB_TOOL_URL='https:\/\/app\.example\/api\/internal\/github-tool'/u
    );
    assert.match(
      launch,
      /--available-tools' 'CovenGitHub-execute' '--allow-tool' 'CovenGitHub\(execute\)'/u
    );
    assert.match(
      launch,
      /--additional-mcp-config' '\{"mcpServers":\{"CovenGitHub":\{"args":\[\],"command":"\/tmp\/coven-tools\/v1\/coven-github-mcp","env":\{"COVEN_GITHUB_CAPABILITY":"\$\{COVEN_GITHUB_CAPABILITY\}","COVEN_GITHUB_TOOL_URL":"\$\{COVEN_GITHUB_TOOL_URL\}"\},"timeout":85000,"tools":\["execute"\],"type":"local"\}\}\}'/u
    );
    assert.doesNotMatch(
      launch,
      /--available-tools' '(?:view|shell)|--yolo|shell\(coven-github/u
    );
    assert.ok(
      launch.indexOf("rm -f --") < launch.indexOf("exec 'copilot'"),
      "capability file must be deleted before harness exec"
    );
    assert.equal(JSON.stringify(calls).includes(rawCapability), false);
    assert.equal(JSON.stringify(started).includes(rawCapability), false);
  });

  test("a failed GitHub process start revokes capability and sweeps its staged file", async () => {
    const { fileCalls, sandbox } = processDouble({
      startError: new Error("ambiguous start"),
    });
    const rawCapability = Buffer.alloc(32, 0x5e).toString("base64url");
    let revoked = 0;

    await assert.rejects(
      startDaytonaProcess({
        ...startInput(sandbox),
        executionPermission: "github_only",
        githubTool: {
          issueCapability: () => Promise.resolve({ rawCapability }),
          revokeCapability: () => {
            revoked += 1;
            return Promise.resolve(true);
          },
          url: "https://app.example/api/internal/github-tool",
        },
        persistAttemptRedaction: async () => true,
        workspace: undefined,
      }),
      (error: unknown) =>
        error instanceof DaytonaProcessError &&
        !allReturnedText(error).includes(rawCapability)
    );

    assert.equal(revoked, 1);
    assert.equal(
      fileCalls.some(
        ({ kind, path }) =>
          kind === "deleteFile" && path.endsWith(".github-capability")
      ),
      true
    );
  });
  const readLaunch = read.calls.find((call) => call.kind === "start")?.command;
  const restrictedCreateIndex = read.calls.findIndex(
    (call) => call.kind === "create"
  );
  const restrictedStageIndex = read.calls.findIndex(
    (call) => call.kind === "command" && call.command.includes("umask 077")
  );
  assert.ok(
    restrictedCreateIndex >= 0 && restrictedStageIndex > restrictedCreateIndex
  );
  assert.match(readLaunch ?? "", /--available-tools' 'view,rg,glob/u);
  assert.doesNotMatch(readLaunch ?? "", /--yolo/u);
  assert.doesNotMatch(readLaunch ?? "", /--allow-tool' 'write/u);
  assert.match(readLaunch ?? "", /--disable-builtin-mcps/u);
  assert.match(
    readLaunch ?? "",
    /"disableAllHooks":true,"extensions":\{"mode":"disabled"\}.*settings\.json/u
  );
  assert.ok(
    (readLaunch?.indexOf(
      "unset COPILOT_ALLOW_ALL GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS"
    ) ?? -1) >= 0 &&
      (readLaunch?.indexOf(
        "unset COPILOT_ALLOW_ALL GITHUB_COPILOT_PROMPT_MODE_EXTENSIONS"
      ) ?? Number.MAX_SAFE_INTEGER) <
        (readLaunch?.indexOf('COPILOT_GITHUB_TOKEN="$(cat') ??
          Number.MIN_SAFE_INTEGER)
  );
  assert.ok(
    (readLaunch?.indexOf(`chmod 500 '${ATTEMPT_DIRECTORY}'`) ?? -1) >= 0 &&
      (readLaunch?.indexOf(`chmod 500 '${ATTEMPT_DIRECTORY}'`) ??
        Number.MAX_SAFE_INTEGER) <
        (readLaunch?.indexOf('COPILOT_GITHUB_TOKEN="$(cat') ??
          Number.MIN_SAFE_INTEGER)
  );
  assert.match(
    readLaunch ?? "",
    new RegExp(`'-C' '${ATTEMPT_DIRECTORY}' '--add-dir' '/workspace/repo'`, "u")
  );
  assert.match(
    readLaunch ?? "",
    new RegExp(`cd -- '${ATTEMPT_DIRECTORY}'`, "u")
  );
  assert.ok(
    (readLaunch?.indexOf(".mcp.json") ?? -1) >= 0 &&
      (readLaunch?.indexOf(".mcp.json") ?? Number.MAX_SAFE_INTEGER) <
        (readLaunch?.indexOf('COPILOT_GITHUB_TOKEN="$(cat') ??
          Number.MIN_SAFE_INTEGER)
  );
  assert.ok(
    readLaunch?.includes(`export COPILOT_HOME='${CONFIG_DIRECTORY}'`) ?? false
  );

  const ordinary = processDouble();
  await startDaytonaProcess({
    ...startInput(ordinary.sandbox),
    executionPermission: "unrestricted",
    task: "# Team Step Task\nOrdinary task text.",
  });
  const ordinaryLaunch = ordinary.calls.find(
    (call) => call.kind === "start"
  )?.command;
  assert.match(ordinaryLaunch ?? "", /--yolo/u);
  assert.doesNotMatch(ordinaryLaunch ?? "", /--available-tools/u);
  assert.doesNotMatch(ordinaryLaunch ?? "", /disableAllHooks/u);
});

test("restricted process staging requires the owned session to be exclusive", async () => {
  const { calls, sandbox } = processDouble({
    sessions: [{ commands: [], sessionId: "other-session" }],
  });

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        authorizeUnrestrictedExecution: () =>
          Promise.reject(
            new Error("restricted runs must not mark unrestricted trust")
          ),
        executionPermission: "workspace_read",
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "process_start_failed"
  );
  assert.equal(
    calls.some(
      (call) => call.kind === "command" && call.command.includes("umask 077")
    ),
    false
  );
});

test("restricted process launches reject a missing workspace before provider mutation", async () => {
  const { calls, sandbox } = processDouble();

  await assert.rejects(
    () =>
      startDaytonaProcess({
        ...startInput(sandbox),
        executionPermission: "workspace_read",
        workspace: undefined,
      }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "workspace_required"
  );
  assert.deepEqual(calls, []);
});

test("restricted workspace configuration is rejected before preparation or credential staging", async () => {
  const { calls, sandbox } = processDouble({ inspectionExitCode: 42 });
  let preparations = 0;

  await assert.rejects(
    startDaytonaProcess({
      ...startInput(sandbox),
      authorizePreparation: async () => {
        preparations += 1;
        return PREPARATION_CLAIM;
      },
      executionPermission: "workspace_read",
    }),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "process_start_failed" &&
      error.retryable === false
  );

  assert.equal(preparations, 0);
  assert.equal(
    calls.some(({ command }) => command.includes("umask 077")),
    false
  );
});

test("GitHub-only launches do not inspect an unmounted workspace", async () => {
  const { calls, fileCalls, sandbox } = processDouble({
    inspectionExitCode: 42,
  });
  let issued = 0;
  let preparations = 0;

  const result = await startDaytonaProcess({
    ...startInput(sandbox),
    authorizePreparation: async () => {
      preparations += 1;
      return PREPARATION_CLAIM;
    },
    executionPermission: "github_only",
    githubTool: {
      issueCapability: async () => {
        issued += 1;
        return {
          rawCapability: Buffer.alloc(32, 0x5f).toString("base64url"),
        };
      },
      revokeCapability: async () => true,
      url: "https://app.example/api/internal/github-tool",
    },
    workspace: undefined,
  });

  assert.equal(result.attemptId, PREPARATION_CLAIM);
  assert.equal(preparations, 1);
  assert.equal(issued, 1);
  assert.equal(
    calls.some(({ command }) => command.includes(".mcp.json")),
    false
  );
  assert.ok(fileCalls.length > 0);
});

test("restricted workspace inspection rejects repository hook and settings sources", async () => {
  const commands: string[] = [];
  const inspectionCwds: (string | undefined)[] = [];
  const safe = await inspectRestrictedWorkspace(
    {
      process: {
        executeCommand: (command: string, cwd?: string) => {
          commands.push(command);
          inspectionCwds.push(cwd);
          return Promise.resolve({ exitCode: 0 });
        },
        listSessions: () => Promise.resolve([]),
      },
    } as unknown as DaytonaProcessSandbox,
    "/workspace/repo"
  );
  assert.deepEqual(safe, { kind: "safe" });
  for (const path of [
    ".github/hooks",
    ".github/copilot/settings.json",
    ".github/copilot/settings.local.json",
    ".mcp.json",
    ".github/mcp.json",
    ".vscode/mcp.json",
    ".github/extensions",
    ".github/lsp.json",
    ".github/agents",
    ".github/skills",
    ".copilot/mcp-config.json",
    ".copilot/settings.json",
    ".claude/settings.json",
    ".claude/settings.local.json",
  ]) {
    assert.ok(commands[0]?.includes(path), path);
  }
  assert.deepEqual(inspectionCwds, ["/workspace"]);
  assert.match(commands[0] ?? "", /mkdir -p -- '\/workspace\/repo'/u);
  assert.match(commands[0] ?? "", /cd -- '\/workspace\/repo'/u);

  const unsafe = await inspectRestrictedWorkspace(
    {
      process: {
        executeCommand: () => Promise.resolve({ exitCode: 42 }),
        listSessions: () => Promise.resolve([]),
      },
    } as unknown as DaytonaProcessSandbox,
    "/workspace/repo"
  );
  assert.deepEqual(unsafe, { kind: "unsafe" });

  const unavailable = await inspectRestrictedWorkspace(
    {
      process: {
        executeCommand: () => Promise.reject(new Error(SECRET)),
        listSessions: () => Promise.resolve([]),
      },
    } as unknown as DaytonaProcessSandbox,
    "/workspace/repo"
  );
  assert.deepEqual(unavailable, { kind: "unavailable" });
  assert.equal(JSON.stringify(unavailable).includes(SECRET), false);

  let inspected = false;
  const concurrent = await inspectRestrictedWorkspace(
    {
      process: {
        executeCommand: () => {
          inspected = true;
          return Promise.resolve({ exitCode: 0 });
        },
        listSessions: () =>
          Promise.resolve([{ commands: [], sessionId: "other-session" }]),
      },
    } as unknown as DaytonaProcessSandbox,
    "/workspace/repo"
  );
  assert.deepEqual(concurrent, { kind: "unavailable" });
  assert.equal(inspected, false);

  assert.deepEqual(
    await inspectRestrictedWorkspace(
      {
        process: {
          executeCommand: () => {
            throw new Error("escaped workspace must not execute");
          },
          listSessions: () => Promise.resolve([]),
        },
      } as unknown as DaytonaProcessSandbox,
      "../../etc"
    ),
    { kind: "unsafe" }
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
  const { sandbox } = processDouble({ stageExitCode: 1 });
  const redaction: string[] = [];

  await assert.rejects(() =>
    startDaytonaProcess({
      ...startInput(sandbox),
      deleteAttemptRedaction: ({ attemptId, runId }) => {
        redaction.push(`delete:${attemptId}:${runId}`);
        return Promise.resolve(true);
      },
      persistAttemptRedaction: ({ attemptId, runId, secrets }) => {
        assert.deepEqual(secrets, [SECRET]);
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

test("cleans exact resources but retains the attempt when launch authorization is rejected", async () => {
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
      error.code === "sandbox_reuse_required" &&
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
        call.command ===
          `rm -f -- '${PATH}' && test ! -e '${PATH}' && test ! -L '${PATH}'`
    )
  );
  assert.deepEqual(sessionIds(), []);
  assert.deepEqual(releases, []);
});

test("cleans exact resources and preserves the fence when launch authorization throws", async () => {
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
      error.code === "sandbox_reuse_required" &&
      error.retryable === false &&
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
        call.command ===
          `rm -f -- '${PATH}' && test ! -e '${PATH}' && test ! -L '${PATH}'`
    )
  );
  assert.ok(calls.some((call) => call.kind === "delete"));
  assert.deepEqual(sessionIds(), []);
  assert.deepEqual(releases, []);
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
      assert.deepEqual(
        releases,
        sessionCleanup || "stageError" in options
          ? []
          : [{ attemptId: PREPARATION_CLAIM, runId: RUN_ID }]
      );
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

test("a stale deterministic session requires reset without staging a new credential", async () => {
  const { calls, sandbox } = processDouble({
    sessions: [{ commands: [], sessionId: SESSION }],
  });

  await assert.rejects(
    startDaytonaProcess(startInput(sandbox)),
    (error: unknown) =>
      error instanceof DaytonaProcessError &&
      error.code === "sandbox_reuse_required"
  );

  assert.deepEqual(
    calls.slice(0, 4).map((call) => call.kind),
    ["list", "delete", "list", "command"]
  );
  assert.equal(calls.filter((call) => call.kind === "start").length, 0);
  assert.equal(
    calls.some((call) => call.env !== undefined),
    false
  );
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
    stageExitCode: 1,
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
        call.command ===
          `rm -f -- '${PATH}' && test ! -e '${PATH}' && test ! -L '${PATH}'`
    )
  );
});

test("a stale attempt release cannot request a reset of a replacement attempt's sandbox", async () => {
  const attemptB = "53af1a29-4e98-43d6-ac5b-3b9dcba5e732" as DaytonaAttemptId;
  const sessionB = daytonaRunSessionName(RUN_ID, attemptB);
  const { calls, sandbox, sessionIds } = processDouble({
    sessions: [{ commands: [], sessionId: sessionB }],
    stageExitCode: 1,
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

test("redacts exact Daytona identifiers before returning an attempt log snapshot", async () => {
  const tenantCredential = "tenant-credential-daytona-adapter";
  const daytonaApiKey = [
    "sk",
    "proj",
    "syntheticdaytonaapikeyfixture000000",
  ].join("-");
  const reconcileBearer = "manual-reconcile-service-bearer";
  const signedClaim = [
    "eyJhbGciOiJIUzI1NiJ9",
    "eyJzdWIiOiJmaXh0dXJlIn0",
    "c2lnbmVkLWRheXRvbmEtYWRhcHRlcg",
  ].join(".");
  const sandboxId = "daytona-sandbox-adapter-id";
  const sandboxName = "daytona-sandbox-adapter-name";
  const commandId = "daytona-command-adapter-id";
  const attemptId = "63af1a29-4e98-43d6-ac5b-3b9dcba5e730" as DaytonaAttemptId;
  const sessionId = daytonaRunSessionName(RUN_ID, attemptId);
  const planted = [
    tenantCredential,
    daytonaApiKey,
    `Bearer ${reconcileBearer}`,
    signedClaim,
    sandboxId,
    sandboxName,
    sessionId,
    commandId,
    attemptId,
  ].join(" | ");
  const stdout = [
    JSON.stringify({
      data: { content: planted, model: planted },
      type: "assistant.message",
    }),
    JSON.stringify({
      data: {
        arguments: { command: planted },
        toolCallId: planted,
        toolName: planted,
      },
      type: "tool.execution_start",
    }),
    JSON.stringify({
      data: {
        result: { content: planted },
        success: false,
        toolCallId: planted,
      },
      type: "tool.execution_complete",
    }),
    JSON.stringify({
      data: { infoType: "file_edited", message: `/workspace/${planted}.md` },
      type: "session.info",
    }),
    JSON.stringify({
      exitCode: 1,
      sessionId,
      type: "result",
      usage: { codeChanges: { filesModified: [`/workspace/${planted}.md`] } },
    }),
  ].join("\n");
  const { sandbox } = processDouble({
    command: { exitCode: 1 },
    logs: { stdout: `${stdout}\n` },
  });

  const snapshot = await snapshotDaytonaProcess({
    attemptId,
    commandId,
    credential: tenantCredential,
    cursor: 0,
    harness: "copilot",
    runId: RUN_ID,
    sandbox: { ...sandbox, id: sandboxId, name: sandboxName },
  });
  const returned = JSON.stringify(snapshot);

  for (const value of [
    tenantCredential,
    daytonaApiKey,
    reconcileBearer,
    signedClaim,
    sandboxId,
    sandboxName,
    sessionId,
    commandId,
    attemptId,
  ]) {
    assert.equal(returned.includes(value), false, `leaked ${value}`);
  }
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

  assert.equal(
    (await stopDaytonaProcess(sandbox, legacyInput)).kind,
    "cleanup_required"
  );
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

test("session absence and cleanup failure both retain a non-destructive reset obligation", async () => {
  const stopped = await stopDaytonaProcess(processDouble().sandbox, stopInput);
  assert.equal(stopped.kind, "cleanup_required");

  const reset = await stopDaytonaProcess(
    processDouble({
      deleteLeavesSession: true,
      sessions: [{ commands: [], sessionId: SESSION }],
    }).sandbox,
    stopInput
  );
  assert.equal(reset.kind, "cleanup_required");
  assert.equal(
    reset.kind === "cleanup_required" && reset.error.code,
    "sandbox_reuse_required"
  );

  const deleteFailed = await stopDaytonaProcess(
    processDouble({ deleteError: new Error(SECRET) }).sandbox,
    stopInput
  );
  assert.equal(deleteFailed.kind, "cleanup_required");
  assert.equal(JSON.stringify(deleteFailed).includes(SECRET), false);

  const retryableDeleteFailed = await stopDaytonaProcess(
    processDouble({ deleteError: new DaytonaTimeoutError("timeout") }).sandbox,
    stopInput
  );
  assert.deepEqual(retryableDeleteFailed, { kind: "provider_unavailable" });

  const retryableLookupFailed = await stopDaytonaProcess(
    processDouble({
      listError: new DaytonaTimeoutError("timeout"),
      listErrorOnCall: 1,
    }).sandbox,
    stopInput
  );
  assert.deepEqual(retryableLookupFailed, { kind: "provider_unavailable" });
});

test("verifies exact credential cleanup without declaring persistent reuse safe", async () => {
  const { calls, fileCalls, sandbox } = processDouble();
  assert.equal(
    (await stopDaytonaProcess(sandbox, stopInput)).kind,
    "cleanup_required"
  );
  assert.ok(
    calls.some(
      (call) =>
        call.kind === "command" &&
        call.command ===
          `rm -f -- '${PATH}' && test ! -e '${PATH}' && test ! -L '${PATH}'` &&
        call.env === undefined
    )
  );
  assert.equal(
    fileCalls.some(
      ({ kind, path }) =>
        kind === "deleteFile" && path.endsWith(".github-capability")
    ),
    true
  );

  const reset = await stopDaytonaProcess(
    processDouble({ cleanupExitCode: 1 }).sandbox,
    stopInput
  );
  assert.equal(reset.kind, "cleanup_required");
  assert.equal(JSON.stringify(reset).includes(SECRET), false);

  const cleanupAmbiguous = await stopDaytonaProcess(
    processDouble({ cleanupError: new Error(SECRET) }).sandbox,
    stopInput
  );
  assert.equal(cleanupAmbiguous.kind, "cleanup_required");
  assert.equal(JSON.stringify(cleanupAmbiguous).includes(SECRET), false);
});

test("404 and 410 session absence still require credential cleanup and approved reset", async () => {
  const absenceErrors = [
    new DaytonaNotFoundError("session missing", 404),
    new DaytonaGoneError("session gone", 410),
  ];

  await Promise.all(
    absenceErrors.map(async (error) => {
      assert.equal(classifyDaytonaProviderError(error), "not_found");
      const { calls, sandbox } = processDouble({ deleteError: error });

      assert.equal(
        (await stopDaytonaProcess(sandbox, stopInput)).kind,
        "cleanup_required"
      );
      assert.equal(
        (await stopDaytonaProcess(sandbox, stopInput)).kind,
        "cleanup_required"
      );
      assert.deepEqual(
        calls.map((call) => call.kind),
        ["delete", "command", "delete", "command"]
      );
      assert.equal(
        calls
          .filter((call) => call.kind === "command")
          .every(
            (call) =>
              call.command ===
              `rm -f -- '${PATH}' && test ! -e '${PATH}' && test ! -L '${PATH}'`
          ),
        true
      );
    })
  );
});

test("sweeps only deterministic credential paths", async () => {
  const { calls, fileCalls, sandbox } = processDouble();
  await sweepDaytonaCredentials(sandbox, [
    { attemptId: PREPARATION_CLAIM, runId: RUN_ID },
    { attemptId: PREPARATION_CLAIM, runId: RUN_ID },
  ]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]?.command.includes(PATH));
  assert.equal(calls[0]?.command.includes(SECRET), false);
  assert.equal(calls[0]?.env, undefined);
  assert.deepEqual(
    fileCalls
      .filter(({ kind }) => kind === "deleteFile")
      .map(({ path }) => path),
    [`/tmp/${SESSION}.github-capability`]
  );
});

test("a delayed old attempt can only clean its own names after replacement starts", async () => {
  const attemptB = "53af1a29-4e98-43d6-ac5b-3b9dcba5e732" as DaytonaAttemptId;
  const sessionB = daytonaRunSessionName(RUN_ID, attemptB);
  const pathB = daytonaRunCredentialPath(RUN_ID, attemptB);
  const { calls, sandbox, sessionIds } = processDouble();

  await startDaytonaProcess(startInput(sandbox));
  assert.deepEqual(sessionIds(), [SESSION]);
  assert.equal(
    (await stopDaytonaProcess(sandbox, stopInput)).kind,
    "cleanup_required"
  );
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
