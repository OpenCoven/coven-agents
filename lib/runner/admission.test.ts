// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import {
  admissionLimitsFromEnvironment,
  admitRunnerRun,
  dispatchNextRunnerRun,
  RunnerAdmissionConfigurationError,
} from "./admission";
import { DaytonaProcessError } from "./daytona/process";
import type {
  RunnerAgentRecord,
  RunnerClaimedDispatch,
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
    daytonaAttemptId: null,
    daytonaCommandId: null,
    daytonaSessionId: null,
    dispatchLeaseExpiresAt: new Date("2026-08-28T15:01:00.000Z"),
    dispatchLeaseToken: "claim-lease",
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
    daytonaLogCursor: overrides.daytonaLogCursor ?? 0,
  };
}

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaSandboxId: "sandbox",
    description: "",
    id: run().agentId,
    instructions: "safe instructions",
    lastRunAt: null,
    model: "auto",
    name: "test",
    runtime: "copilot",
    sandboxGeneration: 1,
    sandboxLifecycle: "ready",
    sandboxUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
    status: "idle",
    tenant: "tenant_a",
    updatedAt: new Date("2026-08-28T15:00:00.000Z"),
    version: 1,
    warmStatus: "ready",
    warmUpdatedAt: new Date("2026-08-28T15:00:00.000Z"),
    workspace: null,
    ...overrides,
  };
}

test("admission configuration defaults to the validated queue limits", () => {
  assert.deepEqual(admissionLimitsFromEnvironment({}), {
    consecutiveDispatches: 2,
    deploymentActiveRuns: 25,
    tenantActiveRuns: 2,
    tenantQueuedRuns: 10,
  });
});

test("admission configuration preserves zero as a zero-capacity limit", () => {
  assert.deepEqual(
    admissionLimitsFromEnvironment({
      RUN_ADMISSION_CONSECUTIVE_MAX: "0",
      RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX: "0",
      RUN_ADMISSION_MODE: "queue",
      RUN_ADMISSION_TENANT_ACTIVE_MAX: "0",
      RUN_ADMISSION_TENANT_QUEUE_MAX: "0",
    }),
    {
      consecutiveDispatches: 0,
      deploymentActiveRuns: 0,
      tenantActiveRuns: 0,
      tenantQueuedRuns: 0,
    }
  );
});

test("admission configuration rejects a non-queue mode", () => {
  assert.throws(
    () => admissionLimitsFromEnvironment({ RUN_ADMISSION_MODE: "reject" }),
    RunnerAdmissionConfigurationError
  );
});

test("operation reuse with another immutable hash is a typed conflict", async () => {
  const current = run();
  const result = await admitRunnerRun(
    {
      agentId: current.agentId,
      id: current.id,
      operationId: current.operationId,
      principal: { kind: "subscriber", tenant: current.tenant, userId: "user" },
      requestHash: current.requestHash,
      task: current.task,
    },
    {
      clock: () => new Date("2026-08-28T15:00:00.000Z"),
      limits: admissionLimitsFromEnvironment({}),
      randomToken: () => "lease",
      store: {
        startRun: async () => ({
          kind: "conflict" as const,
          run: {} as never,
        }),
      } as never,
    }
  );

  assert.equal(result.kind, "refused");
  assert.equal(
    result.kind === "refused" && result.error.code,
    "operation_conflict"
  );
});

test("admission store outages return a typed retryable error without a database cause", async () => {
  const current = run();
  const result = await admitRunnerRun(
    {
      agentId: current.agentId,
      id: current.id,
      operationId: current.operationId,
      principal: { kind: "subscriber", tenant: current.tenant, userId: "user" },
      requestHash: current.requestHash,
      task: current.task,
    },
    {
      clock: () => new Date("2026-08-28T15:00:00.000Z"),
      limits: admissionLimitsFromEnvironment({}),
      randomToken: () => "lease",
      store: {
        startRun: async () => {
          throw new Error("database connection token=unsafe");
        },
      } as never,
    }
  );

  assert.equal(result.kind, "refused");
  assert.equal(result.kind === "refused" && result.error.retryable, true);
  assert.equal(
    JSON.stringify(result).includes("database connection token=unsafe"),
    false
  );
});

test("dispatch claim outages do not expose store errors", async () => {
  const result = await dispatchNextRunnerRun({
    acquireCredential: async () => {
      throw new Error("must not acquire");
    },
    credentialInput: () => {
      throw new Error("must not build input");
    },
    ensureSandbox: async () => {
      throw new Error("must not resolve");
    },
    limits: admissionLimitsFromEnvironment({}),
    operator,
    randomToken: () => "lease",
    store: {
      claimNextDispatch: async () => {
        throw new Error("database token=unsafe");
      },
    } as never,
  });

  assert.deepEqual(result, {
    kind: "unavailable",
    reason: "admission_unavailable",
  });
});

test("dispatch claims before sandbox and credential acquisition", async () => {
  const calls: string[] = [];
  let persistedRedaction: unknown;
  const claimedRun = run();
  const authority = {
    expectedVersion: claimedRun.version,
    leaseToken: claimedRun.dispatchLeaseToken as string,
    runId: claimedRun.id,
  } as RunnerDispatchAuthority;
  const claimed: RunnerClaimedDispatch = { authority, run: claimedRun };
  const startedAuthority = {
    attemptId,
    expectedVersion: authority.expectedVersion + 2,
    leaseToken: authority.leaseToken,
    runId: authority.runId,
  } as RunnerDispatchAuthority;
  const store = {
    authorizeDaytonaLaunch: async () => {
      calls.push("authorize-launch");
      return {
        authority: startedAuthority,
        kind: "authorized" as const,
        value: run({
          daytonaAttemptId: attemptId,
          daytonaCommandId: "command",
          daytonaSessionId: "session",
        }),
      };
    },
    authorizeDaytonaPreparation: async () => {
      calls.push("authorize-preparation");
      return {
        attemptId,
        authority: {
          ...authority,
          attemptId,
          expectedVersion: authority.expectedVersion + 1,
        } as RunnerDispatchAuthority,
        kind: "authorized" as const,
      };
    },
    claimNextDispatch: async () => {
      calls.push("claim");
      return claimed;
    },
    deleteAttemptRedaction: async () => ({ kind: "deleted" as const }),
    getDispatchAgent: async () => {
      calls.push("get-agent");
      return { agent: agent(), kind: "found" as const, run: claimedRun };
    },
    markDispatchRunningForDispatch: async () => {
      calls.push("mark-running");
      return {
        authority: startedAuthority,
        kind: "updated" as const,
        value: run({
          daytonaAttemptId: attemptId,
          daytonaCommandId: "command",
          daytonaSessionId: "session",
          dispatchState: "running",
          startedAt: new Date("2026-08-28T15:00:01.000Z"),
          status: "running",
        }),
      };
    },
    persistAttemptRedaction: async (...arguments_: unknown[]) => {
      const [, , redaction] = arguments_;
      calls.push("persist-redaction");
      persistedRedaction = redaction;
      return { kind: "persisted" as const };
    },
    releaseDaytonaPreparation: async () => ({
      authority,
      kind: "released" as const,
    }),
    releaseUnstartedDispatch: async () => ({
      kind: "released" as const,
      value: claimedRun,
    }),
  };

  const result = await dispatchNextRunnerRun({
    acquireCredential: async () => {
      calls.push("credential");
      return {
        acquisition: {
          abort: async () => {
            calls.push("abort");
          },
          commit: async () => {
            calls.push("commit");
          },
          toJSON: () => "[redacted]",
          use: async <T>(
            boundary: (credential: { credential: string | null }) => Promise<T>
          ) => await boundary({ credential: "secret" }),
        },
        kind: "acquired" as const,
      } as never;
    },
    clock: () => new Date("2026-08-28T15:00:00.000Z"),
    credentialInput: () =>
      ({
        globalDailyCap: 500,
        harnessId: "copilot",
        keySecret: "test-key",
        operationId: claimedRun.operationId,
        periodStart: new Date("2026-08-01T00:00:00.000Z"),
        runId: claimedRun.id,
        tenant: claimedRun.tenant,
      }) as never,
    ensureSandbox: async () => {
      calls.push("sandbox");
      return { agent: agent(), sandbox: {} as never };
    },
    limits: admissionLimitsFromEnvironment({}),
    operator,
    randomToken: () => "next-lease",
    sealAttemptRedaction: async (input) => {
      calls.push("seal-redaction");
      assert.equal(input.credential, "secret");
      return {
        aadVersion: 1,
        ciphertext: "ciphertext",
        iv: "iv",
        kekVersion: "v1",
        wrappedKey: "wrapped-key",
      };
    },
    startProcess: async (input) => {
      calls.push("start");
      const prepared = await input.authorizePreparation({ runId: input.runId });
      assert.equal(prepared, attemptId);
      assert.equal(
        await input.persistAttemptRedaction({
          attemptId,
          credential: "secret",
          runId: input.runId,
        }),
        true
      );
      const launched = await input.authorizeLaunch({
        attemptId,
        commandId: "command",
        runId: input.runId,
        sessionId: "session",
      });
      assert.ok(launched);
      return {
        attemptId,
        commandId: "command",
        credentialPath: "/credential",
        dispatchAuthority: startedAuthority,
        sessionId: "session",
        workspace: "/workspace",
      };
    },
    store,
  });

  assert.deepEqual(result, { kind: "started", runId: claimedRun.id });
  assert.deepEqual(calls, [
    "claim",
    "get-agent",
    "sandbox",
    "credential",
    "commit",
    "start",
    "authorize-preparation",
    "seal-redaction",
    "persist-redaction",
    "authorize-launch",
    "mark-running",
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
  assert.equal(JSON.stringify(persistedRedaction).includes("secret"), false);
});

test("a proven failed launch compensates accounting with the callback's current fence", async () => {
  const calls: string[] = [];
  const claimedRun = run();
  const authority = {
    expectedVersion: claimedRun.version,
    leaseToken: claimedRun.dispatchLeaseToken as string,
    runId: claimedRun.id,
  } as RunnerDispatchAuthority;
  const releasedAuthority = {
    expectedVersion: authority.expectedVersion + 2,
    leaseToken: authority.leaseToken,
    runId: authority.runId,
  } as RunnerDispatchAuthority;
  const store = {
    authorizeDaytonaLaunch: async () => ({ kind: "not_live" as const }),
    authorizeDaytonaPreparation: async () => {
      calls.push("prepare");
      return {
        attemptId,
        authority: {
          ...authority,
          attemptId,
          expectedVersion: authority.expectedVersion + 1,
        } as RunnerDispatchAuthority,
        kind: "authorized" as const,
      };
    },
    claimNextDispatch: async () => ({ authority, run: claimedRun }),
    getDispatchAgent: async () => ({
      agent: agent(),
      kind: "found" as const,
      run: claimedRun,
    }),
    releaseDaytonaPreparation: async () => {
      calls.push("release-preparation");
      return { authority: releasedAuthority, kind: "released" as const };
    },
    releaseUnstartedDispatch: async (
      _operator: RunnerOperator,
      actual: RunnerDispatchAuthority
    ) => {
      calls.push(`release:${actual.expectedVersion}`);
      return { kind: "released" as const, value: claimedRun };
    },
  };
  const result = await dispatchNextRunnerRun({
    acquireCredential: async () => ({
      acquisition: {
        abort: async () => {
          calls.push("abort");
        },
        commit: async () => {
          calls.push("commit");
        },
        compensate: async () => {
          calls.push("compensate");
        },
        toJSON: () => "[redacted]",
        use: async <T>(
          boundary: (credential: { credential: string | null }) => Promise<T>
        ) => await boundary({ credential: "secret" }),
      } as never,
      kind: "acquired" as const,
    }),
    credentialInput: () => ({}) as never,
    ensureSandbox: async () => ({ agent: agent(), sandbox: {} as never }),
    limits: admissionLimitsFromEnvironment({}),
    operator,
    randomToken: () => "lease",
    startProcess: async (input) => {
      await input.authorizePreparation({ runId: input.runId });
      await input.releasePreparation({ attemptId, runId: input.runId });
      throw new DaytonaProcessError(
        "safe failed start",
        "process_start_failed",
        true
      );
    },
    store: store as never,
  });

  assert.deepEqual(result, {
    kind: "retryable",
    reason: "dispatch_failed",
    runId: claimedRun.id,
  });
  assert.deepEqual(calls, [
    "commit",
    "prepare",
    "release-preparation",
    "compensate",
    "release:3",
  ]);
});

test("an accounting commit outage never starts an unaccounted provider command", async () => {
  const calls: string[] = [];
  const claimedRun = run();
  const authority = {
    expectedVersion: claimedRun.version,
    leaseToken: claimedRun.dispatchLeaseToken as string,
    runId: claimedRun.id,
  } as RunnerDispatchAuthority;
  const result = await dispatchNextRunnerRun({
    acquireCredential: async () => ({
      acquisition: {
        commit: async () => {
          calls.push("commit");
          throw new Error("transient billing outage");
        },
        compensate: async () => {
          calls.push("compensate");
        },
        toJSON: () => "[redacted]",
        use: async <T>(
          boundary: (credential: { credential: string | null }) => Promise<T>
        ) => await boundary({ credential: "secret" }),
      } as never,
      kind: "acquired" as const,
    }),
    credentialInput: () => ({}) as never,
    ensureSandbox: async () => ({ agent: agent(), sandbox: {} as never }),
    limits: admissionLimitsFromEnvironment({}),
    operator,
    randomToken: () => "lease",
    startProcess: async () => {
      calls.push("start");
      throw new Error("provider must not start");
    },
    store: {
      claimNextDispatch: async () => ({ authority, run: claimedRun }),
      getDispatchAgent: async () => ({
        agent: agent(),
        kind: "found" as const,
        run: claimedRun,
      }),
      releaseUnstartedDispatch: async () => {
        calls.push("release");
        return { kind: "released" as const, value: claimedRun };
      },
    } as never,
  });

  assert.deepEqual(result, {
    kind: "retryable",
    reason: "credential_unavailable",
    runId: claimedRun.id,
  });
  assert.deepEqual(calls, ["commit", "compensate", "release"]);
});

test("capacity refusal terminalizes the claimed run before freeing its lease", async () => {
  const calls: string[] = [];
  const claimedRun = run();
  const authority = {
    expectedVersion: claimedRun.version,
    leaseToken: claimedRun.dispatchLeaseToken as string,
    runId: claimedRun.id,
  } as RunnerDispatchAuthority;
  const terminal = run({
    ...claimedRun,
    completedAt: new Date("2026-08-28T15:00:01.000Z"),
    dispatchState: "terminal",
    status: "failed",
    version: authority.expectedVersion + 1,
  });
  const store = {
    claimNextDispatch: async () => ({ authority, run: claimedRun }),
    cleanupTerminalLease: async () => {
      calls.push("cleanup");
      return { kind: "updated" as const, value: terminal };
    },
    finalizeRun: async () => {
      calls.push("finalize");
      return { kind: "finalized" as const, prunedRunIds: [], run: terminal };
    },
    getDispatchAgent: async () => ({
      agent: agent(),
      kind: "found" as const,
      run: claimedRun,
    }),
  };
  const result = await dispatchNextRunnerRun({
    acquireCredential: async () => ({
      kind: "refused" as const,
      reason: "global_daily_cap" as const,
    }),
    credentialInput: () => ({}) as never,
    ensureSandbox: async () => ({ agent: agent(), sandbox: {} as never }),
    limits: admissionLimitsFromEnvironment({}),
    operator,
    randomToken: () => "lease",
    store: store as never,
  });

  assert.deepEqual(result, {
    kind: "refused",
    reason: "capacity",
    runId: claimedRun.id,
  });
  assert.deepEqual(calls, ["finalize", "cleanup"]);
});
