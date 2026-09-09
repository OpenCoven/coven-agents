import assert from "node:assert/strict";
import test from "node:test";
import { daytonaRunSessionName } from "../daytona/names";
import type {
  RunnerExecutionContext,
  RunnerExecutorStartInput,
} from "../executor";
import { runnerDispatchAuthorizers } from "../executor";
import type {
  AuthorizeDaytonaPreparationInput,
  RunnerAgentRecord,
  RunnerDaytonaAttemptId,
  RunnerDispatchAuthority,
} from "../types";
import {
  HERMETIC_EXECUTION_PROVENANCE,
  hermeticAttemptId,
  hermeticCommandId,
  hermeticRunnerExecutor,
  hermeticSandboxId,
} from "./executor";

const runId = "00000000-0000-4000-8000-000000000002";
const attemptId =
  "53af1a29-4e98-43d6-ac5b-3b9dcba5e730" as RunnerDaytonaAttemptId;
const authority = {
  attemptId,
  expectedVersion: 2,
  leaseToken: "hermetic-lease",
  runId,
} as RunnerDispatchAuthority;

function agent(): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    daytonaSandboxId: hermeticSandboxId(
      "tenant_a",
      "00000000-0000-4000-8000-000000000001"
    ),
    description: "",
    familiarId: "auto",
    id: "00000000-0000-4000-8000-000000000001",
    instructions: "instructions",
    lastRunAt: null,
    model: "auto",
    name: "Hermetic agent",
    runtime: "copilot",
    sandboxGeneration: 1,
    sandboxLifecycle: "ready",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    status: "idle",
    tenant: "tenant_a",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    version: 1,
    warmAttemptVersion: 0,
    warmStatus: "ready",
    warmUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    workspace: null,
  };
}

test("hermetic executor fences a deterministic launch without retaining its credential", async () => {
  const calls: string[] = [];
  const executor = hermeticRunnerExecutor({
    operator: { kind: "runner-operator" },
    store: {
      getDispatchAgent: async () => ({
        agent: agent(),
        kind: "found",
        run: {},
      }),
    } as never,
  });
  const { context } = await executor.ensureExecutionContext(authority);
  const start: RunnerExecutorStartInput = {
    authorizers: {
      authorizeLaunch: (launch) => {
        calls.push(`launch:${launch.sessionId}:${launch.commandId}`);
        return Promise.resolve(authority);
      },
      authorizePreparation: async () => attemptId,
      authorizeUnrestrictedExecution: () => {
        calls.push("unrestricted");
        return Promise.resolve(true);
      },
      currentAuthority: () => authority,
      releasePreparation: async () => authority,
    },
    context,
    credential: { credential: "deterministic-dummy-credential" },
    deleteAttemptRedaction: () => {
      calls.push("delete-redaction");
      return Promise.resolve(true);
    },
    executionPermission: "unrestricted",
    instructions: "instructions",
    model: "auto",
    persistAttemptRedaction: () => {
      calls.push("persist-redaction");
      return Promise.resolve(true);
    },
    runId,
    runtime: "copilot",
    task: "complete certification",
  };

  const started = await executor.start(start);

  assert.equal(started.dispatchAuthority, authority);
  assert.deepEqual(calls, [
    "unrestricted",
    `launch:${daytonaRunSessionName(runId, attemptId)}:${hermeticCommandId(runId, attemptId)}`,
  ]);
  assert.equal(
    calls.some((call) => call.includes("credential")),
    false
  );
  assert.deepEqual(executor.executionProvenance, HERMETIC_EXECUTION_PROVENANCE);
  assert.equal(executor.executionProvenance.provider, "hermetic");
  assert.equal(executor.attemptIdForRun?.(runId), hermeticAttemptId(runId));
  assert.equal(
    (
      context as unknown as {
        attemptId: RunnerDaytonaAttemptId;
        runId: string;
      }
    ).attemptId,
    attemptId
  );
});

test("hermetic executor has a safe workspace boundary and no cleanup-shaped fallback", async () => {
  const executor = hermeticRunnerExecutor({
    operator: { kind: "runner-operator" },
    store: {
      getDispatchAgent: async () => ({
        agent: agent(),
        kind: "found",
        run: {},
      }),
    } as never,
  });
  const { context } = await executor.ensureExecutionContext(authority);
  assert.deepEqual(
    await executor.inspectWorkspaceSafety(
      context as RunnerExecutionContext,
      "/workspace"
    ),
    { kind: "safe" }
  );
  assert.equal(executor.isCleanupPending(new Error("provider failed")), false);
});

test("hermetic attempt identity reaches durable preparation without browser input", async () => {
  let persistedAttempt: RunnerDaytonaAttemptId | undefined;
  const callbacks = runnerDispatchAuthorizers(
    {
      authorizeDaytonaPreparation: (
        _operator: unknown,
        _authority: RunnerDispatchAuthority,
        input: AuthorizeDaytonaPreparationInput
      ) => {
        persistedAttempt = input.attemptId;
        return Promise.resolve({
          attemptId: input.attemptId as RunnerDaytonaAttemptId,
          authority: {
            ...authority,
            attemptId: input.attemptId,
            expectedVersion: authority.expectedVersion + 1,
          } as RunnerDispatchAuthority,
          kind: "authorized" as const,
        });
      },
    } as never,
    { kind: "runner-operator" },
    authority,
    HERMETIC_EXECUTION_PROVENANCE,
    hermeticAttemptId(runId)
  );

  assert.equal(
    await callbacks.authorizePreparation({ runId }),
    hermeticAttemptId(runId)
  );
  assert.equal(persistedAttempt, hermeticAttemptId(runId));
});
