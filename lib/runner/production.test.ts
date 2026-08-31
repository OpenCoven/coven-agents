import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DaytonaAuthenticationError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaTimeoutError,
} from "@daytona/sdk";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { diagnoseDaytonaSandbox, runEphemeralDiagnostic } from "./production";
import {
  createProductionRunnerRuntime,
  dispatchProductionClaim,
} from "./runtime";
import { RunnerServiceError } from "./service";
import type { RunnerStore } from "./store";
import type {
  RunnerClaimedDispatch,
  RunnerDispatchAuthority,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const operator: RunnerOperator = { kind: "runner-operator" };

function fakeDiagnosticDeadline(timeoutMilliseconds = 240_000) {
  let nowMilliseconds = 0;

  return {
    dependencies: {
      cancelTimeout: (handle: unknown) => {
        clearImmediate(handle as NodeJS.Immediate);
      },
      nowMilliseconds: () => nowMilliseconds,
      scheduleTimeout: (callback: () => void, delayMilliseconds: number) => {
        const handle = setImmediate(() => {
          nowMilliseconds += delayMilliseconds;
          callback();
        });
        return handle;
      },
      timeoutMilliseconds,
    },
    nowMilliseconds: () => nowMilliseconds,
  };
}

function run(authVersion: number | null): RunnerRunRecord {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    agentInstructions: "safe instructions",
    agentModel: "auto",
    agentRuntime: "copilot",
    agentWorkspace: null,
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
  const failures: unknown[] = [];

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
      reportFailure: (failure) => {
        failures.push(failure);
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
  assert.deepEqual(failures, [{ category: "unknown", stage: "execute" }]);
  assert.equal(JSON.stringify(failures).includes("private-detail"), false);
});

test("ephemeral diagnostics classify provider authentication failures safely", async () => {
  const failures: unknown[] = [];

  await assert.rejects(
    runEphemeralDiagnostic({
      create: () =>
        Promise.reject(
          new DaytonaAuthenticationError("credential=private-detail", 401)
        ),
      reportFailure: (failure) => {
        failures.push(failure);
      },
    }),
    RunnerServiceError
  );

  assert.deepEqual(failures, [
    { category: "authentication", stage: "create", statusCode: 401 },
  ]);
  assert.equal(JSON.stringify(failures).includes("private-detail"), false);
});

test("ephemeral diagnostics retain only safe provider machine codes", async () => {
  const failures: unknown[] = [];

  await assert.rejects(
    runEphemeralDiagnostic({
      create: () =>
        Promise.reject(
          new DaytonaError(
            "credential=private-detail",
            422,
            undefined,
            "INVALID_SANDBOX_PARAMETERS"
          )
        ),
      reportFailure: (failure) => {
        failures.push(failure);
      },
    }),
    RunnerServiceError
  );

  assert.deepEqual(failures, [
    {
      category: "provider_rejected",
      providerCode: "INVALID_SANDBOX_PARAMETERS",
      stage: "create",
      statusCode: 422,
    },
  ]);
  assert.equal(JSON.stringify(failures).includes("private-detail"), false);
});

test("ephemeral diagnostics omit unsafe provider machine codes", async () => {
  const failures: unknown[] = [];

  await assert.rejects(
    runEphemeralDiagnostic({
      create: () =>
        Promise.reject(
          new DaytonaError(
            "private detail",
            422,
            undefined,
            "INVALID secret=value"
          )
        ),
      reportFailure: (failure) => {
        failures.push(failure);
      },
    }),
    RunnerServiceError
  );

  assert.deepEqual(failures, [
    { category: "provider_rejected", stage: "create", statusCode: 422 },
  ]);
  assert.equal(JSON.stringify(failures).includes("secret"), false);
});

test("ephemeral diagnostics classify status-less transport failures safely", async () => {
  const cases = [
    {
      category: "provider_unavailable",
      error: new DaytonaConnectionError("private connection detail"),
    },
    {
      category: "timeout",
      error: new DaytonaTimeoutError("private timeout detail"),
    },
  ] as const;

  await Promise.all(
    cases.map(async (diagnosticCase) => {
      const failures: unknown[] = [];
      await assert.rejects(
        runEphemeralDiagnostic({
          create: () => Promise.reject(diagnosticCase.error),
          reportFailure: (failure) => {
            failures.push(failure);
          },
        }),
        RunnerServiceError
      );
      assert.deepEqual(failures, [
        { category: diagnosticCase.category, stage: "create" },
      ]);
      assert.equal(JSON.stringify(failures).includes("private"), false);
    })
  );
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

test("ephemeral diagnostics return retryable failure when provider deletion fails", async () => {
  const calls: string[] = [];
  const failures: unknown[] = [];

  await assert.rejects(
    runEphemeralDiagnostic({
      create: () =>
        Promise.resolve({
          delete: () => {
            calls.push("delete");
            return Promise.reject(
              new Error("sandbox-id=private provider-delete-detail")
            );
          },
          execute: () => {
            calls.push("execute");
            return Promise.resolve({ exitCode: 0, result: "coven-agents" });
          },
        }),
      reportFailure: (failure) => {
        failures.push(failure);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunnerServiceError);
      assert.equal(error.code, "diagnostic_unavailable");
      assert.equal(error.retryable, true);
      assert.equal(error.message.includes("private"), false);
      assert.equal(error.message.includes("sandbox-id"), false);
      return true;
    }
  );

  assert.deepEqual(calls, ["execute", "delete"]);
  assert.deepEqual(failures, [{ category: "unknown", stage: "delete" }]);
});

test("Daytona diagnostics use the exact precomputed name and bounded operations", async () => {
  let createParameters: Record<string, unknown> | undefined;
  let createOptions: Record<string, unknown> | undefined;
  let executeArguments: unknown[] | undefined;
  let deleteArguments: unknown[] | undefined;

  const result = await diagnoseDaytonaSandbox("coven-diagnostic-precomputed", {
    client: () => ({
      create: (parameters, options) => {
        createParameters = parameters;
        createOptions = options;
        return Promise.resolve({
          delete: (...args: unknown[]) => {
            deleteArguments = args;
            return Promise.resolve();
          },
          process: {
            executeCommand: (...args: unknown[]) => {
              executeArguments = args;
              return Promise.resolve({
                exitCode: 0,
                result: "coven-agents",
              });
            },
          },
        });
      },
    }),
    configuration: () => ({ snapshotName: "diagnostic-snapshot" }),
  });

  assert.deepEqual(result, {
    exitCode: 0,
    ok: true,
    output: "coven-agents",
  });
  assert.deepEqual(createParameters, {
    ephemeral: true,
    name: "coven-diagnostic-precomputed",
    public: false,
    snapshot: "diagnostic-snapshot",
    ttlMinutes: 5,
  });
  assert.deepEqual(createOptions, { timeout: 60 });
  assert.deepEqual(executeArguments, [
    "printf coven-agents",
    undefined,
    undefined,
    30,
  ]);
  assert.deepEqual(deleteArguments, [60, true]);
});

test("Daytona diagnostics have no provider-internal random name fallback", () => {
  const source = readFileSync(
    new URL("./diagnostics.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /randomUUID|createName/u);
});

test("Daytona diagnostics bound create when the adapter ignores its timeout", async () => {
  const deadline = fakeDiagnosticDeadline(45_000);
  let createParameters: Record<string, unknown> | undefined;
  let createOptions: Record<string, unknown> | undefined;
  let rejectCreate: ((reason: unknown) => void) | undefined;

  await assert.rejects(
    diagnoseDaytonaSandbox("coven-diagnostic-create-timeout", {
      client: () => ({
        create: (parameters, options) => {
          createParameters = parameters;
          createOptions = options;
          return new Promise((_resolve, reject) => {
            rejectCreate = reject;
          });
        },
      }),
      configuration: () => ({ snapshotName: "diagnostic-snapshot" }),
      deadline: deadline.dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunnerServiceError);
      assert.equal(error.code, "diagnostic_unavailable");
      assert.equal(error.retryable, true);
      assert.equal(error.message, "Daytona diagnostic is unavailable.");
      assert.equal(error.cause, undefined);
      return true;
    }
  );

  assert.equal(deadline.nowMilliseconds(), 45_000);
  assert.deepEqual(createOptions, { timeout: 45 });
  assert.deepEqual(createParameters, {
    ephemeral: true,
    name: "coven-diagnostic-create-timeout",
    public: false,
    snapshot: "diagnostic-snapshot",
    ttlMinutes: 5,
  });

  const unhandledRejections: unknown[] = [];
  const recordUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", recordUnhandledRejection);
  try {
    assert.ok(rejectCreate);
    rejectCreate(new Error("provider-secret-late-rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", recordUnhandledRejection);
  }
});

test("Daytona diagnostics delete a sandbox whose create resolves after the deadline", async () => {
  const deadline = fakeDiagnosticDeadline(45_000);
  let deleteCalls = 0;
  let deleteArguments: unknown[] | undefined;
  let resolveCreate:
    | ((sandbox: {
        delete: (timeout?: number, wait?: boolean) => Promise<void>;
        process: {
          executeCommand: () => Promise<{ exitCode: number; result: string }>;
        };
      }) => void)
    | undefined;

  await assert.rejects(
    diagnoseDaytonaSandbox("coven-diagnostic-late-create", {
      client: () => ({
        create: () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      }),
      configuration: () => ({ snapshotName: "diagnostic-snapshot" }),
      deadline: deadline.dependencies,
    }),
    RunnerServiceError
  );

  assert.ok(resolveCreate);
  resolveCreate({
    delete: (...args: unknown[]) => {
      deleteCalls += 1;
      deleteArguments = args;
      return Promise.resolve();
    },
    process: {
      executeCommand: () =>
        Promise.resolve({ exitCode: 0, result: "coven-agents" }),
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(deleteCalls, 1);
  assert.deepEqual(deleteArguments, [60, true]);
});

test("Daytona diagnostics observe and swallow a late cleanup rejection", async () => {
  const deadline = fakeDiagnosticDeadline(45_000);
  let deleteCalls = 0;
  let resolveCreate:
    | ((sandbox: {
        delete: (timeout?: number, wait?: boolean) => Promise<void>;
        process: {
          executeCommand: () => Promise<{ exitCode: number; result: string }>;
        };
      }) => void)
    | undefined;
  const unhandledRejections: unknown[] = [];
  const recordUnhandledRejection = (reason: unknown) => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", recordUnhandledRejection);

  try {
    await assert.rejects(
      diagnoseDaytonaSandbox("coven-diagnostic-late-delete-rejection", {
        client: () => ({
          create: () =>
            new Promise((resolve) => {
              resolveCreate = resolve;
            }),
        }),
        configuration: () => ({ snapshotName: "diagnostic-snapshot" }),
        deadline: deadline.dependencies,
      }),
      RunnerServiceError
    );

    assert.ok(resolveCreate);
    resolveCreate({
      delete: () => {
        deleteCalls += 1;
        return Promise.reject(new Error("provider-secret-late-delete"));
      },
      process: {
        executeCommand: () =>
          Promise.resolve({ exitCode: 0, result: "coven-agents" }),
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.equal(deleteCalls, 1);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", recordUnhandledRejection);
  }
});

test("Daytona diagnostics bound late cleanup when delete ignores its timeout", async () => {
  const deadline = fakeDiagnosticDeadline(45_000);
  let deleteArguments: unknown[] | undefined;
  let resolveCreate:
    | ((sandbox: {
        delete: (timeout?: number, wait?: boolean) => Promise<void>;
        process: {
          executeCommand: () => Promise<{ exitCode: number; result: string }>;
        };
      }) => void)
    | undefined;

  await assert.rejects(
    diagnoseDaytonaSandbox("coven-diagnostic-late-delete-timeout", {
      client: () => ({
        create: () =>
          new Promise((resolve) => {
            resolveCreate = resolve;
          }),
      }),
      configuration: () => ({ snapshotName: "diagnostic-snapshot" }),
      deadline: deadline.dependencies,
    }),
    RunnerServiceError
  );

  assert.ok(resolveCreate);
  resolveCreate({
    delete: (...args: unknown[]) => {
      deleteArguments = args;
      return new Promise(() => undefined);
    },
    process: {
      executeCommand: () =>
        Promise.resolve({ exitCode: 0, result: "coven-agents" }),
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(deleteArguments, [60, true]);
  assert.equal(deadline.nowMilliseconds(), 105_000);
});

test("Daytona diagnostics bound a command that ignores its timeout and clean up", async () => {
  const deadline = fakeDiagnosticDeadline();
  let executeArguments: unknown[] | undefined;
  let deleteArguments: unknown[] | undefined;

  await assert.rejects(
    diagnoseDaytonaSandbox("coven-diagnostic-command-timeout", {
      client: () => ({
        create: () =>
          Promise.resolve({
            delete: (...args: unknown[]) => {
              deleteArguments = args;
              return Promise.resolve();
            },
            process: {
              executeCommand: (...args: unknown[]) => {
                executeArguments = args;
                return new Promise(() => undefined);
              },
            },
          }),
      }),
      configuration: () => ({ snapshotName: "diagnostic-snapshot" }),
      deadline: deadline.dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunnerServiceError);
      assert.equal(error.code, "diagnostic_unavailable");
      assert.equal(error.retryable, true);
      assert.equal(error.message, "Daytona diagnostic is unavailable.");
      assert.equal(error.cause, undefined);
      return true;
    }
  );

  assert.equal(deadline.nowMilliseconds(), 30_000);
  assert.deepEqual(executeArguments, [
    "printf coven-agents",
    undefined,
    undefined,
    30,
  ]);
  assert.deepEqual(deleteArguments, [60, true]);
});

test("Daytona diagnostics bound delete when the adapter ignores its timeout", async () => {
  const deadline = fakeDiagnosticDeadline();
  let deleteArguments: unknown[] | undefined;

  await assert.rejects(
    diagnoseDaytonaSandbox("coven-diagnostic-delete-timeout", {
      client: () => ({
        create: () =>
          Promise.resolve({
            delete: (...args: unknown[]) => {
              deleteArguments = args;
              return new Promise(() => undefined);
            },
            process: {
              executeCommand: () =>
                Promise.resolve({
                  exitCode: 0,
                  result: "coven-agents",
                }),
            },
          }),
      }),
      configuration: () => ({ snapshotName: "diagnostic-snapshot" }),
      deadline: deadline.dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunnerServiceError);
      assert.equal(error.code, "diagnostic_unavailable");
      assert.equal(error.retryable, true);
      assert.equal(error.message, "Daytona diagnostic cleanup is unavailable.");
      assert.equal(error.cause, undefined);
      return true;
    }
  );

  assert.equal(deadline.nowMilliseconds(), 60_000);
  assert.deepEqual(deleteArguments, [60, true]);
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

test("production reconciliation skips a live lease before provider or scan work", async () => {
  let databaseCalls = 0;
  const runtime = createProductionRunnerRuntime({
    databaseFor: () =>
      ({
        transaction: async (
          callback: (transaction: {
            execute: () => Promise<Record<string, unknown>[]>;
          }) => Promise<unknown>
        ) =>
          callback({
            execute: () => {
              databaseCalls += 1;
              return Promise.resolve([]);
            },
          }),
      }) as never,
  });
  const service = await runtime.createOperatorService();

  const result = await service.reconcileAndDispatch();

  assert.deepEqual(result, {
    adopted: 0,
    deferred: 0,
    dispatched: 0,
    execution: "skipped",
    expiredScanned: 0,
    failures: 0,
    logEvents: 0,
    reason: "overlap",
    requeued: 0,
    sandboxRecovered: 0,
    terminalCleaned: 0,
    terminalized: 0,
    terminalLeaseCleaned: 0,
  });
  assert.equal(databaseCalls, 1);
});

test("production reconciliation sanitizes lease database failures", async () => {
  const secret = "database=private-detail";
  const failures: unknown[] = [];
  const databaseError = Object.assign(new Error(secret), {
    code: "42P01",
    name: "PostgresError",
  });
  const queryError = new DrizzleQueryError(
    `SELECT '${secret}'`,
    [secret],
    databaseError
  );
  const runtime = createProductionRunnerRuntime({
    databaseFor: () =>
      ({
        transaction: () => Promise.reject(queryError),
      }) as never,
    reportReconciliationFailure: (failure) => {
      failures.push(failure);
    },
  });
  const service = await runtime.createOperatorService();

  await assert.rejects(service.reconcileAndDispatch(), (error: unknown) => {
    assert.ok(error instanceof RunnerServiceError);
    assert.equal(error.code, "reconcile_unavailable");
    assert.equal(error.retryable, true);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes("private-detail"), false);
    return true;
  });
  assert.deepEqual(failures, [
    {
      category: "unknown",
      code: "42P01",
      name: "PostgresError",
      stage: "lease",
    },
  ]);
  assert.equal(JSON.stringify(failures).includes("private-detail"), false);
});
