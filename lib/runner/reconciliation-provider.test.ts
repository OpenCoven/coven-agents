import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaNotFoundError } from "@daytona/sdk";
import type {
  RunnerAttemptLogSnapshot,
  RunnerAttemptSnapshotInput,
  RunnerExecutionContextResetResult,
  RunnerReconciliationContext,
  RunnerReconciliationProvider,
  RunnerStopAttemptResult,
} from "./attempt-reconcile";
import { daytonaReconciliationProvider } from "./daytona/reconcile";
import { DaytonaSandboxLifecycleError } from "./daytona/sandbox";
import type {
  RunnerDispatchAuthority,
  RunnerExecutionAttemptId,
  RunnerRunRecord,
} from "./types";

const attemptId =
  "53af1a29-4e98-43d6-ac5b-3b9dcba5e730" as RunnerExecutionAttemptId;
const authority = {
  attemptId,
  expectedVersion: 2,
  leaseToken: "lease",
  runId: "00000000-0000-4000-8000-000000000002",
} as RunnerDispatchAuthority;
const run = {
  agentId: "00000000-0000-4000-8000-000000000001",
  tenant: "tenant_a",
} as RunnerRunRecord;

const daytonaLog = `${JSON.stringify({
  data: { content: "terminal output", model: "auto" },
  timestamp: "2026-08-28T15:00:00.000Z",
  type: "assistant.message",
})}\n`;
const snapshot: RunnerAttemptLogSnapshot = {
  cursor: daytonaLog.length,
  events: [],
  exitCode: 0,
  logsSettled: true,
  status: "completed",
  summary: {
    fileOperations: [],
    output: "terminal output",
    premiumRequests: null,
    sessionId: null,
    status: "completed",
    toolCalls: [],
  },
};

type ProviderExercise = Readonly<{
  provider: RunnerReconciliationProvider;
  setReset: (result: RunnerExecutionContextResetResult) => void;
  setResolve: (result: "absent" | "error" | "present") => void;
  setStop: (result: RunnerStopAttemptResult) => void;
  snapshotInput: () => RunnerAttemptSnapshotInput | undefined;
}>;

class DeterministicFakeRecoveryProvider
  implements RunnerReconciliationProvider
{
  readonly context = {} as RunnerReconciliationContext;
  private reset: RunnerExecutionContextResetResult = { kind: "reset" };
  private resolve: "absent" | "error" | "present" = "present";
  private stopResult: RunnerStopAttemptResult = { kind: "stopped" };
  lastSnapshot: RunnerAttemptSnapshotInput | undefined;

  resolveExecutionContext() {
    if (this.resolve === "error") {
      return Promise.reject(new Error("ambiguous provider failure"));
    }
    return Promise.resolve(this.resolve === "absent" ? null : this.context);
  }

  snapshot(input: RunnerAttemptSnapshotInput) {
    this.lastSnapshot = input;
    return Promise.resolve(snapshot);
  }

  stop() {
    return Promise.resolve(this.stopResult);
  }

  resetExecutionContext() {
    return Promise.resolve(this.reset);
  }

  setReset(result: RunnerExecutionContextResetResult): void {
    this.reset = result;
  }

  setResolve(result: "absent" | "error" | "present"): void {
    this.resolve = result;
  }

  setStop(result: RunnerStopAttemptResult): void {
    this.stopResult = result;
  }
}

function deterministicFakeRecoveryProvider(): ProviderExercise {
  const provider = new DeterministicFakeRecoveryProvider();
  return {
    provider,
    setReset: (result) => {
      provider.setReset(result);
    },
    setResolve: (result) => {
      provider.setResolve(result);
    },
    setStop: (result) => {
      provider.setStop(result);
    },
    snapshotInput: () => provider.lastSnapshot,
  };
}

function daytonaRecoveryProvider(): ProviderExercise {
  let reset: RunnerExecutionContextResetResult = { kind: "reset" };
  let resolve: "absent" | "error" | "present" = "present";
  let stopResult: RunnerStopAttemptResult = { kind: "stopped" };
  let lastSnapshot: RunnerAttemptSnapshotInput | undefined;
  const sandbox = {
    process: {
      createSession: () => Promise.resolve(),
      deleteSession: () => {
        switch (stopResult.kind) {
          case "provider_not_found":
            return Promise.reject(new DaytonaNotFoundError("absent"));
          case "provider_unavailable":
            return Promise.reject(
              new DaytonaSandboxLifecycleError("unavailable", {
                retryable: true,
              })
            );
          case "sandbox_reset_required":
            return Promise.reject(new Error("ambiguous"));
          default:
            return Promise.resolve();
        }
      },
      executeCommand: () => Promise.resolve({ exitCode: 0 }),
      executeSessionCommand: () => Promise.resolve({ exitCode: 0 }),
      getSessionCommand: (_sessionId: string, commandId: string) => {
        lastSnapshot = {
          attemptId,
          commandId,
          context: {} as RunnerReconciliationContext,
          credential: null,
          cursor: 0,
          harness: "copilot",
          runId: authority.runId,
        };
        return Promise.resolve({ exitCode: 0 });
      },
      getSessionCommandLogs: () =>
        Promise.resolve({
          output: "",
          stderr: "",
          stdout: daytonaLog,
        }),
      listSessions: () => Promise.resolve([]),
    },
  };
  const provider = daytonaReconciliationProvider({
    daytona: {
      create: () => Promise.reject(new Error("not invoked")),
      get: () => {
        if (resolve === "absent") {
          return Promise.reject(new DaytonaNotFoundError("absent"));
        }
        if (resolve === "error") {
          return Promise.reject(new Error("ambiguous provider failure"));
        }
        return Promise.resolve(sandbox as never);
      },
    },
    resetExecutionContext: () => Promise.resolve(reset),
  });
  return {
    provider,
    setReset: (result) => {
      reset = result;
    },
    setResolve: (result) => {
      resolve = result;
    },
    setStop: (result) => {
      stopResult = result;
    },
    snapshotInput: () => lastSnapshot,
  };
}

function reconciliationProviderContract(
  name: string,
  createExercise: () => ProviderExercise
): void {
  test(`${name} confirms only explicit context absence`, async () => {
    const exercise = createExercise();

    exercise.setResolve("present");
    assert.ok(
      await exercise.provider.resolveExecutionContext(run, authority),
      "present provider context must remain available"
    );
    exercise.setResolve("absent");
    assert.equal(
      await exercise.provider.resolveExecutionContext(run, authority),
      null
    );
    exercise.setResolve("error");
    await assert.rejects(
      exercise.provider.resolveExecutionContext(run, authority)
    );
  });

  test(`${name} forwards snapshots without changing cursor, output, or terminal status`, async () => {
    const exercise = createExercise();
    const context = await exercise.provider.resolveExecutionContext(
      run,
      authority
    );
    assert.ok(context);
    const input = {
      attemptId,
      commandId: "command",
      context,
      credential: null,
      cursor: 0,
      harness: "copilot" as const,
      runId: authority.runId,
    };

    const forwarded = await exercise.provider.snapshot?.(input);

    assert.equal(forwarded?.cursor, snapshot.cursor);
    assert.equal(forwarded?.summary.output, "terminal output");
    assert.equal(forwarded?.status, "completed");
    assert.equal(exercise.snapshotInput()?.commandId, "command");
  });

  test(`${name} preserves stop and reset outcomes`, async () => {
    const outcomes = await Promise.all(
      (
        [
          "stopped",
          "provider_not_found",
          "provider_unavailable",
          "sandbox_reset_required",
        ] as const
      ).map(async (kind) => {
        const isolated = createExercise();
        const context = await isolated.provider.resolveExecutionContext(
          run,
          authority
        );
        assert.ok(context);
        isolated.setStop({ kind });
        return await isolated.provider.stop(context, {
          attemptId,
          runId: authority.runId,
        });
      })
    );
    assert.deepEqual(outcomes, [
      { kind: "stopped" },
      { kind: "provider_not_found" },
      { kind: "provider_unavailable" },
      { kind: "sandbox_reset_required" },
    ]);
    const resets: readonly RunnerExecutionContextResetResult[] = [
      { kind: "reset" },
      { kind: "provider_not_found" },
      { kind: "in_progress" },
      { kind: "not_found" },
      { kind: "sandbox_reset_required" },
      { kind: "stale_version" },
      { kind: "unavailable", source: "database" },
      { kind: "unavailable", source: "provider" },
    ];
    assert.deepEqual(
      await Promise.all(
        resets.map(async (result) => {
          const isolated = createExercise();
          isolated.setReset(result);
          return await isolated.provider.resetExecutionContext?.(
            run,
            authority
          );
        })
      ),
      resets
    );
  });
}

reconciliationProviderContract(
  "deterministic fake recovery provider",
  deterministicFakeRecoveryProvider
);
reconciliationProviderContract(
  "Daytona recovery provider",
  daytonaRecoveryProvider
);
