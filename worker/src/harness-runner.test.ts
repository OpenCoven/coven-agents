import assert from "node:assert/strict";
import test from "node:test";
import {
  HarnessError,
  PROBE_ATTEMPT_TIMEOUT_MS,
  parseHarnessStream,
  RUN_TIMEOUT_MS,
  requireHarness,
  resolveSandboxWorkspace,
  runHarnessInSandbox,
  warmSandbox,
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

const FAKE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

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
        duration: 0,
        exitCode,
        stderr: "",
        stdout: response?.stdout ?? "",
        success: exitCode === 0,
        timestamp: FAKE_TIMESTAMP,
      });
    },
  };
}

test("a missing harness credential is a harness error, not a provider error", () => {
  const error = caught(() => requireHarness("copilot", { credential: null }));
  assert.equal(error.code, "harness_unauthenticated");
  assert.ok(error.message.includes("COPILOT_GITHUB_TOKEN"));
  assert.ok(!error.message.includes("OPENAI_API_KEY"));
});

test("an unsupported harness is refused before anything is spawned", () => {
  const error = caught(() => requireHarness("codex", { credential: "x" }));
  assert.equal(error.code, "harness_unsupported");
});

test("the retired cloud runtime is not a harness", () => {
  const error = caught(() => requireHarness("cloud", { credential: null }));
  assert.equal(error.code, "unknown_harness");
});

test("owner deployment secrets can never satisfy a tenant credential", () => {
  // The single most important test in this change. It sets every owner secret
  // that used to work and asserts the run is still refused. If this ever
  // passes because the run succeeded, tenant isolation is gone.
  const ownerEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: "owner-token",
    CODEX_API_KEY: "owner-token",
    COPILOT_GITHUB_TOKEN: "owner-token",
    GH_TOKEN: "owner-token",
    GITHUB_TOKEN: "owner-token",
  };
  for (const [name, value] of Object.entries(ownerEnv)) {
    process.env[name] = value;
  }

  try {
    assert.throws(
      () => requireHarness("copilot", { credential: null }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === "harness_unauthenticated"
    );
  } finally {
    for (const name of Object.keys(ownerEnv)) {
      // `process.env[x] = undefined` stores the literal string "undefined",
      // which would leak into any later test reading these names.
      delete process.env[name];
    }
  }
});

test("a tenant credential is used verbatim under the harness's env name", () => {
  const { auth } = requireHarness("copilot", { credential: "tenant-token" });

  assert.equal(auth.value, "tenant-token");
  assert.equal(auth.name, "COPILOT_GITHUB_TOKEN");
});

test("a blank tenant credential is not a credential", () => {
  for (const blank of ["", "   ", "\n"]) {
    assert.throws(
      () => requireHarness("copilot", { credential: blank }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === "harness_unauthenticated"
    );
  }
});

test("workspace traversal is refused", () => {
  assert.equal(resolveSandboxWorkspace(), "/workspace");
  assert.equal(resolveSandboxWorkspace("repo"), "/workspace/repo");
  assert.equal(resolveSandboxWorkspace("/workspace/a/../b"), "/workspace/b");
  assert.throws(() => resolveSandboxWorkspace("/etc"), HarnessError);
  assert.throws(() => resolveSandboxWorkspace("../../etc"), HarnessError);
});

test("a workspace bounded by the resolver can still carry a shell payload", () => {
  // Documents the gap the quoting below closes: the resolver's job is where
  // the path points, not what it spells. Both of these are legitimately
  // inside /workspace, and neither is refused — so the caller cannot treat a
  // resolved path as safe to interpolate.
  assert.equal(
    resolveSandboxWorkspace("repo; touch /tmp/pwned"),
    "/workspace/repo; touch /tmp/pwned"
  );
  assert.equal(resolveSandboxWorkspace("repo$(id)"), "/workspace/repo$(id)");
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

test("a sandbox image without the CLI names the fix instead of failing opaquely", async () => {
  const calls: Call[] = [];
  const sandbox = fakeSandbox(
    { "copilot --version": { exitCode: 127 } },
    calls
  );
  await assert.rejects(
    runHarnessInSandbox({
      credential: { credential: "harness-token" },
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

/**
 * The deadline exists because the SDK's own `{ timeout }` option is typed and
 * never read — the compiled runtime contains no reference to it. These tests
 * pin the behaviour that replaced it, with a sandbox whose exec never
 * resolves, which is exactly what a wedged CLI looks like from the Worker.
 */
test("a hanging exec fails the run instead of wedging the agent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const never = new Promise<never>(() => undefined);
  const sandbox = { exec: () => never } as unknown as Parameters<
    typeof runHarnessInSandbox
  >[0]["sandbox"];

  const run = runHarnessInSandbox({
    credential: { credential: "token-under-test" },
    instructions: "instructions",
    model: "auto",
    runtime: "copilot",
    sandbox,
    task: "task",
  });
  // Attached before time advances, or the rejection is unhandled for a tick.
  const outcome = run.then(
    () => null,
    (rejection: unknown) => rejection
  );

  // Two attempts now share the probe budget, and the second attempt's timer
  // only exists after the first fires — a single tick would leave it
  // unscheduled and hang the suite. Tick per attempt, letting the promise
  // chain schedule the next timer between ticks.
  t.mock.timers.tick(PROBE_ATTEMPT_TIMEOUT_MS + 1);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(PROBE_ATTEMPT_TIMEOUT_MS + 1);

  const error = (await outcome) as { code?: string; message?: string };
  assert.equal(error?.code, "harness_timeout");
  assert.match(String(error?.message), /exceeded/);
});

test("a probe timeout does not claim the harness is missing", async (t) => {
  // `harness_missing` tells the operator to edit the Dockerfile and redeploy.
  // For a timeout that advice is wrong and costs a rebuild before anyone
  // questions it, so the timeout must surface under its own name.
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const sandbox = {
    exec: () => new Promise<never>(() => undefined),
  } as unknown as Parameters<typeof runHarnessInSandbox>[0]["sandbox"];

  const run = runHarnessInSandbox({
    credential: { credential: "token-under-test" },
    instructions: "instructions",
    model: "auto",
    runtime: "copilot",
    sandbox,
    task: "task",
  });
  const outcome = run.then(
    () => null,
    (rejection: unknown) => rejection
  );

  t.mock.timers.tick(PROBE_ATTEMPT_TIMEOUT_MS + 1);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(PROBE_ATTEMPT_TIMEOUT_MS + 1);

  const error = (await outcome) as { code?: string };
  assert.notEqual(error?.code, "harness_missing");
  assert.equal(error?.code, "harness_timeout");
});

test("cancelling a never-resolving probe clears its deadline before cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimeoutSpy = t.mock.method(globalThis, "clearTimeout");
  const controller = new AbortController();
  let resolveProbe!: () => void;
  const never = new Promise<never>((resolve) => {
    resolveProbe = () => resolve(undefined as never);
  });
  let resolveDestroy!: () => void;
  const sandbox = {
    exec: () => never,
  } as unknown as Parameters<typeof runHarnessInSandbox>[0]["sandbox"];

  const run = runHarnessInSandbox({
    credential: { credential: "token-under-test" },
    destroySandbox: () =>
      new Promise<void>((resolve) => {
        resolveDestroy = resolve;
      }),
    instructions: "instructions",
    model: "auto",
    runtime: "copilot",
    sandbox,
    signal: controller.signal,
    task: "task",
  });
  const outcome = run.then(
    () => null,
    (rejection: unknown) => rejection
  );

  controller.abort();
  assert.equal(
    clearTimeoutSpy.mock.callCount(),
    1,
    "cancellation must clear the probe deadline synchronously"
  );
  resolveDestroy();

  const error = (await outcome) as { code?: string };
  assert.equal(error?.code, "harness_cancelled");
  resolveProbe();
  await Promise.resolve();
});

test("a sandbox that cannot be reaped names the cleanup failure", async () => {
  // The run is over either way, but `harness_cancelled` would imply the
  // container went with it. It did not, and the operator needs to know the
  // difference before the idle reaper is the only thing left holding it.
  const controller = new AbortController();
  const sandbox = {
    exec: () => new Promise<never>(() => undefined),
  } as unknown as Parameters<typeof runHarnessInSandbox>[0]["sandbox"];

  const run = runHarnessInSandbox({
    credential: { credential: "token-under-test" },
    destroySandbox: () => Promise.reject(new Error("container already gone")),
    instructions: "instructions",
    model: "auto",
    runtime: "copilot",
    sandbox,
    signal: controller.signal,
    task: "task",
  });
  const outcome = run.then(
    () => null,
    (rejection: unknown) => rejection
  );

  controller.abort();

  const error = (await outcome) as { code?: string; message?: string };
  assert.equal(error?.code, "sandbox_cleanup_failed");
  assert.match(String(error?.message), /container already gone/);
});

test("a cancelled probe is not retried on a fresh container", async () => {
  // Only a deadline earns the second attempt. Retrying a cancellation would
  // provision a new sandbox for a run that no longer has a caller — the exact
  // container churn the admission limits exist to prevent.
  const controller = new AbortController();
  let execCalls = 0;
  let resets = 0;
  const sandbox = {
    exec: () => {
      execCalls += 1;
      return new Promise<never>(() => undefined);
    },
  } as unknown as Parameters<typeof runHarnessInSandbox>[0]["sandbox"];

  const run = runHarnessInSandbox({
    credential: { credential: "token-under-test" },
    destroySandbox: () => Promise.resolve(),
    instructions: "instructions",
    model: "auto",
    resetSandbox: () => {
      resets += 1;
      return Promise.resolve();
    },
    runtime: "copilot",
    sandbox,
    signal: controller.signal,
    task: "task",
  });
  const outcome = run.then(
    () => null,
    (rejection: unknown) => rejection
  );

  controller.abort();

  const error = (await outcome) as { code?: string };
  assert.equal(error?.code, "harness_cancelled");
  assert.equal(execCalls, 1, "the probe must not be attempted twice");
  assert.equal(resets, 0, "cancellation must not reset the sandbox");
});

test("a warm-up reports ready when the probe answers first try", async () => {
  const calls: Call[] = [];
  const sandbox = fakeSandbox(
    { "copilot --version": { stdout: "GitHub Copilot CLI 1.0.80\n" } },
    calls
  );

  const outcome = await warmSandbox(sandbox as never, "copilot");

  assert.deepEqual(outcome, {
    ready: true,
    version: "GitHub Copilot CLI 1.0.80",
  });
  assert.equal(calls.length, 1);
});

test("a warm-up retries once after a pause, then answers honestly", async () => {
  const waits: number[] = [];
  let attempts = 0;
  const sandbox = {
    exec() {
      attempts += 1;
      return Promise.resolve({
        command: "copilot --version",
        duration: 0,
        exitCode: attempts === 1 ? 1 : 0,
        stderr: "",
        stdout: attempts === 1 ? "" : "GitHub Copilot CLI 1.0.80\n",
        success: attempts !== 1,
        timestamp: FAKE_TIMESTAMP,
      });
    },
  };

  const outcome = await warmSandbox(sandbox as never, "copilot", (ms) => {
    waits.push(ms);
    return Promise.resolve();
  });

  assert.equal(outcome.ready, true);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [30_000]);
});

test("a warm-up that never succeeds settles as failed, not thrown", async () => {
  const calls: Call[] = [];
  const sandbox = fakeSandbox({ "copilot --version": { exitCode: 1 } }, calls);

  const outcome = await warmSandbox(sandbox as never, "copilot", () =>
    Promise.resolve()
  );

  assert.deepEqual(outcome, { ready: false, version: null });
  assert.equal(calls.length, 2);
});

test("a warm-up for an unknown runtime touches no sandbox", async () => {
  const calls: Call[] = [];
  const sandbox = fakeSandbox({}, calls);

  const outcome = await warmSandbox(sandbox as never, "not-a-harness");

  assert.deepEqual(outcome, { ready: false, version: null });
  assert.equal(calls.length, 0);
});

test("a warm-up swallows the probe timeout a run would propagate", async () => {
  // `probeInstalled` deliberately rethrows deadline errors so a run's
  // failure names the real condition. A warm-up has no user waiting on it,
  // so the same timeout degrades to `failed` instead of escaping into the
  // fiber.
  let attempts = 0;
  const sandbox = {
    exec() {
      attempts += 1;
      return Promise.reject(
        new HarnessError("probe timed out", "harness_timeout")
      );
    },
  };

  const outcome = await warmSandbox(sandbox as never, "copilot", () =>
    Promise.resolve()
  );

  assert.deepEqual(outcome, { ready: false, version: null });
  assert.equal(attempts, 2);
});

/**
 * The mission path: a background process polled for logs. The fakes model
 * the sandbox's process API — cumulative stdout per poll, a status that
 * moves, and a kill that must be observed — because the run's whole failure
 * history lives in the gap between "the CLI answered" and "the process
 * exited".
 */

const MISSION_MESSAGE = JSON.stringify({
  data: { content: "Recon complete", model: "gpt-5" },
  type: "assistant.message",
});
const MISSION_RESULT = JSON.stringify({
  exitCode: 0,
  sessionId: "s1",
  type: "result",
  usage: {},
});

type PollScript = ({ stdout: string; stderr?: string } | "fail")[];

function missionSandbox(config: {
  polls: PollScript;
  statuses?: string[];
  exitCode?: number;
}) {
  const record = {
    execs: [] as string[],
    killed: [] as string[],
    startCommand: "",
    startEnv: null as Record<string, string> | null,
  };
  let poll = -1;
  let statusIndex = -1;
  const sandbox = {
    exec(command: string) {
      record.execs.push(command);
      return Promise.resolve({
        command,
        exitCode: 0,
        stderr: "",
        stdout: command.startsWith("copilot")
          ? "GitHub Copilot CLI 1.0.80\n"
          : "",
        success: true,
      });
    },
    getProcess() {
      statusIndex += 1;
      const status =
        config.statuses?.[
          Math.min(statusIndex, (config.statuses?.length ?? 1) - 1)
        ] ?? "running";
      return Promise.resolve({
        command: record.startCommand,
        exitCode: config.exitCode,
        id: "p1",
        status,
      });
    },
    getProcessLogs() {
      poll += 1;
      const step = config.polls[Math.min(poll, config.polls.length - 1)];
      if (step === "fail" || step === undefined) {
        return Promise.reject(new Error("Network connection lost."));
      }
      return Promise.resolve({
        processId: "p1",
        stderr: step.stderr ?? "",
        stdout: step.stdout,
      });
    },
    killProcess(id: string) {
      record.killed.push(id);
      return Promise.resolve();
    },
    startProcess(command: string, options?: { env?: Record<string, string> }) {
      record.startCommand = command;
      record.startEnv = options?.env ?? null;
      return Promise.resolve({ command, id: "p1", status: "running" });
    },
  };
  return { record, sandbox };
}

function runMission(
  sandbox: unknown,
  extra: Record<string, unknown> = {}
): ReturnType<typeof runHarnessInSandbox> {
  return runHarnessInSandbox({
    credential: { credential: "harness-token" },
    instructions: "Be careful.",
    model: "auto",
    runtime: "copilot",
    sandbox: sandbox as never,
    sleep: () => Promise.resolve(),
    task: "Survey the workspace.",
    ...extra,
  });
}

test("a mission runs as a process and passes only its own credential", async () => {
  const { record, sandbox } = missionSandbox({
    exitCode: 0,
    polls: [{ stdout: `${MISSION_MESSAGE}\n${MISSION_RESULT}\n` }],
  });

  const run = await runMission(sandbox);

  assert.ok(record.startCommand.startsWith("'copilot'"));
  assert.equal(record.startEnv?.COPILOT_GITHUB_TOKEN, "harness-token");
  assert.equal(record.startEnv?.OPENAI_API_KEY, "");
  assert.equal(record.startEnv?.ANTHROPIC_API_KEY, "");
  assert.equal(run.summary.status, "completed");
  assert.equal(run.summary.output, "Recon complete");
  assert.equal(run.exitCode, 0);
});

test("a workspace carrying shell metacharacters is quoted, not executed", async () => {
  // `resolveSandboxWorkspace` accepts this path — it points inside
  // /workspace, which is all that check promises. Unquoted, the `;` ends the
  // mkdir and the rest runs as its own command in the tenant's container.
  const { record, sandbox } = missionSandbox({
    exitCode: 0,
    polls: [{ stdout: `${MISSION_MESSAGE}\n${MISSION_RESULT}\n` }],
  });

  await runMission(sandbox, { workspace: "repo; touch /tmp/pwned" });

  const mkdir = record.execs.find((command) => command.startsWith("mkdir"));
  assert.ok(mkdir, "the mission must create its workspace");
  assert.equal(mkdir, "mkdir -p '/workspace/repo; touch /tmp/pwned'");
  assert.ok(
    !/mkdir -p \/workspace\/repo; touch/.test(mkdir),
    "the payload must not survive as a second command"
  );
});

test("a line split across two polls still parses", async () => {
  const half = Math.floor(MISSION_MESSAGE.length / 2);
  const { sandbox } = missionSandbox({
    polls: [
      { stdout: MISSION_MESSAGE.slice(0, half) },
      { stdout: `${MISSION_MESSAGE}\n${MISSION_RESULT}\n` },
    ],
  });
  const seen: string[] = [];

  const run = await runMission(sandbox, {
    onEvent: (event: { kind: string }) => seen.push(event.kind),
  });

  assert.deepEqual(seen, ["message", "usage", "finished"]);
  assert.equal(run.summary.output, "Recon complete");
});

test("the harness's finished verdict outranks a process that never exits", async () => {
  const { record, sandbox } = missionSandbox({
    polls: [{ stdout: `${MISSION_MESSAGE}\n${MISSION_RESULT}\n` }],
    statuses: ["running"],
  });

  const run = await runMission(sandbox);

  assert.equal(run.summary.status, "completed");
  // The lingering process is signalled so it cannot hold the container.
  assert.deepEqual(record.killed, ["p1"]);
});

test("a transient poll failure is tolerated, not fatal", async () => {
  const { sandbox } = missionSandbox({
    polls: [
      { stdout: `${MISSION_MESSAGE}\n` },
      "fail",
      "fail",
      { stdout: `${MISSION_MESSAGE}\n${MISSION_RESULT}\n` },
    ],
  });

  const run = await runMission(sandbox);

  assert.equal(run.summary.status, "completed");
});

test("losing the container names the condition and the retained transcript", async () => {
  const { sandbox } = missionSandbox({
    polls: [
      { stdout: `${MISSION_MESSAGE}\n` },
      "fail",
      "fail",
      "fail",
      "fail",
      "fail",
    ],
  });

  await assert.rejects(
    runMission(sandbox),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === "harness_stream_lost" &&
      error.message.includes("recorded events") &&
      error.message.includes("failed polls")
  );
});

test("a process that exits without a result closes on its exit code", async () => {
  const { sandbox } = missionSandbox({
    exitCode: 1,
    polls: [{ stderr: "copilot: no credential", stdout: "" }],
    statuses: ["failed"],
  });

  const run = await runMission(sandbox);

  assert.equal(run.exitCode, 1);
  assert.equal(run.stderr, "copilot: no credential");
});

test("the mission deadline signals the process and names the timeout", async () => {
  let ticks = 0;
  const { record, sandbox } = missionSandbox({
    polls: [{ stdout: "" }],
    statuses: ["running"],
  });

  await assert.rejects(
    runMission(sandbox, {
      // The first read is the start clock; every later read has blown the
      // budget, so the loop must kill and throw on its next turn.
      clock: () => {
        ticks += 1;
        return ticks === 1 ? 0 : RUN_TIMEOUT_MS + 1000;
      },
    }),
    (error: unknown) =>
      error instanceof HarnessError && error.code === "harness_timeout"
  );
  assert.deepEqual(record.killed, ["p1"]);
});
