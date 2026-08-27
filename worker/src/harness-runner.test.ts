import assert from "node:assert/strict";
import test from "node:test";
import {
  HarnessError,
  PROBE_TIMEOUT_MS,
  parseHarnessStream,
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
    credential: { credential: "harness-token" },
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

test("mkdir quotes a workspace path before handing it to the shell", async () => {
  const calls: Call[] = [];
  const sandbox = fakeSandbox(
    {
      "'copilot'": {
        stdout: `${JSON.stringify({
          exitCode: 0,
          type: "result",
        })}\n`,
      },
      "copilot --version": { stdout: "GitHub Copilot CLI 1.0.80\n" },
    },
    calls
  );

  await runHarnessInSandbox({
    credential: { credential: "harness-token" },
    instructions: "Be careful.",
    model: "auto",
    runtime: "copilot",
    sandbox: sandbox as never,
    task: "Create notes.md",
    workspace: "/workspace/x; touch /tmp/pwn",
  });

  const mkdir = calls.find((call) => call.command.startsWith("mkdir -p"));
  assert.ok(mkdir);
  assert.equal(mkdir.command, "mkdir -p '/workspace/x; touch /tmp/pwn'");
  assert.equal(mkdir.command.includes("mkdir -p /workspace/x;"), false);
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

  t.mock.timers.tick(PROBE_TIMEOUT_MS + 1);

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

  t.mock.timers.tick(PROBE_TIMEOUT_MS + 1);

  const error = (await outcome) as { code?: string };
  assert.notEqual(error?.code, "harness_missing");
  assert.equal(error?.code, "harness_timeout");
});

test("cancelling a never-resolving probe clears its deadline before cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimeout = t.mock.method(globalThis, "clearTimeout");
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
    clearTimeout.mock.callCount(),
    1,
    "cancellation must clear the probe deadline synchronously"
  );
  resolveDestroy();

  const error = (await outcome) as { code?: string };
  assert.equal(error?.code, "harness_cancelled");
  resolveProbe();
  await Promise.resolve();
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

test("a warm-up with no destroy capability fails closed after a probe timeout", async () => {
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
  assert.equal(attempts, 1);
});

test("a warm-up destroys a timed-out sandbox before retrying", async () => {
  let attempts = 0;
  let destroys = 0;
  const sandbox = {
    destroy() {
      destroys += 1;
      return Promise.resolve();
    },
    exec() {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(
          new HarnessError("probe timed out", "harness_timeout")
        );
      }
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "GitHub Copilot CLI 1.0.80\n",
        success: true,
      });
    },
  };

  const outcome = await warmSandbox(sandbox as never, "copilot", () =>
    Promise.resolve()
  );

  assert.deepEqual(outcome, {
    ready: true,
    version: "GitHub Copilot CLI 1.0.80",
  });
  assert.equal(attempts, 2);
  assert.equal(destroys, 1);
});

test("a warm-up does not retry when timed-out sandbox cleanup fails", async () => {
  let attempts = 0;
  let destroys = 0;
  const sandbox = {
    destroy() {
      destroys += 1;
      return Promise.reject(new Error("sandbox destroy failed"));
    },
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
  assert.equal(attempts, 1);
  assert.equal(destroys, 1);
});

test("a run streams events out while the CLI is still executing", async () => {
  // The message line is split across two chunks on purpose: the assembler
  // must hold the partial line, or a JSON object cut at a chunk boundary
  // is dropped and the live view silently loses events.
  const message = JSON.stringify({
    data: { content: "Working on it", model: "gpt-5" },
    type: "assistant.message",
  });
  const result = JSON.stringify({
    exitCode: 0,
    sessionId: "s1",
    type: "result",
    usage: {},
  });
  const seen: string[] = [];
  const sandbox = {
    exec(command: string, options?: Record<string, unknown>) {
      if (command.startsWith("copilot --version")) {
        return Promise.resolve({
          command,
          exitCode: 0,
          stderr: "",
          stdout: "GitHub Copilot CLI 1.0.80\n",
          success: true,
        });
      }
      if (command.startsWith("mkdir")) {
        return Promise.resolve({
          command,
          exitCode: 0,
          stderr: "",
          stdout: "",
          success: true,
        });
      }
      const onOutput = options?.onOutput as (
        source: string,
        data: string
      ) => void;
      const half = Math.floor(message.length / 2);
      onOutput("stdout", message.slice(0, half));
      onOutput("stderr", "noise that must not be parsed as events\n");
      onOutput("stdout", `${message.slice(half)}\n${result}\n`);
      // Deliberately empty stdout in the result: everything already
      // streamed, and the events must come from the stream, not a re-parse.
      return Promise.resolve({
        command,
        exitCode: 0,
        stderr: "",
        stdout: "",
        success: true,
      });
    },
  };

  const run = await runHarnessInSandbox({
    credential: { credential: "harness-token" },
    instructions: "Be careful.",
    model: "auto",
    onEvent: (event) => {
      seen.push(event.kind);
    },
    runtime: "copilot",
    sandbox: sandbox as never,
    task: "Create notes.md",
  });

  assert.deepEqual(seen, ["message", "usage", "finished"]);
  assert.equal(run.summary.status, "completed");
  assert.equal(run.summary.output, "Working on it");
});

test("a finished stream settles the run even if the process never exits", async () => {
  // Observed twice in production: copilot answered the mission, streamed its
  // terminal result, and then lingered until the 900s deadline stamped the
  // whole run failed — with the reaper destroying a container whose only
  // crime was a process that would not exit. The stream's own verdict must
  // outrank the exit that never comes.
  const message = JSON.stringify({
    data: { content: "Recon complete", model: "gpt-5" },
    type: "assistant.message",
  });
  const result = JSON.stringify({
    exitCode: 0,
    sessionId: "s1",
    type: "result",
    usage: {},
  });
  const sandbox = {
    exec(command: string, options?: Record<string, unknown>) {
      if (command.startsWith("copilot --version")) {
        return Promise.resolve({
          command,
          exitCode: 0,
          stderr: "",
          stdout: "GitHub Copilot CLI 1.0.80\n",
          success: true,
        });
      }
      if (command.startsWith("mkdir")) {
        return Promise.resolve({
          command,
          exitCode: 0,
          stderr: "",
          stdout: "",
          success: true,
        });
      }
      const onOutput = options?.onOutput as (
        source: string,
        data: string
      ) => void;
      onOutput("stdout", `${message}\n${result}\n`);
      // The process lingers forever after answering.
      return new Promise<never>(() => undefined);
    },
  };

  const run = await runHarnessInSandbox({
    credential: { credential: "harness-token" },
    finishGraceMs: 1,
    instructions: "Be careful.",
    model: "auto",
    runtime: "copilot",
    sandbox: sandbox as never,
    task: "Survey the workspace.",
  });

  assert.equal(run.exitCode, 0);
  assert.equal(run.summary.status, "completed");
  assert.equal(run.summary.output, "Recon complete");
});

test("a transport drop after the streamed result still completes the run", async () => {
  const message = JSON.stringify({
    data: { content: "Recon complete", model: "gpt-5" },
    type: "assistant.message",
  });
  const result = JSON.stringify({
    exitCode: 0,
    sessionId: "s1",
    type: "result",
    usage: {},
  });
  const sandbox = {
    exec(command: string, options?: Record<string, unknown>) {
      if (
        command.startsWith("copilot --version") ||
        command.startsWith("mkdir")
      ) {
        return Promise.resolve({
          command,
          exitCode: 0,
          stderr: "",
          stdout: command.includes("--version")
            ? "GitHub Copilot CLI 1.0.80\n"
            : "",
          success: true,
        });
      }
      const onOutput = options?.onOutput as (s: string, d: string) => void;
      onOutput("stdout", `${message}\n${result}\n`);
      return Promise.reject(new Error("Network connection lost."));
    },
  };

  const run = await runHarnessInSandbox({
    credential: { credential: "harness-token" },
    finishGraceMs: 1,
    instructions: "Be careful.",
    model: "auto",
    runtime: "copilot",
    sandbox: sandbox as never,
    task: "Survey the workspace.",
  });

  assert.equal(run.summary.status, "completed");
  assert.equal(run.summary.output, "Recon complete");
});

test("a transport drop before the result names the condition, not the transport", async () => {
  const message = JSON.stringify({
    data: { content: "Looking around…", model: "gpt-5" },
    type: "assistant.message",
  });
  const sandbox = {
    exec(command: string, options?: Record<string, unknown>) {
      if (
        command.startsWith("copilot --version") ||
        command.startsWith("mkdir")
      ) {
        return Promise.resolve({
          command,
          exitCode: 0,
          stderr: "",
          stdout: command.startsWith("copilot")
            ? "GitHub Copilot CLI 1.0.80\n"
            : "",
          success: true,
        });
      }
      const onOutput = options?.onOutput as (s: string, d: string) => void;
      onOutput("stdout", `${message}\n`);
      return Promise.reject(new Error("Network connection lost."));
    },
  };

  await assert.rejects(
    runHarnessInSandbox({
      credential: { credential: "harness-token" },
      finishGraceMs: 1,
      instructions: "Be careful.",
      model: "auto",
      runtime: "copilot",
      sandbox: sandbox as never,
      task: "Survey the workspace.",
    }),
    (error: unknown) =>
      error instanceof HarnessError &&
      error.code === "harness_stream_lost" &&
      error.message.includes("recorded events") &&
      !error.message.includes("Network connection lost")
  );
});

test("aborting a run destroys the sandbox and stops the command", async () => {
  const controller = new AbortController();
  let mainStarted!: () => void;
  let resolveExec!: () => void;
  let destroyed = 0;
  const sandbox = {
    destroy() {
      destroyed += 1;
      resolveExec();
      return Promise.resolve();
    },
    exec(command: string) {
      if (command.includes("--version") || command.startsWith("mkdir")) {
        return Promise.resolve({
          command,
          exitCode: 0,
          stderr: "",
          stdout: command.includes("--version")
            ? "GitHub Copilot CLI 1.0.80\n"
            : "",
          success: true,
        });
      }
      mainStarted();
      return new Promise((resolve) => {
        resolveExec = () =>
          resolve({
            command,
            exitCode: 143,
            stderr: "terminated",
            stdout: "",
            success: false,
          });
      });
    },
  };

  const run = runHarnessInSandbox({
    credential: { credential: "harness-token" },
    instructions: "Be careful.",
    model: "auto",
    runtime: "copilot",
    sandbox: sandbox as never,
    signal: controller.signal,
    task: "Stop this run",
  });
  await new Promise<void>((resolve) => {
    mainStarted = resolve;
  });
  controller.abort();
  setTimeout(resolveExec, 50);

  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof HarnessError && error.code === "harness_cancelled"
  );
  assert.equal(destroyed, 1);
});

test("cancellation does not settle until sandbox destruction completes", async () => {
  const controller = new AbortController();
  let mainStarted!: () => void;
  let resolveExec!: () => void;
  let resolveDestroy!: () => void;
  let destroyed = 0;
  const sandbox = {
    destroy() {
      destroyed += 1;
      return new Promise<void>((resolve) => {
        resolveDestroy = resolve;
      });
    },
    exec(command: string) {
      if (command.includes("--version") || command.startsWith("mkdir")) {
        return Promise.resolve({
          command,
          exitCode: 0,
          stderr: "",
          stdout: command.includes("--version")
            ? "GitHub Copilot CLI 1.0.80\n"
            : "",
          success: true,
        });
      }
      mainStarted();
      return new Promise((resolve) => {
        resolveExec = () =>
          resolve({
            command,
            exitCode: 143,
            stderr: "terminated",
            stdout: "",
            success: false,
          });
      });
    },
  };

  const run = runHarnessInSandbox({
    credential: { credential: "harness-token" },
    instructions: "Be careful.",
    model: "auto",
    runtime: "copilot",
    sandbox: sandbox as never,
    signal: controller.signal,
    task: "Stop this run",
  });
  await new Promise<void>((resolve) => {
    mainStarted = resolve;
  });
  controller.abort();
  const pending = await Promise.race([
    run.then(
      () => "settled",
      () => "settled"
    ),
    new Promise<"pending">((resolve) =>
      setTimeout(() => resolve("pending"), 0)
    ),
  ]);
  assert.equal(pending, "pending");

  resolveDestroy();
  resolveExec();
  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof HarnessError && error.code === "harness_cancelled"
  );
  assert.equal(destroyed, 1);
});

test("initial probe cancellation propagates durable cleanup failure", async () => {
  const controller = new AbortController();
  let probeStarted!: () => void;
  let destroyCalls = 0;
  let resolveProbe!: () => void;
  const probe = new Promise<void>((resolve) => {
    probeStarted = resolve;
  });
  const sandbox = {
    destroy() {
      throw new Error("sandbox destroy should be owned by the agent");
    },
    exec(command: string) {
      if (!command.includes("--version")) {
        throw new Error(`unexpected command: ${command}`);
      }
      probeStarted();
      return new Promise((resolve) => {
        resolveProbe = () =>
          resolve({
            command,
            exitCode: 143,
            stderr: "terminated",
            stdout: "",
            success: false,
          });
      });
    },
  };

  const run = runHarnessInSandbox({
    credential: { credential: "harness-token" },
    destroySandbox: () => {
      destroyCalls += 1;
      resolveProbe();
      throw new Error("durable cleanup failed");
    },
    instructions: "Be careful.",
    model: "auto",
    runtime: "copilot",
    sandbox: sandbox as never,
    signal: controller.signal,
    task: "Stop this run",
  });
  await probe;
  controller.abort();

  await assert.rejects(
    run,
    (error: unknown) =>
      error instanceof HarnessError && error.code === "sandbox_cleanup_failed"
  );
  assert.equal(destroyCalls, 1);
});
