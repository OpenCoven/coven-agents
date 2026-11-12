import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaTimeoutError, type Sandbox, SandboxState } from "@daytona/sdk";
import {
  configuredDaytonaRunnerExecutor,
  DAYTONA_EXECUTOR_ADAPTER_VERSION,
  daytonaExecutionProvenance,
  daytonaRunnerExecutor,
} from "./daytona/executor";
import type { DaytonaProcessSandbox } from "./daytona/process";
import { DaytonaProcessError } from "./daytona/process";
import {
  DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
  DaytonaSandboxLifecycleError,
} from "./daytona/sandbox";
import {
  HOSTED_EXECUTION_CAPABILITY_CONTRACT_VERSION,
  type RunnerExecutionProvenance,
} from "./execution-provenance";
import type {
  RestrictedWorkspaceInspection,
  RunnerExecutionContext,
  RunnerExecutor,
  RunnerExecutorStartInput,
} from "./executor";
import type {
  RunnerAgentRecord,
  RunnerDaytonaAttemptId,
  RunnerDispatchAuthority,
} from "./types";

const authority = {
  expectedVersion: 3,
  leaseToken: "dispatch-lease",
  runId: "00000000-0000-4000-8000-000000000002",
} as RunnerDispatchAuthority;
const dispatchAuthority = {
  ...authority,
  attemptId: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730" as RunnerDaytonaAttemptId,
  expectedVersion: 5,
} as RunnerDispatchAuthority;
const fakeExecutionProvenance: RunnerExecutionProvenance = {
  adapterVersion: "fake-adapter-v1",
  capabilityContractVersion: "hosted-v1",
  lifecycle: "persistent",
  pinnedSnapshot: "fake-snapshot-v1",
  productExecutionClass: "hosted",
  provider: "fake",
  target: "test",
};
const daytonaProvenance: RunnerExecutionProvenance = {
  adapterVersion: "daytona-adapter-v1",
  capabilityContractVersion: "hosted-v1",
  lifecycle: "persistent",
  pinnedSnapshot: "coven-agents-copilot-1",
  productExecutionClass: "hosted",
  provider: "daytona",
  target: "us",
};

function agent(): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaSandboxId: "sandbox",
    description: "",
    familiarId: "auto",
    id: "00000000-0000-4000-8000-000000000001",
    instructions: "safe instructions",
    lastRunAt: null,
    model: "auto",
    name: "test",
    runtime: "copilot",
    sandboxGeneration: 1,
    sandboxLifecycle: "ready",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
    status: "idle",
    tenant: "tenant_a",
    updatedAt: new Date("2026-08-28T15:00:00.000Z"),
    version: 1,
    warmAttemptVersion: 0,
    warmStatus: "ready",
    warmUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
    workspace: null,
  };
}

type ExecutorExercise = Readonly<{
  calls: {
    credential?: string | null;
    ensured?: RunnerDispatchAuthority;
    inspected?: string;
    started?: boolean;
  };
  cleanupPendingError: Error;
  executor: RunnerExecutor;
  setInspection: (inspection: RestrictedWorkspaceInspection) => void;
}>;

function startInput(context: RunnerExecutionContext): RunnerExecutorStartInput {
  return {
    authorizers: {
      authorizeLaunch: async () => dispatchAuthority,
      authorizePreparation: async () =>
        dispatchAuthority.attemptId as RunnerDaytonaAttemptId,
      authorizeUnrestrictedExecution: async () => true,
      currentAuthority: () => dispatchAuthority,
      releasePreparation: async () => dispatchAuthority,
    },
    context,
    credential: { credential: "credential-at-start-boundary" },
    deleteAttemptRedaction: async () => true,
    executionPermission: "workspace_read",
    instructions: "instructions",
    model: "model",
    persistAttemptRedaction: async () => true,
    runId: authority.runId,
    runtime: "copilot",
    task: "task",
    workspace: "/workspace/repository",
  };
}

class DeterministicFakeExecutor implements RunnerExecutor {
  readonly calls: ExecutorExercise["calls"] = {};
  readonly cleanupPendingError = new Error("cleanup remains pending");
  readonly context = {} as RunnerExecutionContext;
  readonly executionProvenance = fakeExecutionProvenance;
  inspection: RestrictedWorkspaceInspection = { kind: "safe" };

  ensureExecutionContext(forwarded: RunnerDispatchAuthority) {
    this.calls.ensured = forwarded;
    return Promise.resolve({ agent: agent(), context: this.context });
  }

  inspectWorkspaceSafety(_context: RunnerExecutionContext, workspace: string) {
    this.calls.inspected = workspace;
    return Promise.resolve(this.inspection);
  }

  isCleanupPending(error: unknown): boolean {
    return error === this.cleanupPendingError;
  }

  start(input: RunnerExecutorStartInput) {
    this.calls.credential = input.credential.credential;
    this.calls.started = true;
    return Promise.resolve({ dispatchAuthority });
  }
}

function fakeExecutorExercise(): ExecutorExercise {
  const executor = new DeterministicFakeExecutor();
  return {
    calls: executor.calls,
    cleanupPendingError: executor.cleanupPendingError,
    executor,
    setInspection: (inspection) => {
      executor.inspection = inspection;
    },
  };
}

function processSandbox(): DaytonaProcessSandbox {
  return {
    process: {
      createSession: () => Promise.resolve(),
      deleteSession: () => Promise.resolve(),
      executeCommand: () => Promise.resolve({ exitCode: 0 }),
      executeSessionCommand: () => Promise.reject(new Error("not invoked")),
      getSessionCommand: () => Promise.reject(new Error("not invoked")),
      getSessionCommandLogs: () => Promise.reject(new Error("not invoked")),
      listSessions: () => Promise.resolve([]),
    },
  };
}

function daytonaExecutorExercise(): ExecutorExercise {
  let inspection: RestrictedWorkspaceInspection = { kind: "safe" };
  const calls: ExecutorExercise["calls"] = {};
  const sandbox = processSandbox();
  const cleanupPendingError = new DaytonaProcessError(
    "cleanup remains pending",
    "durable_release_failed",
    true
  );
  return {
    calls,
    cleanupPendingError,
    executor: daytonaRunnerExecutor({
      ensureContext: (forwarded) => {
        calls.ensured = forwarded;
        return Promise.resolve({ agent: agent(), sandbox });
      },
      executionProvenance: daytonaProvenance,
      inspectWorkspace: (forwarded, workspace) => {
        assert.equal(forwarded, sandbox);
        calls.inspected = workspace;
        return Promise.resolve(inspection);
      },
      startProcess: (input) => {
        assert.equal(input.sandbox, sandbox);
        calls.credential = input.credential.credential;
        calls.started = true;
        return Promise.resolve({
          attemptId: dispatchAuthority.attemptId as RunnerDaytonaAttemptId,
          commandId: "command",
          credentialPath: "/credential",
          dispatchAuthority,
          sessionId: "session",
          workspace: "/workspace/repository",
        });
      },
    }),
    setInspection: (next) => {
      inspection = next;
    },
  };
}

test("Daytona adapter derives immutable, sanitized hosted provenance", () => {
  const provenance = daytonaExecutionProvenance({
    autoArchiveInterval: 10_080,
    autoDeleteInterval: -1,
    autoStopInterval: 15,
    resources: { cpu: 2, disk: 20, memory: 4 },
    snapshotName: "coven-agents-copilot-42",
    target: "eu",
    ttlMinutes: 0,
  });

  assert.deepEqual(provenance, {
    adapterVersion: DAYTONA_EXECUTOR_ADAPTER_VERSION,
    capabilityContractVersion: HOSTED_EXECUTION_CAPABILITY_CONTRACT_VERSION,
    lifecycle: "persistent",
    pinnedSnapshot: "coven-agents-copilot-42",
    productExecutionClass: "hosted",
    provider: "daytona",
    target: "eu",
  });
  assert.equal(Object.isFrozen(provenance), true);
  assert.deepEqual(Object.keys(provenance).sort(), [
    "adapterVersion",
    "capabilityContractVersion",
    "lifecycle",
    "pinnedSnapshot",
    "productExecutionClass",
    "provider",
    "target",
  ]);
  assert.equal("apiKey" in provenance, false);
  assert.equal("apiUrl" in provenance, false);
  assert.equal("secret" in provenance, false);
});

function executorContract(
  name: string,
  createExercise: () => ExecutorExercise
): void {
  test(`${name} forwards dispatch authority while ensuring context`, async () => {
    const exercise = createExercise();

    const ensured = await exercise.executor.ensureExecutionContext(authority);

    assert.equal(exercise.calls.ensured, authority);
    assert.deepEqual(ensured.agent, agent());
  });

  test(`${name} preserves restricted workspace outcomes`, async () => {
    const exercise = createExercise();
    const { context } =
      await exercise.executor.ensureExecutionContext(authority);

    exercise.setInspection({ kind: "safe" });
    assert.deepEqual(
      await exercise.executor.inspectWorkspaceSafety(
        context,
        "/workspace/repository"
      ),
      { kind: "safe" }
    );
    exercise.setInspection({ kind: "unsafe" });
    assert.deepEqual(
      await exercise.executor.inspectWorkspaceSafety(
        context,
        "/workspace/repository"
      ),
      { kind: "unsafe" }
    );
    exercise.setInspection({ kind: "unavailable" });
    assert.deepEqual(
      await exercise.executor.inspectWorkspaceSafety(
        context,
        "/workspace/repository"
      ),
      { kind: "unavailable" }
    );
    assert.equal(exercise.calls.inspected, "/workspace/repository");
  });

  test(`${name} exposes credentials only at the start boundary`, async () => {
    const exercise = createExercise();
    const { context } =
      await exercise.executor.ensureExecutionContext(authority);
    await exercise.executor.inspectWorkspaceSafety(
      context,
      "/workspace/repository"
    );

    assert.equal(exercise.calls.credential, undefined);
    await exercise.executor.start(startInput(context));
    assert.equal(exercise.calls.credential, "credential-at-start-boundary");
  });

  test(`${name} returns the dispatch authority accepted by start`, async () => {
    const exercise = createExercise();
    const { context } =
      await exercise.executor.ensureExecutionContext(authority);

    assert.equal(
      (await exercise.executor.start(startInput(context))).dispatchAuthority,
      dispatchAuthority
    );
    assert.equal(exercise.calls.started, true);
  });

  test(`${name} classifies cleanup-pending errors without provider leakage`, () => {
    const exercise = createExercise();

    assert.equal(
      exercise.executor.isCleanupPending(exercise.cleanupPendingError),
      true
    );
    assert.equal(
      exercise.executor.isCleanupPending(new Error("failed")),
      false
    );
  });
}

executorContract("deterministic fake executor", fakeExecutorExercise);
executorContract("Daytona executor adapter", daytonaExecutorExercise);

test("Daytona retains non-retryable reuse cleanup instead of compensating its exact attempt", () => {
  assert.equal(
    daytonaExecutorExercise().executor.isCleanupPending(
      new DaytonaProcessError(
        "Approved reset required.",
        "sandbox_reuse_required",
        false
      )
    ),
    true
  );
});

test("configured dispatch checks snapshot policy and legacy containment before credential staging", async () => {
  await Promise.all(
    [
      { accepted: false, boundary: true, cpu: undefined, timeout: false },
      { accepted: false, boundary: true, cpu: 2, timeout: true },
      { accepted: false, boundary: false, cpu: 2, timeout: false },
      { accepted: true, boundary: true, cpu: 2, timeout: false },
    ].map(async (scenario) => {
      const calls: string[] = [];
      let snapshotUnavailable = scenario.timeout;
      const executor = configuredDaytonaRunnerExecutor({
        operator: { kind: "runner-operator" },
        sandboxConfiguration: {
          autoArchiveInterval: 10_080,
          autoDeleteInterval: -1,
          autoStopInterval: 15,
          resources: { cpu: 2, disk: 10, memory: 4 },
          snapshotName: "coven-agents-copilot-2",
          target: "us",
          ttlMinutes: 0,
        },
        sandboxDependencies: {
          daytona: {
            create: () => {
              calls.push("forbidden-create");
              return Promise.reject(new Error("must not mutate"));
            },
            get: () => {
              calls.push("sandbox");
              return Promise.resolve({
                id: "sandbox",
                labels: scenario.boundary
                  ? {
                      credentialBoundaryVersion:
                        DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
                    }
                  : {},
                state: SandboxState.STARTED,
              } as Sandbox);
            },
            snapshot: {
              get: (name) => {
                calls.push("snapshot");
                if (snapshotUnavailable) {
                  return Promise.reject(new DaytonaTimeoutError("timeout"));
                }
                return Promise.resolve({
                  cpu: scenario.cpu,
                  disk: 10,
                  mem: 4,
                  name,
                  state: "active",
                });
              },
            },
          },
        },
        store: {
          getDispatchAgent: () => {
            calls.push("dispatch-fence");
            // The store always returns the locked run with its agent.
            return Promise.resolve({ agent: agent(), kind: "found", run: {} });
          },
        } as never,
      });
      if (scenario.accepted) {
        assert.equal(
          (await executor.ensureExecutionContext(authority)).agent.id,
          agent().id
        );
      } else {
        await assert.rejects(
          executor.ensureExecutionContext(authority),
          (error: unknown) => {
            assert.equal(executor.isCleanupPending(error), !scenario.boundary);
            return error instanceof DaytonaSandboxLifecycleError;
          }
        );
      }
      assert.equal(calls.includes("forbidden-create"), false);
      assert.deepEqual(
        calls,
        scenario.cpu === undefined || scenario.timeout
          ? ["snapshot"]
          : ["snapshot", "dispatch-fence", "sandbox"]
      );
      if (scenario.timeout) {
        snapshotUnavailable = false;
        assert.equal(
          (await executor.ensureExecutionContext(authority)).agent.id,
          agent().id
        );
        assert.deepEqual(calls, [
          "snapshot",
          "snapshot",
          "dispatch-fence",
          "sandbox",
        ]);
      }
    })
  );
});

test("Daytona adapter treats only proven ambiguous sandbox lifecycle errors as cleanup-pending", () => {
  const exercise = daytonaExecutorExercise();

  assert.equal(
    exercise.executor.isCleanupPending(
      new DaytonaSandboxLifecycleError("ambiguous creation", {
        kind: "cleanup_needed",
        retryable: true,
      })
    ),
    true
  );
  assert.equal(
    exercise.executor.isCleanupPending(
      new DaytonaSandboxLifecycleError("ordinary lifecycle state", {
        retryable: true,
      })
    ),
    false
  );
  assert.equal(
    exercise.executor.isCleanupPending(
      new DaytonaSandboxLifecycleError("in-progress creation", {
        kind: "lifecycle",
        retryable: true,
      })
    ),
    false
  );
});

test("Daytona adapter forwards GitHub broker callbacks only at the process start boundary", async () => {
  const sandbox = processSandbox();
  const githubTool = {
    issueCapability: async () => ({ rawCapability: "opaque-capability" }),
    revokeCapability: async () => true,
    url: "https://app.example/api/internal/github-tool",
  };
  let forwardedGitHubTool: unknown;
  const executor = daytonaRunnerExecutor({
    ensureContext: async () => ({ agent: agent(), sandbox }),
    executionProvenance: daytonaProvenance,
    inspectWorkspace: async () => ({ kind: "safe" }),
    startProcess: (input) => {
      forwardedGitHubTool = input.githubTool;
      return Promise.resolve({
        attemptId: dispatchAuthority.attemptId as RunnerDaytonaAttemptId,
        commandId: "command",
        credentialPath: "/credential",
        dispatchAuthority,
        sessionId: "session",
        workspace: "/workspace/repository",
      });
    },
  });
  const { context } = await executor.ensureExecutionContext(authority);

  await executor.start({
    ...startInput(context),
    githubTool,
  } as RunnerExecutorStartInput);

  assert.equal(forwardedGitHubTool, githubTool);
});
