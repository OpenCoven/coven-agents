import assert from "node:assert/strict";
import test from "node:test";
import { runEphemeralDiagnostic } from "./production";
import { dispatchProductionClaim } from "./runtime";
import { RunnerServiceError } from "./service";
import type { RunnerStore } from "./store";
import type {
  RunnerClaimedDispatch,
  RunnerDispatchAuthority,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const operator: RunnerOperator = { kind: "runner-operator" };

function run(authVersion: number | null): RunnerRunRecord {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    authVersion,
    cancellationRequestedAt: null,
    commandEvidence: [],
    completedAt: null,
    createdAt: new Date("2026-08-28T15:00:00.000Z"),
    daytonaAttemptId: null,
    daytonaCommandId: null,
    daytonaLogCursor: 0,
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
    tenant: "u_9c8589018a57479181fe4c455b099bc9",
    version: 1,
  };
}

function claimed(authVersion: number | null): RunnerClaimedDispatch {
  const current = run(authVersion);
  return {
    authority: {
      expectedVersion: current.version,
      leaseToken: current.dispatchLeaseToken as string,
      runId: current.id,
    } as RunnerDispatchAuthority,
    run: current,
  };
}

test("ephemeral diagnostics delete the sandbox after a bounded probe", async () => {
  const calls: string[] = [];

  const result = await runEphemeralDiagnostic({
    create: () => {
      calls.push("create");
      return Promise.resolve({
        delete: () => {
          calls.push("delete");
          return Promise.resolve();
        },
        execute: () => {
          calls.push("execute");
          return Promise.resolve({ exitCode: 0, result: "coven-agents" });
        },
      });
    },
  });

  assert.deepEqual(result, {
    exitCode: 0,
    ok: true,
    output: "coven-agents",
  });
  assert.deepEqual(calls, ["create", "execute", "delete"]);
});

test("ephemeral diagnostics clean up after probe failure and hide provider output", async () => {
  const calls: string[] = [];

  await assert.rejects(
    runEphemeralDiagnostic({
      create: () => {
        calls.push("create");
        return Promise.resolve({
          delete: () => {
            calls.push("delete");
            return Promise.resolve();
          },
          execute: () => {
            calls.push("execute");
            return Promise.reject(new Error("provider=private-detail"));
          },
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunnerServiceError);
      assert.equal(error.code, "diagnostic_unavailable");
      assert.equal(error.message.includes("private-detail"), false);
      return true;
    }
  );

  assert.deepEqual(calls, ["create", "execute", "delete"]);
});

test("ephemeral diagnostics bound malformed provider exit codes and output", async () => {
  const result = await runEphemeralDiagnostic({
    create: () =>
      Promise.resolve({
        delete: () => Promise.resolve(),
        execute: () =>
          Promise.resolve({
            exitCode: Number.POSITIVE_INFINITY,
            result: "provider-private-output",
          }),
      }),
  });

  assert.deepEqual(result, { exitCode: 1, ok: false, output: "" });
});

test("production terminalizes revoked, legacy, and unsubscribed authority before provider or credential work", async () => {
  const cases = [
    {
      accountAuthVersion: 5,
      authVersion: 4,
      subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
    },
    {
      accountAuthVersion: 5,
      authVersion: null,
      subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
    },
    {
      accountAuthVersion: 5,
      authVersion: 5,
      subscribedUntil: new Date("2026-08-28T14:00:00.000Z"),
    },
  ] as const;

  await Promise.all(
    cases.map(async ({ accountAuthVersion, authVersion, subscribedUntil }) => {
      const current = claimed(authVersion);
      let cleanupCalls = 0;
      let dispatchCalls = 0;
      let finalizedError: unknown;

      const result = await dispatchProductionClaim(current, {
        clock: () => new Date("2026-08-28T15:00:30.000Z"),
        dispatch: () => {
          dispatchCalls += 1;
          return Promise.reject(
            new Error("must not acquire credentials or call Daytona")
          );
        },
        environment: {},
        findAccount: () =>
          Promise.resolve({
            authVersion: accountAuthVersion,
            billingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
            subscribedUntil,
          }),
        operator,
        store: {
          cleanupTerminalLease: () => {
            cleanupCalls += 1;
            return Promise.resolve({
              kind: "updated" as const,
              value: run(authVersion),
            });
          },
          finalizeRun: (
            _operator: RunnerOperator,
            input: Parameters<RunnerStore["finalizeRun"]>[1]
          ) => {
            finalizedError = input.error;
            return Promise.resolve({
              kind: "finalized" as const,
              run: run(authVersion),
            });
          },
          releaseUnstartedDispatch: () =>
            Promise.reject(new Error("revoked authority must not be requeued")),
        } as never,
      });

      assert.deepEqual(result, {
        kind: "refused",
        reason: "authority",
        runId: current.run.id,
      });
      assert.deepEqual(finalizedError, {
        code: "authority_revoked",
        message: "Run authority is no longer valid.",
        retryable: false,
      });
      assert.equal(cleanupCalls, 1);
      assert.equal(dispatchCalls, 0);
    })
  );
});

test("production dispatches only a currently subscribed matching authority", async () => {
  const current = claimed(5);
  let dispatchedClaim: RunnerClaimedDispatch | undefined;
  let context: unknown;

  const result = await dispatchProductionClaim(current, {
    dispatch: (actualClaim, value) => {
      dispatchedClaim = actualClaim;
      context = value;
      return Promise.resolve({ kind: "started", runId: current.run.id });
    },
    environment: {
      ABUSE_KEY_SECRET: "production-test-key",
      GLOBAL_DAILY_RUN_CAP: "500",
    },
    findAccount: () =>
      Promise.resolve({
        authVersion: 5,
        billingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
        subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
      }),
    operator,
    store: {} as never,
  });

  assert.deepEqual(result, { kind: "started", runId: current.run.id });
  assert.equal(dispatchedClaim, current);
  assert.equal(dispatchedClaim.authority, current.authority);
  assert.deepEqual(context, {
    globalDailyCap: 500,
    keySecret: "production-test-key",
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
  });
});

test("production releases failed claim setup for durable retry without provider leakage", async () => {
  const current = claimed(5);
  let dispatched = 0;
  let releasedAuthority: RunnerDispatchAuthority | undefined;

  const result = await dispatchProductionClaim(current, {
    dispatch: () => {
      dispatched += 1;
      return Promise.reject(new Error("provider must not run"));
    },
    findAccount: () => Promise.reject(new Error("database=private-detail")),
    operator,
    store: {
      releaseUnstartedDispatch: (
        _operator: RunnerOperator,
        authority: RunnerDispatchAuthority
      ) => {
        releasedAuthority = authority;
        return Promise.resolve({
          kind: "released" as const,
          value: current.run,
        });
      },
    } as never,
  });

  assert.deepEqual(result, {
    kind: "retryable",
    reason: "credential_unavailable",
    runId: current.run.id,
  });
  assert.equal(releasedAuthority, current.authority);
  assert.equal(dispatched, 0);
  assert.equal(JSON.stringify(result).includes("private-detail"), false);
});
