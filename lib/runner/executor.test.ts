import assert from "node:assert/strict";
import test from "node:test";
import {
  DAYTONA_EXECUTOR_ADAPTER_VERSION,
  daytonaExecutionProvenance,
  daytonaRunnerExecutor,
} from "./daytona/executor";
import type { DaytonaProcessSandbox } from "./daytona/process";
import { DaytonaProcessError } from "./daytona/process";
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
    autoStopInterval: 15,
    snapshotName: "coven-agents-copilot-42",
    target: "eu",
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
