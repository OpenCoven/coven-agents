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
    authVersion: 1,
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
    rollbackCredentialResources: async () => {
      calls.push("rollback-credential");
    },
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
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
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
    "delete-redaction",
    "rollback-credential",
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
    terminalLeaseCleaned: 0,
  });
});

test("command-free recovery resets a fenced sandbox before requeueing", async () => {
  const calls: string[] = [];
  const expired = run();
  const authority = {
    attemptId,
    expectedVersion: expired.version + 1,
    leaseToken: "cleanup-lease",
    runId: expired.id,
  } as RunnerDispatchAuthority;
  const result = await reconcileAndDispatch({
    operator,
    provider: {
      resetSandbox: async (_run, resetAuthority) => {
        calls.push("reset");
        assert.equal(resetAuthority, authority);
        return { kind: "reset" as const };
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
    randomToken: () => "cleanup-lease",
    rollbackCredentialResources: async () => {
      calls.push("rollback-credential");
    },
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
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
      },
      requeueAfterDaytonaAttemptCleanup: async () => {
        calls.push("requeue");
        return { kind: "requeued" as const, value: expired };
      },
      requeueExpiredDispatch: async () => ({ kind: "not_live" as const }),
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
    "stop",
    "reset",
    "delete-redaction",
    "rollback-credential",
    "requeue",
  ]);
  assert.equal(result.deferred, 0);
  assert.equal(result.requeued, 1);
});

test("retryable provider stop failure defers without resetting the sandbox", async () => {
  const calls: string[] = [];
  const expired = run();
  const authority = {
    attemptId,
    expectedVersion: expired.version + 1,
    leaseToken: "cleanup-lease",
    runId: expired.id,
  } as RunnerDispatchAuthority;
  const result = await reconcileAndDispatch({
    operator,
    provider: {
      resetSandbox: async () => {
        calls.push("reset");
        return { kind: "reset" as const };
      },
      resolveSandbox: async () => {
        calls.push("resolve");
        return {} as never;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "provider_unavailable" as const };
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
      requeueExpiredDispatch: async () => ({ kind: "not_live" as const }),
      scanExpiredDispatchLeases: async () => {
        calls.push("scan");
        return [expired];
      },
    } as never,
  });

  assert.deepEqual(calls, ["scan", "claim-cleanup", "resolve", "stop"]);
  assert.equal(result.deferred, 1);
  assert.equal(result.requeued, 0);
});

test("an absent attached sandbox resets accounting before fresh redispatch", async () => {
  const calls: string[] = [];
  let accountingReset = false;
  let daytonaCursorReset = false;
  const attached = run({
    daytonaCommandId: "command",
    daytonaLogCursor: 42,
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
    dispatch: async () => {
      assert.equal(accountingReset, true);
      assert.equal(daytonaCursorReset, true);
      calls.push("redispatch");
      return { kind: "started" as const };
    },
    operator,
    provider: {
      resolveSandbox: async () => {
        calls.push("resolve");
        return null;
      },
      stop: async () => {
        throw new Error("must not stop an absent sandbox");
      },
    },
    randomToken: () => "adopted-lease",
    rollbackCredentialResources: async () => {
      calls.push("rollback-credential");
      accountingReset = true;
    },
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
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
      },
      requeueAfterDaytonaAttemptCleanup: async () => {
        calls.push("requeue");
        const requeued = {
          kind: "requeued" as const,
          value: {
            ...attached,
            daytonaAttemptId: null,
            daytonaLogCursor: 0,
            daytonaSessionId: null,
          },
        };
        daytonaCursorReset = requeued.value.daytonaLogCursor === 0;
        return requeued;
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
    "delete-redaction",
    "rollback-credential",
    "requeue",
    "redispatch",
  ]);
  assert.equal(result.adopted, 1);
  assert.equal(result.dispatched, 1);
  assert.equal(result.requeued, 1);
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
      resetSandbox: async () => {
        calls.push("reset");
        return { kind: "reset" as const };
      },
      resolveSandbox: async () => {
        calls.push("resolve");
        return null;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "sandbox_reset_required" as const };
      },
    },
    randomToken: () => "terminal-cleanup",
    releaseCredentialResources: async () => {
      calls.push("release-credential");
    },
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
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
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
    "delete-redaction",
    "release-credential",
    "release",
    "cleanup-lease",
  ]);
  assert.equal(result.terminalCleaned, 1);
  assert.equal(result.failures, 0);
});

test("terminal cleanup resets a fenced sandbox before releasing its exact attempt", async () => {
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
    operator,
    provider: {
      resetSandbox: async () => {
        calls.push("reset");
        return { kind: "reset" as const };
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
    randomToken: () => "terminal-cleanup",
    releaseCredentialResources: async () => {
      calls.push("release-credential");
    },
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
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
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
    "stop",
    "reset",
    "delete-redaction",
    "release-credential",
    "release",
    "cleanup-lease",
  ]);
  assert.equal(result.terminalCleaned, 1);
});

test("terminal reset failure records one safe diagnostic and defers later recovery", async () => {
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
  const result = await reconcileAndDispatch({
    operator,
    provider: {
      resetSandbox: async () => {
        calls.push("reset");
        return { kind: "sandbox_reset_required" as const };
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
    randomToken: () => "terminal-cleanup",
    store: {
      appendTerminalCleanupDiagnostic: async () => {
        calls.push("diagnostic");
        return {
          authority,
          event: {} as never,
          kind: "appended" as const,
        };
      },
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
    "stop",
    "reset",
    "diagnostic",
  ]);
  assert.equal(result.terminalCleaned, 0);
  assert.equal(result.deferred, 1);
});

test("reconciliation cleans only exact expired terminal residual leases without provider work", async () => {
  const calls: string[] = [];
  const valid = run({
    completedAt: new Date("2026-08-28T14:59:00.000Z"),
    daytonaAttemptId: null,
    dispatchState: "terminal",
    status: "cancelled",
    version: 8,
  });
  const unresolved = run({
    ...valid,
    daytonaAttemptId: attemptId,
    id: "00000000-0000-4000-8000-000000000004",
  });
  const providerOwned = run({
    ...valid,
    daytonaCommandId: "command",
    id: "00000000-0000-4000-8000-000000000005",
  });
  const live = run({
    ...valid,
    dispatchState: "running",
    id: "00000000-0000-4000-8000-000000000006",
    status: "running",
  });
  const stale = run({
    ...valid,
    dispatchLeaseToken: "stale-lease",
    id: "00000000-0000-4000-8000-000000000007",
  });
  const result = await reconcileAndDispatch({
    operator,
    provider: {
      resolveSandbox: async () => {
        throw new Error("must not resolve");
      },
      stop: async () => {
        throw new Error("must not stop");
      },
    },
    releaseCredentialResources: async () => {
      throw new Error("must not release credentials");
    },
    rollbackCredentialResources: async () => {
      throw new Error("must not roll back credentials");
    },
    store: {
      cleanupTerminalLease: async (
        _operator: RunnerOperator,
        authority: RunnerDispatchAuthority
      ) => {
        calls.push(
          `cleanup:${authority.runId}:${authority.leaseToken}:${authority.expectedVersion}`
        );
        return authority.runId === valid.id
          ? { kind: "updated" as const, value: valid }
          : { kind: "stale_version" as const };
      },
      scanExpiredDispatchLeases: async () => [],
      scanTerminalLeaseCleanups: async () => {
        calls.push("scan");
        return [valid, unresolved, providerOwned, live, stale];
      },
    } as never,
  });

  assert.deepEqual(calls, [
    "scan",
    `cleanup:${valid.id}:${valid.dispatchLeaseToken}:${valid.version}`,
    `cleanup:${stale.id}:${stale.dispatchLeaseToken}:${stale.version}`,
  ]);
  assert.equal(result.terminalLeaseCleaned, 1);
  assert.equal(result.deferred, 1);
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
    rollbackCredentialResources: async () => undefined,
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
      deleteAttemptRedaction: async () => ({ kind: "deleted" as const }),
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
    rollbackCredentialResources: async () => {
      calls.push("rollback-credential");
    },
    store: {
      cleanupTerminalLease: async () => {
        calls.push("cleanup-lease");
        return { kind: "updated" as const, value: cancelling };
      },
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
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
    "rollback-credential",
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
    openAttemptRedaction: async () => {
      calls.push("open-redaction");
      return "redaction-secret";
    },
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
    releaseCredentialResources: async () => {
      calls.push("release-credential");
    },
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
      appendDispatchEventBatch: async () => {
        calls.push("append-batch");
        return {
          authority,
          events: [],
          kind: "appended" as const,
          run: {} as never,
        };
      },
      readAttemptRedaction: async () => {
        calls.push("read-redaction");
        return {
          kind: "found" as const,
          value: {
            aadVersion: 1,
            attemptId,
            ciphertext: "ciphertext",
            createdAt: new Date(),
            iv: "iv",
            kekVersion: "v1",
            runId: attached.id,
            wrappedKey: "wrapped",
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

  assert.deepEqual(calls, [
    "scan",
    "adopt",
    "resolve",
    "read-redaction",
    "open-redaction",
    "snapshot",
    "append-batch",
  ]);
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
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
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
    "delete-redaction",
    "release-credential",
    "finalize",
    "release",
    "cleanup-lease",
  ]);
  assert.deepEqual(result, { kind: "cancelled", runId: active.id });
});

test("cancelling a queued run compensates before finalizing without provider work", async () => {
  const calls: string[] = [];
  const unstarted = run({
    daytonaAttemptId: null,
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
  });
  const authority = {
    expectedVersion: unstarted.version + 1,
    leaseToken: "cancel-lease",
    runId: unstarted.id,
  } as RunnerDispatchAuthority;
  const finalized = {
    ...unstarted,
    completedAt: new Date("2026-08-28T15:00:00.000Z"),
    dispatchLeaseToken: authority.leaseToken,
    dispatchState: "terminal" as const,
    status: "cancelled" as const,
    version: authority.expectedVersion + 1,
  };
  const result = await cancelRunnerRun(unstarted.id, {
    operator,
    provider: {
      resolveSandbox: async () => {
        throw new Error("must not resolve an unstarted dispatch");
      },
      stop: async () => {
        throw new Error("must not stop an unstarted dispatch");
      },
    },
    randomToken: () => "cancel-lease",
    rollbackCredentialResources: async () => {
      calls.push("rollback-credential");
    },
    store: {
      cleanupTerminalLease: async () => {
        calls.push("cleanup-lease");
        return { kind: "updated" as const, value: finalized };
      },
      finalizeRun: async () => {
        calls.push("finalize");
        return {
          kind: "finalized" as const,
          prunedRunIds: [],
          run: finalized,
        };
      },
      requestRunCancellation: async () => {
        calls.push("intent");
        return {
          authority,
          kind: "requested" as const,
          run: {
            ...unstarted,
            cancellationRequestedAt: new Date("2026-08-28T15:00:00.000Z"),
            dispatchLeaseExpiresAt: new Date("2026-08-28T15:01:00.000Z"),
            dispatchLeaseToken: authority.leaseToken,
            dispatchState: "dispatching",
            version: authority.expectedVersion,
          },
        };
      },
    } as never,
  });

  assert.deepEqual(calls, [
    "intent",
    "rollback-credential",
    "finalize",
    "cleanup-lease",
  ]);
  assert.deepEqual(result, { kind: "cancelled", runId: unstarted.id });
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
        return { kind: "sandbox_reset_required" as const };
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

test("cancellation preserves database and provider unavailability", async () => {
  const databaseResult = await cancelRunnerRun(run().id, {
    operator,
    provider: {
      resolveSandbox: async () => null,
      stop: async () => ({ kind: "stopped" as const }),
    },
    store: {
      requestRunCancellation: async () => {
        throw new Error("database=private-detail");
      },
    } as never,
  });
  assert.deepEqual(databaseResult, {
    kind: "unavailable",
    runId: run().id,
    source: "database",
  });

  const active = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    status: "running",
  });
  const authority = {
    attemptId,
    expectedVersion: active.version + 1,
    leaseToken: "cancel-lease",
    runId: active.id,
  } as RunnerDispatchAuthority;
  const providerResult = await cancelRunnerRun(active.id, {
    operator,
    provider: {
      resolveSandbox: async () => {
        throw new Error("provider=private-detail");
      },
      stop: async () => ({ kind: "stopped" as const }),
    },
    store: {
      requestRunCancellation: async () => ({
        authority,
        kind: "requested" as const,
        run: {
          ...active,
          cancellationRequestedAt: new Date(),
          dispatchLeaseToken: authority.leaseToken,
          version: authority.expectedVersion,
        },
      }),
    } as never,
  });
  assert.deepEqual(providerResult, {
    kind: "unavailable",
    runId: active.id,
    source: "provider",
  });
  assert.doesNotMatch(JSON.stringify(providerResult), /private-detail/u);
});

test("confirmed provider command absence continues exact cancellation cleanup", async () => {
  const calls: string[] = [];
  const active = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    status: "running",
  });
  const authority = {
    attemptId,
    expectedVersion: active.version + 1,
    leaseToken: "cancel-lease",
    runId: active.id,
  } as RunnerDispatchAuthority;
  const terminalAuthority = {
    ...authority,
    expectedVersion: authority.expectedVersion + 1,
  } as RunnerDispatchAuthority;
  const result = await cancelRunnerRun(active.id, {
    operator,
    provider: {
      resolveSandbox: async () => {
        calls.push("resolve");
        return {} as never;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "provider_not_found" as const };
      },
    },
    releaseCredentialResources: async () => {
      calls.push("release-credential");
    },
    store: {
      cleanupTerminalLease: async () => {
        calls.push("cleanup-lease");
        return { kind: "updated" as const, value: active };
      },
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
      },
      finalizeRun: async () => {
        calls.push("finalize");
        return {
          kind: "finalized" as const,
          prunedRunIds: [],
          run: {
            ...active,
            completedAt: new Date(),
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
          authority,
          kind: "requested" as const,
          run: {
            ...active,
            cancellationRequestedAt: new Date(),
            dispatchLeaseToken: authority.leaseToken,
            version: authority.expectedVersion,
          },
        };
      },
    } as never,
  });

  assert.deepEqual(result, { kind: "cancelled", runId: active.id });
  assert.deepEqual(calls, [
    "intent",
    "resolve",
    "stop",
    "delete-redaction",
    "release-credential",
    "finalize",
    "release",
    "cleanup-lease",
  ]);
});

test("a cancelled attempt without an attached command rolls back accounting", async () => {
  const calls: string[] = [];
  const active = run({
    daytonaCommandId: null,
    daytonaSessionId: null,
    dispatchState: "dispatching",
    status: "queued",
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
      resolveSandbox: async () => null,
      stop: async () => {
        throw new Error("must not stop an absent sandbox");
      },
    },
    releaseCredentialResources: async () => {
      calls.push("release-credential");
    },
    rollbackCredentialResources: async () => {
      calls.push("rollback-credential");
    },
    store: {
      deleteAttemptRedaction: async () => ({
        kind: "deleted" as const,
      }),
      finalizeRun: async () => ({ kind: "stale_version" as const }),
      requestRunCancellation: async () => ({
        authority,
        kind: "requested" as const,
        run: {
          ...active,
          cancellationRequestedAt: new Date(),
          dispatchLeaseToken: authority.leaseToken,
          version: authority.expectedVersion,
        },
      }),
    } as never,
  });

  assert.deepEqual(result, { kind: "stale_version", runId: active.id });
  assert.deepEqual(calls, ["rollback-credential"]);
});

test("cancellation cleanup failure keeps intent durable without terminalizing", async () => {
  const calls: string[] = [];
  const active = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
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
      resolveSandbox: async () => ({}) as never,
      stop: async () => ({ kind: "stopped" as const }),
    },
    releaseCredentialResources: async () => {
      calls.push("release-credential");
      throw new Error("database=private-detail");
    },
    store: {
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
      },
      finalizeRun: async () => {
        calls.push("finalize");
        throw new Error("must not terminalize");
      },
      requestRunCancellation: async () => {
        calls.push("intent");
        return {
          authority,
          kind: "requested" as const,
          run: {
            ...active,
            cancellationRequestedAt: new Date(),
            dispatchLeaseToken: authority.leaseToken,
            version: authority.expectedVersion,
          },
        };
      },
    } as never,
  });

  assert.deepEqual(result, {
    kind: "cleanup_required",
    runId: active.id,
  });
  assert.deepEqual(calls, ["intent", "delete-redaction", "release-credential"]);
  assert.doesNotMatch(JSON.stringify(result), /private-detail/u);
});

test("cancellation preserves a stale sandbox reset fence", async () => {
  const active = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
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
      resetSandbox: async () => ({ kind: "stale_version" as const }),
      resolveSandbox: async () => ({}) as never,
      stop: async () => ({ kind: "sandbox_reset_required" as const }),
    },
    store: {
      requestRunCancellation: async () => ({
        authority,
        kind: "requested" as const,
        run: {
          ...active,
          cancellationRequestedAt: new Date(),
          dispatchLeaseToken: authority.leaseToken,
          version: authority.expectedVersion,
        },
      }),
    } as never,
  });

  assert.deepEqual(result, { kind: "stale_version", runId: active.id });
});

test("cancellation preserves stale finalization fences without false success", async () => {
  const queued = run({
    daytonaAttemptId: null,
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
    dispatchState: "queued",
  });
  const authority = {
    expectedVersion: queued.version + 1,
    leaseToken: "cancel-lease",
    runId: queued.id,
  } as RunnerDispatchAuthority;
  const result = await cancelRunnerRun(queued.id, {
    operator,
    provider: {
      resolveSandbox: async () => null,
      stop: async () => ({ kind: "stopped" as const }),
    },
    rollbackCredentialResources: async () => undefined,
    store: {
      finalizeRun: async () => ({ kind: "stale_version" as const }),
      requestRunCancellation: async () => ({
        authority,
        kind: "requested" as const,
        run: {
          ...queued,
          cancellationRequestedAt: new Date(),
          dispatchLeaseExpiresAt: new Date(Date.now() + 60_000),
          dispatchLeaseToken: authority.leaseToken,
          dispatchState: "dispatching",
          version: authority.expectedVersion,
        },
      }),
    } as never,
  });

  assert.deepEqual(result, { kind: "stale_version", runId: queued.id });
});

test("dirty terminal cancellation is cleanup-required, not stopped", async () => {
  const terminal = run({
    cancellationRequestedAt: new Date(),
    completedAt: new Date(),
    dispatchState: "terminal",
    status: "cancelled",
  });
  const result = await cancelRunnerRun(terminal.id, {
    operator,
    provider: {
      resolveSandbox: async () => {
        throw new Error("must not resolve");
      },
      stop: async () => {
        throw new Error("must not stop");
      },
    },
    store: {
      requestRunCancellation: async () => ({
        kind: "already_terminal" as const,
        run: terminal,
      }),
    } as never,
  });

  assert.deepEqual(result, {
    kind: "cleanup_required",
    runId: terminal.id,
  });

  const clean = {
    ...terminal,
    daytonaAttemptId: null,
    daytonaCommandId: null,
    daytonaSessionId: null,
    dispatchLeaseExpiresAt: null,
    dispatchLeaseToken: null,
  };
  const idempotent = await cancelRunnerRun(clean.id, {
    operator,
    provider: {
      resolveSandbox: async () => {
        throw new Error("must not resolve");
      },
      stop: async () => {
        throw new Error("must not stop");
      },
    },
    store: {
      requestRunCancellation: async () => ({
        kind: "already_terminal" as const,
        run: clean,
      }),
    } as never,
  });
  assert.deepEqual(idempotent, {
    kind: "already_terminal",
    runId: clean.id,
  });
});

test("reconciliation appends only fresh logs and terminalizes a settled command", async () => {
  const calls: string[] = [];
  const credential = "attempt-redaction-secret";
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
    openAttemptRedaction: async (scope) => {
      calls.push("open-redaction");
      assert.equal(scope.attemptId, attemptId);
      return credential;
    },
    operator,
    provider: {
      resetSandbox: async () => {
        calls.push("reset");
        return { kind: "reset" as const };
      },
      resolveSandbox: async () => {
        calls.push("resolve");
        return {} as never;
      },
      snapshot: async (input) => {
        calls.push("snapshot");
        assert.equal(input.credential, credential);
        return {
          cursor: 42,
          events: [
            {
              at: "2026-08-28T15:00:00.000Z",
              kind: "message",
              model: null,
              text: `message ${credential}`,
            },
            {
              at: "2026-08-28T15:00:00.000Z",
              callId: credential,
              kind: "tool-start",
              summary: credential,
              tool: credential,
            },
            {
              at: "2026-08-28T15:00:00.000Z",
              callId: credential,
              kind: "tool-end",
              success: true,
              summary: credential,
            },
            {
              at: "2026-08-28T15:00:00.000Z",
              kind: "file",
              operation: "edit",
              path: `/workspace/${credential}`,
            },
          ],
          exitCode: 0,
          logsSettled: true,
          status: "completed",
          summary: {
            fileOperations: [{ operation: "modify", path: credential }],
            output: `output ${credential}`,
            premiumRequests: null,
            sessionId: null,
            status: "completed",
            toolCalls: [
              { success: true, summary: credential, tool: credential },
            ],
          },
        };
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "sandbox_reset_required" as const };
      },
    },
    randomToken: () => "adopted-lease",
    releaseCredentialResources: async () => {
      calls.push("release-credential");
    },
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
      appendDispatchEventBatch: async (
        _operator: unknown,
        _authority: unknown,
        batch: unknown
      ) => {
        calls.push("append-batch");
        assert.equal(
          (batch as { daytonaLogCursor: number }).daytonaLogCursor,
          42
        );
        assert.equal(
          JSON.stringify(batch).includes(credential),
          false,
          "provider events must be redacted before persistence"
        );
        return {
          authority: afterEvent,
          events: [],
          kind: "appended" as const,
          run: {} as never,
        };
      },
      cleanupTerminalLease: async () => {
        calls.push("cleanup-lease");
        return { kind: "updated" as const, value: attached };
      },
      deleteAttemptRedaction: async () => {
        calls.push("delete-redaction");
        return { kind: "deleted" as const };
      },
      finalizeRun: async (_operator: unknown, finalization: unknown) => {
        calls.push("finalize");
        assert.equal(
          JSON.stringify(finalization).includes(credential),
          false,
          "terminal evidence must be redacted before persistence"
        );
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
      readAttemptRedaction: async () => {
        calls.push("read-redaction");
        return {
          kind: "found" as const,
          value: {
            aadVersion: 1,
            attemptId,
            ciphertext: "ciphertext",
            createdAt: new Date(),
            iv: "iv",
            kekVersion: "v1",
            runId: attached.id,
            wrappedKey: "wrapped",
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
    "read-redaction",
    "open-redaction",
    "snapshot",
    "append-batch",
    "finalize",
    "stop",
    "reset",
    "release-credential",
    "delete-redaction",
    "release-attempt",
    "cleanup-lease",
  ]);
  assert.deepEqual(result, {
    adopted: 1,
    deferred: 0,
    dispatched: 0,
    expiredScanned: 1,
    failures: 0,
    logEvents: 3,
    requeued: 0,
    sandboxRecovered: 0,
    terminalCleaned: 0,
    terminalized: 1,
    terminalLeaseCleaned: 0,
  });
});
