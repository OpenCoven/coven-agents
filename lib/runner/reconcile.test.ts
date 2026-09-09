// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaNotFoundError } from "@daytona/sdk";
import { sanitizeEvidenceText } from "@opencoven/agent-contracts";
import {
  cancelRunnerRun,
  type ReconcileAndDispatchDependencies,
  reconcileAndDispatch,
} from "./attempt-reconcile";
import { daytonaProbeSessionName, daytonaSandboxLabels } from "./daytona/names";
import { reconcileDaytonaSandboxes } from "./daytona/resource-recovery";
import { RUNNER_MID_RUN_ENTITLEMENT_POLICY } from "./entitlement-policy";
import { encodeRunnerAttemptRedactionSecrets } from "./redaction-secrets";
import type {
  RunnerAgentRecord,
  RunnerDaytonaAttemptId,
  RunnerDispatchAuthority,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const operator: RunnerOperator = { kind: "runner-operator" };
const SANDBOX_CONFIGURATION = {
  autoArchiveInterval: 10_080,
  autoDeleteInterval: -1 as const,
  autoStopInterval: 15,
  configurationId: "current-configuration",
  resources: { cpu: 2, disk: 10, memory: 4 },
  snapshotName: "coven-agents-copilot-2",
  target: "us" as const,
  ttlMinutes: 0 as const,
};
const attemptId =
  "53af1a29-4e98-43d6-ac5b-3b9dcba5e730" as RunnerDaytonaAttemptId;

function run(overrides: Partial<RunnerRunRecord> = {}): RunnerRunRecord {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    agentInstructions: "safe instructions",
    agentModel: "auto",
    agentRuntime: "copilot",
    agentWorkspace: null,
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
    executionPermission: "unrestricted",
    executionProvenance: null,
    fileEvidence: [],
    githubBrokerPolicy: null,
    id: "00000000-0000-4000-8000-000000000002",
    logCursor: 1,
    operationId: "00000000-0000-4000-8000-000000000003",
    output: "",
    queueSequence: 1,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    task: "safe task",
    teamStepId: null,
    tenant: "tenant_a",
    version: 1,
    ...overrides,
  };
}

/**
 * A snapshot that can genuinely replace a workspace: active and at policy.
 * Recovery fails closed without one, so any test asserting that recovery
 * deletes must say what the replacement is.
 */
const usableSnapshot = () => ({
  get: (name: string) =>
    Promise.resolve({ cpu: 2, disk: 10, mem: 4, name, state: "active" }),
});

test("reconciliation projects and claims teams before dispatch and retries terminal cleanup last", async () => {
  const calls: string[] = [];
  const claimedRun = run({ executionPermission: "workspace_write" });
  const claimed = {
    authority: {
      expectedVersion: claimedRun.version,
      leaseToken: claimedRun.dispatchLeaseToken as string,
      runId: claimedRun.id,
    } as RunnerDispatchAuthority,
    run: claimedRun,
  };

  const result = await reconcileAndDispatch({
    claimTeamRuns: async () => {
      calls.push("claim-team");
      return { claimedDispatches: [claimed], deferred: 0, failures: 0 };
    },
    dispatch: async () => {
      calls.push("dispatch-queued");
      return { kind: "idle" as const };
    },
    dispatchClaim: async (value) => {
      calls.push("dispatch-team-claim");
      assert.equal(value, claimed);
      assert.equal(value.run.executionPermission, "workspace_write");
      return { kind: "started" as const, runId: value.run.id };
    },
    operator,
    projectTeamRuns: async () => {
      calls.push("project-team");
      return { cancellationDeferred: 0, failures: 0 };
    },
    provider: {
      resolveExecutionContext: async () => null,
      stop: async () => ({ kind: "stopped" as const }),
    },
    store: {
      scanExpiredDispatchLeases: async () => {
        calls.push("repair-runner-leases");
        return [];
      },
      scanTerminalDaytonaAttemptCleanups: async () => {
        calls.push("retry-terminal-attempt-cleanup");
        return [];
      },
      scanTerminalLeaseCleanups: async () => {
        calls.push("retry-terminal-lease-cleanup");
        return [];
      },
    } as never,
  });

  assert.deepEqual(calls, [
    "repair-runner-leases",
    "project-team",
    "claim-team",
    "dispatch-team-claim",
    "dispatch-queued",
    "retry-terminal-lease-cleanup",
    "retry-terminal-attempt-cleanup",
  ]);
  assert.equal(result.dispatched, 1);
  assert.equal(result.failures, 0);
});

test("one team projection failure does not abort claims or unrelated runner dispatch", async () => {
  const calls: string[] = [];

  const result = await reconcileAndDispatch({
    claimTeamRuns: async () => {
      calls.push("claim-team");
      return { claimedDispatches: [], deferred: 0, failures: 0 };
    },
    dispatch: async () => {
      calls.push("dispatch");
      return { kind: "started" as const, runId: run().id };
    },
    operator,
    projectTeamRuns: async () => {
      calls.push("project-team");
      throw new Error("one team failed");
    },
    provider: {
      resolveExecutionContext: async () => null,
      stop: async () => ({ kind: "stopped" as const }),
    },
    store: {
      scanExpiredDispatchLeases: async () => [],
    } as never,
  });

  assert.deepEqual(calls, ["project-team", "claim-team", "dispatch"]);
  assert.equal(result.dispatched, 1);
  assert.equal(result.failures, 1);
});

test("team claim and cancellation deferrals accumulate without becoming failures", async () => {
  const result = await reconcileAndDispatch({
    claimTeamRuns: async () => ({
      claimedDispatches: [],
      deferred: 2,
      failures: 3,
    }),
    operator,
    projectTeamRuns: async () => ({
      cancellationDeferred: 5,
      failures: 7,
    }),
    provider: {
      resolveExecutionContext: async () => null,
      stop: async () => ({ kind: "stopped" as const }),
    },
    store: {
      scanExpiredDispatchLeases: async () => [],
    } as never,
  });

  assert.equal(result.deferred, 7);
  assert.equal(result.failures, 10);
});

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaSandboxId: null,
    description: "",
    familiarId: "auto",
    id: "00000000-0000-4000-8000-000000000001",
    instructions: "safe instructions",
    lastRunAt: null,
    model: "auto",
    name: "agent",
    runtime: "copilot",
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning_ambiguous",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-08-28T14:00:00.000Z"),
    status: "idle",
    tenant: "tenant_a",
    updatedAt: new Date("2026-08-28T14:00:00.000Z"),
    version: 1,
    warmAttemptVersion: 0,
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async () => {
        calls.push("resolve");
        return {} as never;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "sandbox_reset_required" as const };
      },
    },
    randomToken: () => "cleanup-lease",
    resourceLifecycle: {
      reset: async (_run, resetAuthority) => {
        calls.push("reset");
        assert.equal(resetAuthority, authority);
        return { kind: "reset" as const };
      },
    },
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

test("cleanup-required attempts retain their fences without automatic workspace deletion or reacquisition", async () => {
  await Promise.all(
    [false, true].map(async (terminal) => {
      const calls: string[] = [];
      const pending = run(
        terminal
          ? {
              completedAt: new Date(),
              dispatchState: "terminal",
              status: "failed",
            }
          : {}
      );
      const authority = {
        attemptId,
        expectedVersion: pending.version + 1,
        leaseToken: "cleanup-lease",
        runId: pending.id,
      } as RunnerDispatchAuthority;
      const claimed = { authority, kind: "claimed" as const, run: pending };
      const forbidden = () => {
        calls.push("forbidden");
        throw new Error("cleanup-required must retain the exact attempt");
      };
      const result = await reconcileAndDispatch({
        operator,
        provider: {
          resolveExecutionContext: async () => ({}) as never,
          stop: async () => ({ kind: "cleanup_required" }),
        },
        releaseCredentialResources: forbidden,
        resourceLifecycle: { reset: forbidden },
        rollbackCredentialResources: forbidden,
        store: {
          appendTerminalCleanupDiagnostic: async () => {
            calls.push("diagnostic");
          },
          claimExpiredDaytonaAttemptCleanup: async () => claimed,
          claimTerminalDaytonaAttemptCleanup: async () => claimed,
          deleteAttemptRedaction: forbidden,
          releaseTerminalDaytonaAttempt: forbidden,
          requeueAfterDaytonaAttemptCleanup: forbidden,
          scanExpiredDispatchLeases: async () => (terminal ? [] : [pending]),
          scanTerminalDaytonaAttemptCleanups: async () =>
            terminal ? [pending] : [],
        } as never,
      });
      assert.equal(result.requeued, 0);
      assert.equal(result.terminalCleaned, 0);
      assert.equal(result.deferred, 1);
      assert.equal(calls.includes("forbidden"), false);
    })
  );
});

test("cancellation reports cleanup required without deleting a persistent workspace", async () => {
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
  const forbidden = () => {
    calls.push("forbidden");
    throw new Error("cleanup-required is not deletion authority");
  };
  const result = await cancelRunnerRun(active.id, {
    operator,
    provider: {
      resolveExecutionContext: async () => ({}) as never,
      stop: async () => ({ kind: "cleanup_required" }),
    },
    releaseCredentialResources: forbidden,
    resourceLifecycle: { reset: forbidden },
    store: {
      appendCancellationDiagnostic: async () => {
        calls.push("diagnostic");
      },
      deleteAttemptRedaction: forbidden,
      finalizeRun: forbidden,
      requestRunCancellation: async () => ({
        authority,
        kind: "requested",
        run: { ...active, cancellationRequestedAt: new Date() },
      }),
    } as never,
  });
  assert.deepEqual(result, { kind: "cleanup_required", runId: active.id });
  assert.deepEqual(calls, ["diagnostic"]);
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
      resolveExecutionContext: async () => {
        calls.push("resolve");
        return {} as never;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "provider_unavailable" as const };
      },
    },
    randomToken: () => "cleanup-lease",
    resourceLifecycle: {
      reset: async () => {
        calls.push("reset");
        return { kind: "reset" as const };
      },
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
      resolveExecutionContext: async () => {
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
        return {
          id: "sandbox",
          labels: {
            ...daytonaSandboxLabels(pending.tenant, pending.id),
            configurationId: SANDBOX_CONFIGURATION.configurationId,
            sandboxGeneration: String(pending.sandboxGeneration),
          },
        } as never;
      },
    },
    operator,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
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
      scanDaytonaWarmRecoveries: async () => [],
    } as never,
  });

  assert.deepEqual(calls, ["scan", "get", "attach"]);
  assert.deepEqual(result, { deferred: 0, failures: 0, recovered: 1 });
});

test("cron recovery refuses stale or unlabeled provisioning sandboxes without deleting or attaching them", async () => {
  for (const labels of [
    {
      ...daytonaSandboxLabels("tenant_a", agent().id),
      configurationId: "old-configuration",
      sandboxGeneration: "1",
    },
    {
      ...daytonaSandboxLabels("tenant_a", agent().id),
      configurationId: SANDBOX_CONFIGURATION.configurationId,
      sandboxGeneration: "0",
    },
    {},
  ]) {
    const calls: string[] = [];
    const pending = agent();
    // biome-ignore lint/performance/noAwaitInLoops: each stale identity owns an isolated reconciliation scan
    const result = await reconcileDaytonaSandboxes({
      daytona: {
        create: async () => {
          throw new Error("reconciliation must not create");
        },
        get: async () =>
          ({
            delete: async (timeout: number, wait: boolean) => {
              assert.equal(timeout, 60);
              assert.equal(wait, true);
              calls.push("delete");
            },
            id: "stale-sandbox",
            labels,
          }) as never,
        snapshot: usableSnapshot(),
      },
      operator,
      sandboxConfiguration: SANDBOX_CONFIGURATION,
      store: {
        attachDaytonaSandboxForRecovery: async () => {
          calls.push("attach");
          throw new Error("stale sandbox must not attach");
        },
        beginDaytonaSandboxResetForRecovery: async () => ({
          kind: "updated" as const,
          value: agent({
            sandboxGeneration: 2,
            sandboxLifecycle: "resetting",
            version: 2,
          }),
        }),
        finishDaytonaSandboxResetForRecovery: async () => {
          calls.push("reset");
          return {
            kind: "updated" as const,
            value: agent({
              sandboxGeneration: 2,
              sandboxLifecycle: "unprovisioned",
              version: 3,
            }),
          };
        },
        scanDaytonaSandboxRecoveries: async () => [pending],
        scanDaytonaWarmRecoveries: async () => [],
      } as never,
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(result, { deferred: 0, failures: 1, recovered: 0 });
  }
});

test("stale cron recovery cannot request a destructive reset for a newer sandbox", async () => {
  const pending = agent();
  let deletes = 0;
  const result = await reconcileDaytonaSandboxes({
    daytona: {
      create: async () => {
        throw new Error("reconciliation must not create");
      },
      get: async () =>
        ({
          delete: async () => {
            deletes += 1;
          },
          id: "newer-sandbox",
          labels: {
            ...daytonaSandboxLabels(pending.tenant, pending.id),
            configurationId: SANDBOX_CONFIGURATION.configurationId,
            sandboxGeneration: "2",
          },
        }) as never,
      snapshot: usableSnapshot(),
    },
    operator,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      beginDaytonaSandboxResetForRecovery: async () => ({
        kind: "stale_version" as const,
      }),
      scanDaytonaSandboxRecoveries: async () => [pending],
      scanDaytonaWarmRecoveries: async () => [],
    } as never,
  });

  assert.equal(deletes, 0);
  assert.deepEqual(result, { deferred: 0, failures: 1, recovered: 0 });
});

test("cron removes only the exact stale warm probe and fenced-finishes it", async () => {
  const stale = agent({
    daytonaSandboxId: "sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "ready",
    version: 7,
    warmStatus: "provisioning",
    warmUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
  });
  const owned = daytonaProbeSessionName(
    stale.id,
    stale.sandboxGeneration,
    stale.warmAttemptVersion,
    stale.warmUpdatedAt
  );
  const replacement = daytonaProbeSessionName(
    stale.id,
    stale.sandboxGeneration,
    stale.warmAttemptVersion + 1,
    new Date(stale.warmUpdatedAt.getTime() + 1)
  );
  const sessions = new Set([owned, replacement]);
  const deleted: string[] = [];
  const result = await reconcileDaytonaSandboxes({
    clock: () => new Date("2026-08-28T16:00:00.000Z"),
    daytona: {
      create: async () => {
        throw new Error("must not create");
      },
      get: async () =>
        ({
          id: "sandbox",
          process: {
            deleteSession: async (sessionId: string) => {
              deleted.push(sessionId);
              sessions.delete(sessionId);
            },
            listSessions: async () =>
              [...sessions].map((sessionId) => ({
                commands: [],
                sessionId,
              })),
          },
        }) as never,
    },
    operator,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      finishDaytonaSandboxWarmForRecovery: async (
        _operator: RunnerOperator,
        fence: {
          agentId: string;
          expectedGeneration: number;
          expectedVersion: number;
        }
      ) => {
        assert.deepEqual(fence, {
          agentId: stale.id,
          expectedGeneration: stale.sandboxGeneration,
          expectedVersion: stale.version,
        });
        return {
          kind: "updated" as const,
          value: agent({ ...stale, version: 8, warmStatus: "failed" }),
        };
      },
      scanDaytonaSandboxRecoveries: async () => [],
      scanDaytonaWarmRecoveries: async () => [stale],
    } as never,
  });

  assert.deepEqual(deleted, [owned]);
  assert.equal(sessions.has(replacement), true);
  assert.deepEqual(result, { deferred: 0, failures: 0, recovered: 1 });
});

test("stale warm recovery runs even when lifecycle recovery fills its batch", async () => {
  const recentLifecycle = Array.from({ length: 3 }, (_, index) =>
    agent({
      id: `00000000-0000-4000-8000-00000000000${index + 2}`,
      sandboxLifecycle: "provisioning",
      sandboxUpdatedAt: new Date("2026-08-28T15:59:00.000Z"),
    })
  );
  const staleWarm = agent({
    daytonaSandboxId: "sandbox",
    sandboxLifecycle: "ready",
    version: 7,
    warmAttemptVersion: 3,
    warmStatus: "provisioning",
    warmUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
  });
  const owned = daytonaProbeSessionName(
    staleWarm.id,
    staleWarm.sandboxGeneration,
    staleWarm.warmAttemptVersion,
    staleWarm.warmUpdatedAt
  );
  const sessions = new Set([owned]);
  const scans: string[] = [];

  const result = await reconcileDaytonaSandboxes({
    batchSize: 2,
    clock: () => new Date("2026-08-28T16:00:00.000Z"),
    daytona: {
      create: async () => {
        throw new Error("must not create");
      },
      get: async () =>
        ({
          id: "sandbox",
          process: {
            deleteSession: async (sessionId: string) => {
              sessions.delete(sessionId);
            },
            listSessions: async () =>
              [...sessions].map((sessionId) => ({
                commands: [],
                sessionId,
              })),
          },
        }) as never,
    },
    operator,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      finishDaytonaSandboxWarmForRecovery: async () => ({
        kind: "updated" as const,
        value: agent({ ...staleWarm, version: 8, warmStatus: "failed" }),
      }),
      scanDaytonaSandboxRecoveries: async (
        _operator: RunnerOperator,
        limit: number
      ) => {
        scans.push("lifecycle");
        assert.equal(limit, 2);
        return recentLifecycle.slice(0, limit);
      },
      scanDaytonaWarmRecoveries: async (
        _operator: RunnerOperator,
        staleBefore: Date,
        limit: number
      ) => {
        scans.push("warm");
        assert.equal(limit, 2);
        assert.equal(staleBefore.toISOString(), "2026-08-28T15:55:00.000Z");
        return [staleWarm];
      },
    } as never,
  });

  assert.deepEqual(scans, ["lifecycle", "warm"]);
  assert.equal(sessions.size, 0);
  assert.deepEqual(result, { deferred: 2, failures: 0, recovered: 1 });
});

test("a lifecycle scan outage does not block the stale warm lane", async () => {
  const staleWarm = agent({
    daytonaSandboxId: "missing-sandbox",
    sandboxLifecycle: "ready",
    version: 7,
    warmAttemptVersion: 3,
    warmStatus: "provisioning",
    warmUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
  });
  let finishes = 0;

  const result = await reconcileDaytonaSandboxes({
    clock: () => new Date("2026-08-28T16:00:00.000Z"),
    daytona: {
      create: async () => {
        throw new Error("must not create");
      },
      get: async () => {
        throw new DaytonaNotFoundError("missing");
      },
    },
    operator,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      finishDaytonaSandboxWarmForRecovery: async () => {
        finishes += 1;
        return {
          kind: "updated" as const,
          value: agent({ ...staleWarm, version: 8, warmStatus: "failed" }),
        };
      },
      scanDaytonaSandboxRecoveries: async () => {
        throw new Error("database unavailable");
      },
      scanDaytonaWarmRecoveries: async () => [staleWarm],
    } as never,
  });

  assert.equal(finishes, 1);
  assert.deepEqual(result, { deferred: 0, failures: 1, recovered: 1 });
});

test("recent and provider-failed warm recovery remains deferred and retryable", async () => {
  const recent = agent({
    daytonaSandboxId: "sandbox",
    sandboxLifecycle: "ready",
    version: 7,
    warmStatus: "provisioning",
    warmUpdatedAt: new Date("2026-08-28T15:59:00.000Z"),
  });
  let gets = 0;
  let finishes = 0;
  const recentResult = await reconcileDaytonaSandboxes({
    clock: () => new Date("2026-08-28T16:00:00.000Z"),
    daytona: {
      create: async () => {
        throw new Error("must not create");
      },
      get: async () => {
        gets += 1;
        throw new Error("must not get");
      },
    },
    operator,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      finishDaytonaSandboxWarmForRecovery: async () => {
        finishes += 1;
        return { kind: "stale_version" as const };
      },
      scanDaytonaSandboxRecoveries: async () => [],
      scanDaytonaWarmRecoveries: async () => [recent],
    } as never,
  });
  assert.deepEqual(recentResult, {
    deferred: 1,
    failures: 0,
    recovered: 0,
  });
  assert.equal(gets, 0);
  assert.equal(finishes, 0);

  const stale = agent({
    ...recent,
    warmUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
  });
  const failedResult = await reconcileDaytonaSandboxes({
    clock: () => new Date("2026-08-28T16:00:00.000Z"),
    daytona: {
      create: async () => {
        throw new Error("must not create");
      },
      get: async () =>
        ({
          id: "sandbox",
          process: {
            deleteSession: async () => {
              throw new Error("provider unavailable");
            },
            listSessions: async () => [
              {
                commands: [],
                sessionId: daytonaProbeSessionName(
                  stale.id,
                  stale.sandboxGeneration,
                  stale.warmAttemptVersion,
                  stale.warmUpdatedAt
                ),
              },
            ],
          },
        }) as never,
    },
    operator,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      finishDaytonaSandboxWarmForRecovery: async () => {
        finishes += 1;
        return { kind: "stale_version" as const };
      },
      scanDaytonaSandboxRecoveries: async () => [],
      scanDaytonaWarmRecoveries: async () => [stale],
    } as never,
  });
  assert.deepEqual(failedResult, {
    deferred: 1,
    failures: 0,
    recovered: 0,
  });
  assert.equal(finishes, 0);
});

test("overlapping warm recovery is idempotent under the version fence", async () => {
  const stale = agent({
    daytonaSandboxId: "sandbox",
    sandboxLifecycle: "ready",
    version: 7,
    warmStatus: "provisioning",
    warmUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
  });
  const owned = daytonaProbeSessionName(
    stale.id,
    stale.sandboxGeneration,
    stale.warmAttemptVersion,
    stale.warmUpdatedAt
  );
  const sessions = new Set([owned]);
  let finishes = 0;
  const result = await reconcileDaytonaSandboxes({
    clock: () => new Date("2026-08-28T16:00:00.000Z"),
    daytona: {
      create: async () => {
        throw new Error("must not create");
      },
      get: async () =>
        ({
          id: "sandbox",
          process: {
            deleteSession: async (sessionId: string) => {
              sessions.delete(sessionId);
            },
            listSessions: async () =>
              [...sessions].map((sessionId) => ({
                commands: [],
                sessionId,
              })),
          },
        }) as never,
    },
    operator,
    providerConcurrency: 2,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      finishDaytonaSandboxWarmForRecovery: async () => {
        finishes += 1;
        return finishes === 1
          ? {
              kind: "updated" as const,
              value: agent({ ...stale, version: 8, warmStatus: "failed" }),
            }
          : { kind: "stale_version" as const };
      },
      scanDaytonaSandboxRecoveries: async () => [],
      scanDaytonaWarmRecoveries: async () => [stale, stale],
    } as never,
  });

  assert.deepEqual(result, { deferred: 1, failures: 0, recovered: 1 });
  assert.equal(sessions.size, 0);
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
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      deleteDecommissionedAgentForRecovery: async () => {
        calls.push("remove");
        return { kind: "deleted" as const };
      },
      scanDaytonaSandboxRecoveries: async () => {
        calls.push("scan");
        return [deleting];
      },
      scanDaytonaWarmRecoveries: async () => [],
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
      resolveExecutionContext: async () => {
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
    resourceLifecycle: {
      reset: async () => {
        calls.push("reset");
        return { kind: "reset" as const };
      },
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
      resolveExecutionContext: async () => {
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
    resourceLifecycle: {
      reset: async () => {
        calls.push("reset");
        return { kind: "reset" as const };
      },
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
      resolveExecutionContext: async () => {
        calls.push("resolve");
        return {} as never;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "sandbox_reset_required" as const };
      },
    },
    randomToken: () => "terminal-cleanup",
    resourceLifecycle: {
      reset: async () => {
        calls.push("reset");
        return { kind: "sandbox_reset_required" as const };
      },
    },
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async (runnerRun) => {
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async () => {
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

test("a terminal command with a persistently unsettled tail releases capacity after the run limit", async () => {
  const calls: string[] = [];
  const attached = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    startedAt: new Date("2026-08-28T14:44:00.000Z"),
    status: "running",
  });
  const authority = {
    attemptId,
    expectedVersion: attached.version + 1,
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
    maxRunDurationMs: RUNNER_MID_RUN_ENTITLEMENT_POLICY.maxDurationMs,
    openAttemptRedaction: async () => "redaction-secret",
    operator,
    provider: {
      resolveExecutionContext: async () => {
        calls.push("resolve");
        return {} as never;
      },
      snapshot: async () => {
        calls.push("snapshot");
        return {
          cursor: 21,
          events: [
            {
              at: "2026-08-28T14:55:00.000Z",
              kind: "message",
              model: null,
              text: "Last complete safe update.",
            },
          ],
          exitCode: 0,
          logsSettled: false,
          status: "completed",
          summary: {
            fileOperations: [],
            output: "Last complete safe update.",
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
      appendDispatchEventBatch: async (
        _operator: unknown,
        _authority: unknown,
        batch: unknown
      ) => {
        calls.push("append-batch");
        assert.equal(
          (batch as { snapshot: { output: string } }).snapshot.output,
          "Last complete safe update."
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
        const input = finalization as {
          error: { code: string; details: string; retryable: boolean };
          output: string;
          status: string;
        };
        assert.equal(input.error.code, "run_output_incomplete");
        assert.equal(input.error.retryable, true);
        assert.match(input.error.details, /complete sanitized updates/iu);
        assert.equal(input.output, "Last complete safe update.");
        assert.equal(input.status, "failed");
        return {
          kind: "finalized" as const,
          prunedRunIds: [],
          run: {
            ...attached,
            completedAt: new Date("2026-08-28T15:00:00.000Z"),
            dispatchState: "terminal",
            error: input.error,
            output: input.output,
            status: "failed",
            version: afterTerminal.expectedVersion,
          },
        };
      },
      readAttemptRedaction: async () => ({
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
      }),
      releaseTerminalDaytonaAttempt: async () => {
        calls.push("release-attempt");
        return { authority: afterTerminal, kind: "released" as const };
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
    "append-batch",
    "finalize",
    "stop",
    "release-credential",
    "delete-redaction",
    "release-attempt",
    "cleanup-lease",
  ]);
  assert.equal(result.terminalized, 1);
  assert.equal(result.logEvents, 1);
});

test("the watchdog captures available evidence and terminalizes an overlong running command", async () => {
  const calls: string[] = [];
  const attached = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    startedAt: new Date("2026-08-28T14:44:00.000Z"),
    status: "running",
  });
  const authority = {
    attemptId,
    expectedVersion: attached.version + 1,
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
    maxRunDurationMs: RUNNER_MID_RUN_ENTITLEMENT_POLICY.maxDurationMs,
    openAttemptRedaction: async () => "redaction-secret",
    operator,
    provider: {
      resolveExecutionContext: async () => {
        calls.push("resolve");
        return {} as never;
      },
      snapshot: async () => {
        calls.push("snapshot");
        return {
          cursor: 21,
          events: [
            {
              at: "2026-08-28T14:55:00.000Z",
              kind: "message",
              model: null,
              text: "Last complete safe update.",
            },
          ],
          exitCode: null,
          logsSettled: false,
          status: "running",
          summary: {
            fileOperations: [],
            output: "Last complete safe update.",
            premiumRequests: null,
            sessionId: null,
            status: "failed",
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
      appendDispatchEventBatch: async (
        _operator: unknown,
        _authority: unknown,
        batch: unknown
      ) => {
        calls.push("append-batch");
        assert.equal(
          (batch as { snapshot: { output: string } }).snapshot.output,
          "Last complete safe update."
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
        const input = finalization as {
          completedAt: Date;
          error: { code: string; retryable: boolean };
          output: string;
          status: string;
        };
        assert.equal(
          input.completedAt.toISOString(),
          "2026-08-28T15:00:00.000Z"
        );
        assert.equal(input.error.code, "run_timeout");
        assert.equal(input.error.retryable, true);
        assert.equal(input.output, "Last complete safe update.");
        assert.equal(input.status, "failed");
        return {
          kind: "finalized" as const,
          prunedRunIds: [],
          run: {
            ...attached,
            completedAt: input.completedAt,
            dispatchState: "terminal",
            error: input.error,
            output: input.output,
            status: "failed",
            version: afterTerminal.expectedVersion,
          },
        };
      },
      readAttemptRedaction: async () => ({
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
      }),
      releaseTerminalDaytonaAttempt: async () => {
        calls.push("release-attempt");
        return { authority: afterTerminal, kind: "released" as const };
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
    "append-batch",
    "finalize",
    "stop",
    "release-credential",
    "delete-redaction",
    "release-attempt",
    "cleanup-lease",
  ]);
  assert.equal(result.terminalized, 1);
  assert.equal(result.logEvents, 1);
  assert.equal(result.failures, 0);
});

test("finish-current recovery converges an exact running attempt without billing authority", async () => {
  const calls: string[] = [];
  let billingLookups = 0;
  const attached = run({
    daytonaCommandId: "command",
    daytonaSessionId: "session",
    dispatchState: "running",
    executionProvenance: { provider: "durable-test" } as never,
    startedAt: new Date("2026-08-28T14:59:00.000Z"),
    status: "running",
  });
  const authority = {
    attemptId,
    expectedVersion: attached.version + 1,
    leaseToken: "finish-current-lease",
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

  const dependencies: ReconcileAndDispatchDependencies & {
    findAccount: () => never;
  } = {
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    consumeCredentialReservation: async () => {
      calls.push("consume-existing-reservation");
    },
    // Reconciliation has no entitlement dependency. This sentinel proves the
    // exact running-attempt path neither reads nor needs one.
    findAccount: () => {
      billingLookups += 1;
      throw new Error("running attempt must not revalidate billing");
    },
    operator,
    provider: {
      requiresAttemptRedaction: false,
      resolveExecutionContext: async () => {
        calls.push("resolve");
        return {} as never;
      },
      snapshot: async () => {
        calls.push("snapshot");
        return {
          cursor: 1,
          events: [],
          exitCode: 0,
          logsSettled: true,
          status: "completed" as const,
          summary: {
            fileOperations: [],
            output: "Finished after entitlement revocation.",
            premiumRequests: 0,
            sessionId: null,
            status: "completed" as const,
            toolCalls: [],
          },
        };
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "stopped" as const };
      },
    },
    randomToken: () => "finish-current-lease",
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
          authority: afterEvent,
          events: [],
          kind: "appended" as const,
          run: attached,
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
      readAttemptRedaction: async () => {
        calls.push("read-redaction");
        return { kind: "not_found" as const };
      },
      releaseTerminalDaytonaAttempt: async () => {
        calls.push("release-attempt");
        return { authority: afterTerminal, kind: "released" as const };
      },
      scanExpiredDispatchLeases: async () => {
        calls.push("scan");
        return [attached];
      },
    } as never,
  };
  const result = await reconcileAndDispatch(dependencies);

  assert.equal(billingLookups, 0);
  assert.deepEqual(calls, [
    "scan",
    "adopt",
    "resolve",
    "consume-existing-reservation",
    "read-redaction",
    "snapshot",
    "append-batch",
    "finalize",
    "stop",
    "release-credential",
    "delete-redaction",
    "release-attempt",
    "cleanup-lease",
  ]);
  assert.equal(result.adopted, 1);
  assert.equal(result.terminalized, 1);
  assert.equal(result.failures, 0);
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async () => {
        calls.push("resolve");
        return {} as never;
      },
      stop: async () => {
        calls.push("stop");
        return { kind: "sandbox_reset_required" as const };
      },
    },
    randomToken: () => "cancel-lease",
    resourceLifecycle: {
      reset: async () => {
        calls.push("reset");
        return { kind: "sandbox_reset_required" as const };
      },
    },
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async () => null,
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async () => null,
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
      resolveExecutionContext: async () => ({}) as never,
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
      resolveExecutionContext: async () => ({}) as never,
      stop: async () => ({ kind: "sandbox_reset_required" as const }),
    },
    resourceLifecycle: {
      reset: async () => ({ kind: "stale_version" as const }),
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
      resolveExecutionContext: async () => null,
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
      resolveExecutionContext: async () => {
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
      resolveExecutionContext: async () => {
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
  const credentialSecrets = [
    "attempt-redaction-secret",
    "github-capability-secret",
  ];
  const credential = encodeRunnerAttemptRedactionSecrets(credentialSecrets);
  const commandId = "daytona-command-neutral-projection";
  const sessionId = "daytona-session-neutral-projection";
  const attached = run({
    daytonaCommandId: commandId,
    daytonaSessionId: sessionId,
    dispatchState: "running",
    startedAt: new Date("2026-08-28T14:58:00.000Z"),
    status: "running",
  });
  const privateValues = [
    ...credentialSecrets,
    attached.daytonaAttemptId,
    commandId,
    sessionId,
  ].filter((value): value is string => value !== null);
  const planted = privateValues.join(" | ");
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
      resolveExecutionContext: async () => {
        calls.push("resolve");
        return {} as never;
      },
      snapshot: async (input) => {
        calls.push("snapshot");
        for (const value of privateValues) {
          assert.equal(
            sanitizeEvidenceText(planted, input.credential).includes(value),
            false,
            `provider snapshot input must redact ${value}`
          );
        }
        return {
          cursor: 42,
          events: [
            {
              at: "2026-08-28T15:00:00.000Z",
              kind: "message",
              model: null,
              text: `message ${planted}`,
            },
            {
              at: "2026-08-28T15:00:00.000Z",
              callId: planted,
              kind: "tool-start",
              summary: planted,
              tool: planted,
            },
            {
              at: "2026-08-28T15:00:00.000Z",
              callId: planted,
              kind: "tool-end",
              success: true,
              summary: planted,
            },
            {
              at: "2026-08-28T15:00:00.000Z",
              kind: "file",
              operation: "edit",
              path: `/workspace/${planted}`,
            },
          ],
          exitCode: 0,
          logsSettled: true,
          status: "completed",
          summary: {
            fileOperations: [{ operation: "modify", path: planted }],
            output: `output ${planted}`,
            premiumRequests: null,
            sessionId: null,
            status: "completed",
            toolCalls: [{ success: true, summary: planted, tool: planted }],
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
    resourceLifecycle: {
      reset: async () => {
        calls.push("reset");
        return { kind: "reset" as const };
      },
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
        for (const value of privateValues) {
          assert.equal(
            JSON.stringify(batch).includes(value),
            false,
            `provider events must redact ${value} before persistence`
          );
        }
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
        for (const value of privateValues) {
          assert.equal(
            JSON.stringify(finalization).includes(value),
            false,
            `terminal evidence must redact ${value} before persistence`
          );
        }
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

/**
 * A row reaches `resetting` because some earlier reprovision decided to
 * replace the workspace, but this scanner finishes that decision later and in
 * another process. If it deleted on the strength of that earlier decision, a
 * snapshot deleted or repointed in between would cost the workspace with
 * nothing able to rebuild it. Deferring leaves the row stuck and visible,
 * which is strictly better.
 */
test("cron never treats a legacy resetting row as consent to delete an existing workspace", async () => {
  await Promise.all(
    [false, true].map(async (exists) => {
      const pending = agent({
        daytonaSandboxId: "existing",
        sandboxLifecycle: "resetting",
      });
      let deletes = 0;
      let finishes = 0;
      const result = await reconcileDaytonaSandboxes({
        daytona: {
          create: () => Promise.reject(new Error("must not create")),
          get: () =>
            exists
              ? Promise.resolve({
                  delete: () => {
                    deletes += 1;
                    return Promise.resolve();
                  },
                  id: "existing",
                } as never)
              : Promise.reject(new DaytonaNotFoundError("absent")),
          snapshot: usableSnapshot(),
        },
        operator,
        sandboxConfiguration: SANDBOX_CONFIGURATION,
        store: {
          finishDaytonaSandboxResetForRecovery: () => {
            finishes += 1;
            return Promise.resolve({ kind: "updated", value: pending });
          },
          scanDaytonaSandboxRecoveries: () => Promise.resolve([pending]),
          scanDaytonaWarmRecoveries: () => Promise.resolve([]),
        } as never,
      });
      assert.equal(deletes, 0);
      assert.equal(finishes, exists ? 0 : 1);
      assert.deepEqual(result, {
        deferred: exists ? 1 : 0,
        failures: 0,
        recovered: exists ? 0 : 1,
      });
    })
  );
});

test("cron recovery defers a reset it cannot complete instead of deleting the workspace", async () => {
  const calls: string[] = [];
  const pending = agent({
    daytonaSandboxId: "stale-sandbox",
    sandboxGeneration: 2,
    sandboxLifecycle: "resetting",
    version: 2,
  });

  const result = await reconcileDaytonaSandboxes({
    daytona: {
      create: () => {
        throw new Error("reconciliation must not create");
      },
      get: () =>
        ({
          delete: () => {
            calls.push("delete");
            return Promise.resolve();
          },
          id: "stale-sandbox",
        }) as never,
      snapshot: {
        get: () => Promise.reject(new DaytonaNotFoundError("snapshot absent")),
      },
    },
    operator,
    sandboxConfiguration: SANDBOX_CONFIGURATION,
    store: {
      attachDaytonaSandboxForRecovery: () => {
        throw new Error("must not attach");
      },
      finishDaytonaSandboxResetForRecovery: () => {
        calls.push("reset");
        throw new Error("must not finish a reset it could not perform");
      },
      scanDaytonaSandboxRecoveries: () => Promise.resolve([pending]),
      scanDaytonaWarmRecoveries: () => Promise.resolve([]),
    } as never,
  });

  assert.deepEqual(calls, [], "no deletion and no reset completion");
  // A refusal must report as a failure. "deferred" is indistinguishable from
  // "not yet stale", and the batch summary reports "recovered" whenever any
  // other row succeeds, so a wedged fleet would look healthy every tick.
  assert.deepEqual(result, { deferred: 0, failures: 1, recovered: 0 });
});

/**
 * The provisioning-identity-mismatch branch is the one a configurationId
 * change actually drives: after a snapshot or policy bump every sandbox in the
 * fleet mismatches. Guarding only the `resetting` branch left this one
 * deleting workspaces for a snapshot that cannot replace them.
 */
test("cron recovery refuses the provisioning mismatch branch when the snapshot cannot replace the workspace", async () => {
  for (const snapshot of [
    {
      get: () => Promise.reject(new DaytonaNotFoundError("snapshot absent")),
      label: "missing",
      permanent: true,
    },
    {
      get: (name: string) =>
        Promise.resolve({ cpu: 2, disk: 10, mem: 4, name, state: "error" }),
      label: "inactive",
      permanent: true,
    },
    {
      // Mid-build is the state a freshly bumped generation passes through.
      // It must defer, not fail: the deploy window heals itself.
      get: (name: string) =>
        Promise.resolve({ cpu: 2, disk: 10, mem: 4, name, state: "building" }),
      label: "still building",
      permanent: false,
    },
    {
      get: (name: string) =>
        Promise.resolve({ cpu: 1, disk: 3, mem: 1, name, state: "active" }),
      label: "below policy",
      permanent: true,
    },
  ]) {
    let deletes = 0;
    const pending = agent({
      daytonaSandboxId: "stale-sandbox",
      sandboxGeneration: 2,
      sandboxLifecycle: "provisioning",
      version: 2,
    });

    // biome-ignore lint/performance/noAwaitInLoops: each case needs its own isolated reconcile
    const result = await reconcileDaytonaSandboxes({
      daytona: {
        create: () => {
          throw new Error("reconciliation must not create");
        },
        get: () =>
          ({
            delete: () => {
              deletes += 1;
              return Promise.resolve();
            },
            id: "stale-sandbox",
            // No provisioning identity labels: a guaranteed mismatch.
            labels: {},
          }) as never,
        snapshot: { get: snapshot.get },
      },
      operator,
      provisioningStaleBefore: new Date("2030-01-01T00:00:00.000Z"),
      sandboxConfiguration: SANDBOX_CONFIGURATION,
      store: {
        attachDaytonaSandboxForRecovery: () => {
          throw new Error("must not attach");
        },
        // These succeed deliberately. If they threw, the test would pass
        // even with the guard removed — the deletion would be blocked by the
        // store double rather than by the guard under test.
        beginDaytonaSandboxResetForRecovery: () =>
          Promise.resolve({
            kind: "updated" as const,
            value: agent({
              sandboxGeneration: 2,
              sandboxLifecycle: "resetting",
              version: 3,
            }),
          }),
        finishDaytonaSandboxResetForRecovery: () =>
          Promise.resolve({
            kind: "updated" as const,
            value: agent({
              sandboxGeneration: 2,
              sandboxLifecycle: "unprovisioned",
              version: 4,
            }),
          }),
        scanDaytonaSandboxRecoveries: () => Promise.resolve([pending]),
        scanDaytonaWarmRecoveries: () => Promise.resolve([]),
      } as never,
    });

    assert.equal(
      deletes,
      0,
      `a ${snapshot.label} snapshot must not cost the tenant its workspace`
    );
    assert.equal(
      result.recovered,
      0,
      `a ${snapshot.label} snapshot must not report recovery`
    );
    assert.equal(
      result.failures,
      snapshot.permanent ? 1 : 0,
      `a ${snapshot.label} snapshot must report ${snapshot.permanent ? "a failure" : "a deferral"}`
    );
  }
});
