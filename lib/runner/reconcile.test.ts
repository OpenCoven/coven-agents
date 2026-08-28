// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelRunnerRun,
  reconcileAndDispatch,
  reconcileDaytonaSandboxes,
} from "./reconcile";
import type {
  RunnerAgentRecord,
  RunnerDaytonaAttemptId,
  RunnerDispatchAuthority,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const operator: RunnerOperator = { kind: "runner-operator" };
const attemptId =
  "53af1a29-4e98-43d6-ac5b-3b9dcba5e730" as RunnerDaytonaAttemptId;

function run(overrides: Partial<RunnerRunRecord> = {}): RunnerRunRecord {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    cancellationRequestedAt: null,
    commandEvidence: [],
    completedAt: null,
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaAttemptId: attemptId,
    daytonaCommandId: null,
    daytonaLogCursor: 0,
    daytonaSessionId: null,
    dispatchLeaseExpiresAt: new Date("2026-08-28T14:59:00.000Z"),
    dispatchLeaseToken: "expired-lease",
    dispatchState: "dispatching",
    error: null,
    fileEvidence: [],
    id: "00000000-0000-4000-8000-000000000002",
    logCursor: 1,
    operationId: "00000000-0000-4000-8000-000000000003",
    output: "",
    queueSequence: 1,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    task: "safe task",
    tenant: "tenant_a",
    version: 1,
    ...overrides,
  };
}

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaSandboxId: null,
    description: "",
    id: "00000000-0000-4000-8000-000000000001",
    instructions: "safe instructions",
    lastRunAt: null,
    model: "auto",
    name: "agent",
    runtime: "copilot",
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning_ambiguous",
    sandboxUpdatedAt: new Date("2026-08-28T14:00:00.000Z"),
    status: "idle",
    tenant: "tenant_a",
    updatedAt: new Date("2026-08-28T14:00:00.000Z"),
    version: 1,
    warmStatus: "not_started",
    warmUpdatedAt: new Date("2026-08-28T14:00:00.000Z"),
    workspace: null,
    ...overrides,
  };
}

test("reconciliation claims exact expired preparation cleanup before requeue", async () => {
  const calls: string[] = [];
  const expired = run();
  const authority = {
    attemptId,
    expectedVersion: expired.version + 1,
    leaseToken: "cleanup-lease",
    runId: expired.id,
  } as RunnerDispatchAuthority;
  const result = await reconcileAndDispatch({
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    dispatch: async () => {
      calls.push("dispatch");
      return { kind: "idle" as const };
    },
    operator,
    provider: {
      resolveSandbox: async () => {
        calls.push("resolve");
        return null;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "stopped" as const };
      },
    },
    randomToken: () => "cleanup-lease",
    store: {
      claimExpiredDaytonaAttemptCleanup: async () => {
        calls.push("claim-cleanup");
        return {
          authority,
          kind: "claimed" as const,
          run: {
            ...expired,
            dispatchLeaseToken: authority.leaseToken,
            version: authority.expectedVersion,
          },
        };
      },
      requeueAfterDaytonaAttemptCleanup: async () => {
        calls.push("requeue");
        return { kind: "requeued" as const, value: expired };
      },
      requeueExpiredDispatch: async () => {
        calls.push("requeue-unowned");
        return { kind: "not_live" as const };
      },
      scanExpiredDispatchLeases: async () => {
        calls.push("scan");
        return [expired];
      },
    } as never,
  });

  assert.deepEqual(calls, [
    "scan",
    "claim-cleanup",
    "resolve",
    "requeue",
    "dispatch",
  ]);
  assert.deepEqual(result, {
    adopted: 0,
    deferred: 0,
    dispatched: 0,
    expiredScanned: 1,
    failures: 0,
    logEvents: 0,
    requeued: 1,
    sandboxRecovered: 0,
    terminalCleaned: 0,
    terminalized: 0,
  });
});

test("ambiguous sandbox provisioning attaches only the scanned generation", async () => {
  const calls: string[] = [];
  const pending = agent();
  const result = await reconcileDaytonaSandboxes({
    daytona: {
      create: async () => {
        throw new Error("must not create");
      },
      get: async () => {
        calls.push("get");
        return { id: "sandbox" } as never;
      },
    },
    operator,
    store: {
      attachDaytonaSandboxForRecovery: async () => {
        calls.push("attach");
        return {
          kind: "updated" as const,
          value: agent({
            daytonaSandboxId: "sandbox",
            sandboxLifecycle: "ready",
          }),
        };
      },
      scanDaytonaSandboxRecoveries: async () => {
        calls.push("scan");
        return [pending];
      },
    } as never,
  });

  assert.deepEqual(calls, ["scan", "get", "attach"]);
  assert.deepEqual(result, { deferred: 0, failures: 0, recovered: 1 });
});

test("decommissioning retry deletes provider state before fenced agent removal", async () => {
  const calls: string[] = [];
  const deleting = agent({
    daytonaSandboxId: "sandbox",
    sandboxLifecycle: "decommissioning",
  });
  const result = await reconcileDaytonaSandboxes({
    daytona: {
      create: async () => {
        throw new Error("must not create");
      },
      get: async () => {
        calls.push("get");
        return {
          delete: async () => {
            calls.push("delete");
          },
          id: "sandbox",
        } as never;
      },
    },
    operator,
    store: {
      deleteDecommissionedAgentForRecovery: async () => {
        calls.push("remove");
        return { kind: "deleted" as const };
      },
      scanDaytonaSandboxRecoveries: async () => {
        calls.push("scan");
        return [deleting];
      },
    } as never,
  });

  assert.deepEqual(calls, ["scan", "get", "delete", "remove"]);
  assert.deepEqual(result, { deferred: 0, failures: 0, recovered: 1 });
});

test("terminal cleanup retries only after claiming the exact expired attempt", async () => {
  const calls: string[] = [];
  const terminal = run({
    completedAt: new Date("2026-08-28T14:59:00.000Z"),
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "terminal",
    status: "failed",
  });
  const authority = {
    attemptId,
    expectedVersion: terminal.version + 1,
    leaseToken: "terminal-cleanup",
    runId: terminal.id,
  } as RunnerDispatchAuthority;
  const releasedAuthority = {
    ...authority,
    expectedVersion: authority.expectedVersion + 1,
  } as RunnerDispatchAuthority;
  const result = await reconcileAndDispatch({
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    dispatchLimit: 1,
    operator,
    provider: {
      resolveSandbox: async () => {
        calls.push("resolve");
        return null;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "stopped" as const };
      },
    },
    randomToken: () => "terminal-cleanup",
    store: {
      claimTerminalDaytonaAttemptCleanup: async () => {
        calls.push("claim");
        return {
          authority,
          kind: "claimed" as const,
          run: {
            ...terminal,
            dispatchLeaseToken: authority.leaseToken,
            version: authority.expectedVersion,
          },
        };
      },
      cleanupTerminalLease: async () => {
        calls.push("cleanup-lease");
        return { kind: "updated" as const, value: terminal };
      },
      releaseTerminalDaytonaAttempt: async () => {
        calls.push("release");
        return { authority: releasedAuthority, kind: "released" as const };
      },
      scanExpiredDispatchLeases: async () => {
        calls.push("scan-expired");
        return [];
      },
      scanTerminalDaytonaAttemptCleanups: async () => {
        calls.push("scan-terminal");
        return [terminal];
      },
    } as never,
  });

  assert.deepEqual(calls, [
    "scan-expired",
    "scan-terminal",
    "claim",
    "resolve",
    "release",
    "cleanup-lease",
  ]);
  assert.equal(result.terminalCleaned, 1);
  assert.equal(result.failures, 0);
});

test("a provider outage for one expired run does not abort unrelated recovery", async () => {
  const first = run();
  const second = run({
    id: "00000000-0000-4000-8000-000000000004",
    operationId: "00000000-0000-4000-8000-000000000005",
  });
  let claimed = 0;
  const result = await reconcileAndDispatch({
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    operator,
    provider: {
      resolveSandbox: async (runnerRun) => {
        if (runnerRun.id === first.id) {
          throw new Error("provider unavailable");
        }
        return null;
      },
      stop: async () => ({ kind: "stopped" as const }),
    },
    providerConcurrency: 1,
    randomToken: () => "cleanup-lease",
    store: {
      claimExpiredDaytonaAttemptCleanup: async (
        _operator: RunnerOperator,
        input: { runId: string }
      ) => {
        claimed += 1;
        const candidate = input.runId === first.id ? first : second;
        return {
          authority: {
            attemptId,
            expectedVersion: candidate.version + 1,
            leaseToken: "cleanup-lease",
            runId: candidate.id,
          } as RunnerDispatchAuthority,
          kind: "claimed" as const,
          run: candidate,
        };
      },
      requeueAfterDaytonaAttemptCleanup: async () => ({
        kind: "requeued" as const,
        value: second,
      }),
      requeueExpiredDispatch: async () => ({ kind: "not_live" as const }),
      scanExpiredDispatchLeases: async () => [first, second],
    } as never,
  });

  assert.equal(claimed, 2);
  assert.equal(result.failures, 1);
  assert.equal(result.requeued, 1);
  assert.equal(result.expiredScanned, 2);
});

test("expired cancellation intent terminalizes instead of requeueing", async () => {
  const calls: string[] = [];
  const cancelling = run({
    cancellationRequestedAt: new Date("2026-08-28T14:58:00.000Z"),
    daytonaAttemptId: null,
  });
  const authority = {
    expectedVersion: cancelling.version + 1,
    leaseToken: "cancel-lease",
    runId: cancelling.id,
  } as RunnerDispatchAuthority;
  const finalAuthority = {
    ...authority,
    expectedVersion: authority.expectedVersion + 1,
  } as RunnerDispatchAuthority;
  const result = await reconcileAndDispatch({
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    operator,
    provider: {
      resolveSandbox: async () => {
        throw new Error("must not resolve");
      },
      stop: async () => {
        throw new Error("must not stop");
      },
    },
    randomToken: () => "cancel-lease",
    releaseCredentialResources: async () => {
      calls.push("release-credential");
    },
    store: {
      cleanupTerminalLease: async () => {
        calls.push("cleanup-lease");
        return { kind: "updated" as const, value: cancelling };
      },
      finalizeRun: async () => {
        calls.push("finalize");
        return {
          kind: "finalized" as const,
          prunedRunIds: [],
          run: {
            ...cancelling,
            completedAt: new Date("2026-08-28T15:00:00.000Z"),
            dispatchState: "terminal",
            status: "cancelled",
            version: finalAuthority.expectedVersion,
          },
        };
      },
      requestRunCancellation: async () => {
        calls.push("takeover");
        return {
          authority,
          kind: "requested" as const,
          run: {
            ...cancelling,
            dispatchLeaseToken: authority.leaseToken,
            version: authority.expectedVersion,
          },
        };
      },
      scanExpiredDispatchLeases: async () => {
        calls.push("scan");
        return [cancelling];
      },
    } as never,
  });

  assert.deepEqual(calls, [
    "scan",
    "takeover",
    "release-credential",
    "finalize",
    "cleanup-lease",
  ]);
  assert.equal(result.terminalized, 1);
  assert.equal(result.requeued, 0);
});

test("a terminal command with an unsettled log tail remains retryable", async () => {
  const calls: string[] = [];
  const attached = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    startedAt: new Date("2026-08-28T14:58:00.000Z"),
    status: "running",
  });
  const authority = {
    attemptId,
    expectedVersion: attached.version + 1,
    leaseToken: "adopted-lease",
    runId: attached.id,
  } as RunnerDispatchAuthority;
  const result = await reconcileAndDispatch({
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    operator,
    provider: {
      resolveSandbox: async () => {
        calls.push("resolve");
        return {} as never;
      },
      snapshot: async () => {
        calls.push("snapshot");
        return {
          cursor: 0,
          events: [],
          exitCode: 0,
          logsSettled: false,
          status: "completed",
          summary: {
            fileOperations: [],
            output: "",
            premiumRequests: null,
            sessionId: null,
            status: "completed",
            toolCalls: [],
          },
        };
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "stopped" as const };
      },
    },
    randomToken: () => "adopted-lease",
    store: {
      adoptExpiredDaytonaProcess: async () => {
        calls.push("adopt");
        return {
          authority,
          kind: "adopted" as const,
          run: {
            ...attached,
            dispatchLeaseToken: authority.leaseToken,
            version: authority.expectedVersion,
          },
        };
      },
      requeueExpiredDispatch: async () => ({ kind: "not_live" as const }),
      scanExpiredDispatchLeases: async () => {
        calls.push("scan");
        return [attached];
      },
    } as never,
  });

  assert.deepEqual(calls, ["scan", "adopt", "resolve", "snapshot"]);
  assert.equal(result.deferred, 1);
  assert.equal(result.terminalized, 0);
});

test("cancellation records durable intent before exact remote stop", async () => {
  const calls: string[] = [];
  const active = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    startedAt: new Date("2026-08-28T14:58:00.000Z"),
    status: "running",
  });
  const cancellationAuthority = {
    attemptId,
    expectedVersion: active.version + 1,
    leaseToken: "cancel-lease",
    runId: active.id,
  } as RunnerDispatchAuthority;
  const terminalAuthority = {
    ...cancellationAuthority,
    expectedVersion: cancellationAuthority.expectedVersion + 1,
  } as RunnerDispatchAuthority;

  const result = await cancelRunnerRun(active.id, {
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    operator,
    provider: {
      resolveSandbox: async () => {
        calls.push("resolve");
        return {} as never;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "stopped" as const };
      },
    },
    randomToken: () => "cancel-lease",
    releaseCredentialResources: async () => {
      calls.push("release-credential");
    },
    store: {
      cleanupTerminalLease: async () => {
        calls.push("cleanup-lease");
        return { kind: "updated" as const, value: active };
      },
      finalizeRun: async () => {
        calls.push("finalize");
        return {
          kind: "finalized" as const,
          prunedRunIds: [],
          run: {
            ...active,
            completedAt: new Date("2026-08-28T15:00:01.000Z"),
            dispatchState: "terminal",
            status: "cancelled",
            version: terminalAuthority.expectedVersion,
          },
        };
      },
      releaseTerminalDaytonaAttempt: async () => {
        calls.push("release");
        return { authority: terminalAuthority, kind: "released" as const };
      },
      requestRunCancellation: async () => {
        calls.push("intent");
        return {
          authority: cancellationAuthority,
          kind: "requested" as const,
          run: {
            ...active,
            cancellationRequestedAt: new Date("2026-08-28T15:00:00.000Z"),
            dispatchLeaseToken: cancellationAuthority.leaseToken,
            version: cancellationAuthority.expectedVersion,
          },
        };
      },
    } as never,
  });

  assert.deepEqual(calls, [
    "intent",
    "resolve",
    "stop",
    "release-credential",
    "finalize",
    "release",
    "cleanup-lease",
  ]);
  assert.deepEqual(result, { kind: "cancelled", runId: active.id });
});

test("cancellation keeps durable intent and records a safe diagnostic when reset is required", async () => {
  const calls: string[] = [];
  const active = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    startedAt: new Date("2026-08-28T14:58:00.000Z"),
    status: "running",
  });
  const authority = {
    attemptId,
    expectedVersion: active.version + 1,
    leaseToken: "cancel-lease",
    runId: active.id,
  } as RunnerDispatchAuthority;

  const result = await cancelRunnerRun(active.id, {
    operator,
    provider: {
      resetSandbox: async () => {
        calls.push("reset");
        return false;
      },
      resolveSandbox: async () => {
        calls.push("resolve");
        return {} as never;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "sandbox_reset_required" as const };
      },
    },
    randomToken: () => "cancel-lease",
    store: {
      appendCancellationDiagnostic: async () => {
        calls.push("diagnostic");
        return {
          authority,
          event: {} as never,
          kind: "appended" as const,
        };
      },
      requestRunCancellation: async () => {
        calls.push("intent");
        return {
          authority,
          kind: "requested" as const,
          run: {
            ...active,
            cancellationRequestedAt: new Date("2026-08-28T15:00:00.000Z"),
            dispatchLeaseToken: authority.leaseToken,
            version: authority.expectedVersion,
          },
        };
      },
    } as never,
  });

  assert.deepEqual(calls, ["intent", "resolve", "stop", "reset", "diagnostic"]);
  assert.deepEqual(result, {
    kind: "sandbox_reset_required",
    runId: active.id,
  });
});

test("cancellation fails closed for an unfenced provider identifier", async () => {
  const active = run({
    daytonaAttemptId: null,
    daytonaSessionId: "unfenced-session",
  });
  const authority = {
    expectedVersion: active.version + 1,
    leaseToken: "cancel-lease",
    runId: active.id,
  } as RunnerDispatchAuthority;
  const result = await cancelRunnerRun(active.id, {
    operator,
    provider: {
      resolveSandbox: async () => {
        throw new Error("must not resolve");
      },
      stop: async () => {
        throw new Error("must not stop");
      },
    },
    randomToken: () => "cancel-lease",
    store: {
      requestRunCancellation: async () => ({
        authority,
        kind: "requested" as const,
        run: {
          ...active,
          cancellationRequestedAt: new Date("2026-08-28T15:00:00.000Z"),
          dispatchLeaseToken: authority.leaseToken,
          version: authority.expectedVersion,
        },
      }),
    } as never,
  });

  assert.deepEqual(result, { kind: "cleanup_required", runId: active.id });
});

test("reconciliation appends only fresh logs and terminalizes a settled command", async () => {
  const calls: string[] = [];
  const attached = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    startedAt: new Date("2026-08-28T14:58:00.000Z"),
    status: "running",
  });
  const authority = {
    attemptId,
    expectedVersion: 2,
    leaseToken: "adopted-lease",
    runId: attached.id,
  } as RunnerDispatchAuthority;
  const afterEvent = {
    ...authority,
    expectedVersion: authority.expectedVersion + 1,
  } as RunnerDispatchAuthority;
  const afterTerminal = {
    ...afterEvent,
    expectedVersion: afterEvent.expectedVersion + 1,
  } as RunnerDispatchAuthority;
  const result = await reconcileAndDispatch({
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    dispatchLimit: 1,
    operator,
    provider: {
      resolveSandbox: async () => {
        calls.push("resolve");
        return {} as never;
      },
      snapshot: async () => {
        calls.push("snapshot");
        return {
          cursor: 42,
          events: [
            {
              at: "2026-08-28T15:00:00.000Z",
              kind: "message",
              model: null,
              text: "safe output",
            },
          ],
          exitCode: 0,
          logsSettled: true,
          status: "completed",
          summary: {
            fileOperations: [],
            output: "safe output",
            premiumRequests: null,
            sessionId: null,
            status: "completed",
            toolCalls: [],
          },
        };
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "stopped" as const };
      },
    },
    randomToken: () => "adopted-lease",
    store: {
      adoptExpiredDaytonaProcess: async () => {
        calls.push("adopt");
        return {
          authority,
          kind: "adopted" as const,
          run: {
            ...attached,
            dispatchLeaseToken: authority.leaseToken,
            version: authority.expectedVersion,
          },
        };
      },
      appendDispatchEvent: async () => {
        calls.push("append");
        return {
          authority: afterEvent,
          event: {} as never,
          kind: "appended" as const,
          run: {} as never,
        };
      },
      cleanupTerminalLease: async () => {
        calls.push("cleanup-lease");
        return { kind: "updated" as const, value: attached };
      },
      finalizeRun: async () => {
        calls.push("finalize");
        return {
          kind: "finalized" as const,
          prunedRunIds: [],
          run: {
            ...attached,
            completedAt: new Date("2026-08-28T15:00:00.000Z"),
            dispatchState: "terminal",
            status: "completed",
            version: afterTerminal.expectedVersion,
          },
        };
      },
      releaseTerminalDaytonaAttempt: async () => {
        calls.push("release-attempt");
        return {
          authority: afterTerminal,
          kind: "released" as const,
        };
      },
      requeueExpiredDispatch: async () => ({ kind: "not_live" as const }),
      scanExpiredDispatchLeases: async () => {
        calls.push("scan");
        return [attached];
      },
    } as never,
  });

  assert.deepEqual(calls, [
    "scan",
    "adopt",
    "resolve",
    "snapshot",
    "append",
    "finalize",
    "stop",
    "release-attempt",
    "cleanup-lease",
  ]);
  assert.deepEqual(result, {
    adopted: 1,
    deferred: 0,
    dispatched: 0,
    expiredScanned: 1,
    failures: 0,
    logEvents: 1,
    requeued: 0,
    sandboxRecovered: 0,
    terminalCleaned: 0,
    terminalized: 1,
  });
});
