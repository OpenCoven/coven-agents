import "server-only";

import { randomBytes } from "node:crypto";
import type { Sandbox } from "@daytona/sdk";
import {
  AGENT_RUNNER_LIMITS,
  type CommandEvidence,
  type FileEvidence,
  type RunError,
  type RunEvent,
} from "@opencoven/agent-contracts";
import {
  consumeRunnerCredentialReservation,
  releaseRunnerCredentialResources,
} from "@/lib/credentials/runner-credential";
import {
  type DaytonaRunnerDispatchDependencies,
  daytonaRunnerDispatchDependencies,
  dispatchNextRunnerRun,
} from "./admission";
import { daytonaSandboxName } from "./daytona/names";
import {
  type DaytonaLogSnapshot,
  type DaytonaProcessSandbox,
  snapshotDaytonaProcess,
  stopDaytonaProcess,
} from "./daytona/process";
import {
  classifyDaytonaProviderError,
  type DaytonaSandboxLifecycleDependencies,
  type DaytonaSandboxService,
  resetDaytonaSandboxForCancellation,
  SANDBOX_PROVISIONING_TIMEOUT_MS,
} from "./daytona/sandbox";
import {
  projectHarnessRunEvent,
  sanitizeRunText,
  truncateUtf8,
} from "./evidence";
import type { RunnerStore } from "./store";
import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_DISPATCH_LIMIT = 1;
const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DISPATCH_LEASE_MS = 60_000;

type ReconciliationStore = Pick<
  RunnerStore,
  | "requestRunCancellation"
  | "claimExpiredDaytonaAttemptCleanup"
  | "adoptExpiredDaytonaProcess"
  | "advanceDaytonaLogCursor"
  | "appendDispatchEvent"
  | "cleanupTerminalLease"
  | "finalizeRun"
  | "markDispatchRunningForDispatch"
  | "requeueAfterDaytonaAttemptCleanup"
  | "requeueExpiredDispatch"
  | "releaseTerminalDaytonaAttempt"
  | "scanExpiredDispatchLeases"
> &
  Partial<
    Pick<
      RunnerStore,
      | "appendCancellationDiagnostic"
      | "claimTerminalDaytonaAttemptCleanup"
      | "scanTerminalDaytonaAttemptCleanups"
    >
  >;

export type RunnerReconciliationProvider = Readonly<{
  /**
   * `null` means Daytona confirmed that the persistent sandbox is absent.
   * Throwing means its existence is ambiguous and must be retried.
   */
  resolveSandbox: (
    run: RunnerRunRecord,
    authority: RunnerDispatchAuthority
  ) => Promise<DaytonaProcessSandbox | null>;
  stop: (
    sandbox: DaytonaProcessSandbox,
    input: Readonly<{
      attemptId: NonNullable<RunnerRunRecord["daytonaAttemptId"]>;
      runId: string;
    }>
  ) => Promise<Readonly<{ kind: "sandbox_reset_required" | "stopped" }>>;
  snapshot?: (
    input: Parameters<typeof snapshotDaytonaProcess>[0]
  ) => Promise<DaytonaLogSnapshot>;
  /**
   * A caller may wire this to the fenced sandbox lifecycle when session
   * deletion cannot be confirmed. `true` confirms process/file removal.
   */
  resetSandbox?: (
    run: RunnerRunRecord,
    authority: RunnerDispatchAuthority
  ) => Promise<boolean>;
}>;

export type DaytonaReconciliationProviderDependencies = Readonly<{
  daytona: DaytonaSandboxService;
  resetSandbox?: (
    run: RunnerRunRecord,
    authority: RunnerDispatchAuthority
  ) => Promise<boolean>;
}>;

export function daytonaCancellationResetter(input: {
  daytona: DaytonaSandboxService;
  lifecycle?: DaytonaSandboxLifecycleDependencies;
  operator: RunnerOperator;
  store: RunnerStore;
}): NonNullable<RunnerReconciliationProvider["resetSandbox"]> {
  return async (_run, authority) =>
    await resetDaytonaSandboxForCancellation(input.operator, authority, {
      daytona: input.daytona,
      lifecycle: input.lifecycle,
      store: input.store,
    });
}

/**
 * Concrete Daytona adapter. Not-found is the only confirmed-absence result;
 * every transport or unknown provider failure remains an ambiguous retry.
 */
export function daytonaReconciliationProvider(
  dependencies: DaytonaReconciliationProviderDependencies
): RunnerReconciliationProvider {
  return {
    resetSandbox: dependencies.resetSandbox,
    resolveSandbox: async (run) => {
      try {
        return (await dependencies.daytona.get(
          daytonaSandboxName(run.tenant, run.agentId)
        )) as unknown as DaytonaProcessSandbox;
      } catch (error) {
        if (classifyDaytonaProviderError(error) === "not_found") {
          return null;
        }
        throw error;
      }
    },
    snapshot: snapshotDaytonaProcess,
    stop: async (sandbox, input) => {
      const stopped = await stopDaytonaProcess(sandbox, input);
      return { kind: stopped.kind };
    },
  };
}

type SandboxRecoveryStore = Pick<
  RunnerStore,
  | "attachDaytonaSandboxForRecovery"
  | "deleteDecommissionedAgentForRecovery"
  | "finishDaytonaSandboxResetForRecovery"
  | "resetDaytonaSandboxRecovery"
  | "scanDaytonaSandboxRecoveries"
>;

export type ReconcileDaytonaSandboxesDependencies = Readonly<{
  batchSize?: number;
  clock?: () => Date;
  daytona: DaytonaSandboxService;
  operator: RunnerOperator;
  providerConcurrency?: number;
  provisioningStaleBefore?: Date;
  store: SandboxRecoveryStore;
}>;

export type DaytonaSandboxReconciliationResult = Readonly<{
  deferred: number;
  failures: number;
  recovered: number;
}>;

export type RunnerReconciliationResult = Readonly<{
  adopted: number;
  deferred: number;
  dispatched: number;
  expiredScanned: number;
  failures: number;
  logEvents: number;
  requeued: number;
  sandboxRecovered: number;
  terminalCleaned: number;
  terminalized: number;
}>;

export type ReconcileAndDispatchDependencies = Readonly<{
  batchSize?: number;
  clock?: () => Date;
  dispatch?: () => Promise<Readonly<{ kind: string }>>;
  dispatchLimit?: number;
  operator: RunnerOperator;
  provider: RunnerReconciliationProvider;
  providerConcurrency?: number;
  randomToken?: () => string;
  consumeCredentialReservation?: (run: RunnerRunRecord) => Promise<void>;
  releaseCredentialResources?: (run: RunnerRunRecord) => Promise<void>;
  sandboxRecovery?: Omit<
    ReconcileDaytonaSandboxesDependencies,
    "clock" | "operator"
  >;
  store: ReconciliationStore;
}>;

export type DaytonaRunnerReconciliationDependencies = Omit<
  DaytonaRunnerDispatchDependencies,
  "acquireCredential" | "ensureSandbox" | "sandboxDependencies"
> &
  Readonly<{
    batchSize?: number;
    daytona: DaytonaSandboxService;
    lifecycle?: DaytonaSandboxLifecycleDependencies;
    providerConcurrency?: number;
  }>;

/**
 * Composes the concrete Daytona, credential, sandbox, and runner-store
 * boundaries without introducing an HTTP dependency. Routes and cron can pass
 * the resulting object directly to `reconcileAndDispatch`.
 */
export function daytonaRunnerReconciliationDependencies(
  dependencies: DaytonaRunnerReconciliationDependencies
): ReconcileAndDispatchDependencies {
  const dispatch = daytonaRunnerDispatchDependencies({
    ...dependencies,
    credentialDependencies: dependencies.credentialDependencies,
    sandboxDependencies: {
      daytona: dependencies.daytona,
      lifecycle: dependencies.lifecycle,
    },
  });
  return {
    batchSize: dependencies.batchSize,
    clock: dependencies.clock,
    consumeCredentialReservation: (run) =>
      consumeRunnerCredentialReservation(
        { runId: run.id, tenant: run.tenant },
        dependencies.credentialDependencies
      ),
    dispatch: () => dispatchNextRunnerRun(dispatch),
    operator: dependencies.operator,
    provider: daytonaReconciliationProvider({
      daytona: dependencies.daytona,
      resetSandbox: daytonaCancellationResetter({
        daytona: dependencies.daytona,
        lifecycle: dependencies.lifecycle,
        operator: dependencies.operator,
        store: dependencies.store,
      }),
    }),
    providerConcurrency: dependencies.providerConcurrency,
    randomToken: dependencies.randomToken,
    releaseCredentialResources: (run) =>
      releaseRunnerCredentialResources(
        run.id,
        dependencies.credentialDependencies
      ),
    sandboxRecovery: {
      batchSize: dependencies.batchSize,
      daytona: dependencies.daytona,
      providerConcurrency: dependencies.providerConcurrency,
      store: dependencies.store,
    },
    store: dependencies.store,
  };
}

type CancellationFinalizationStore = Pick<
  RunnerStore,
  "cleanupTerminalLease" | "finalizeRun" | "releaseTerminalDaytonaAttempt"
>;

type CancellationStore = CancellationFinalizationStore &
  Pick<RunnerStore, "appendCancellationDiagnostic" | "requestRunCancellation">;

export type CancelRunnerRunDependencies = Readonly<{
  clock?: () => Date;
  operator: RunnerOperator;
  provider: RunnerReconciliationProvider;
  randomToken?: () => string;
  releaseCredentialResources?: (run: RunnerRunRecord) => Promise<void>;
  store: CancellationStore;
}>;

export type CancelRunnerRunResult =
  | { kind: "already_terminal" | "in_progress" | "not_found"; runId: string }
  | { kind: "cancelled"; runId: string }
  | { kind: "cleanup_required" | "sandbox_reset_required"; runId: string };

export type DaytonaRunnerCancellationDependencies = Readonly<{
  clock?: () => Date;
  credentialDependencies: DaytonaRunnerDispatchDependencies["credentialDependencies"];
  daytona: DaytonaSandboxService;
  lifecycle?: DaytonaSandboxLifecycleDependencies;
  operator: RunnerOperator;
  randomToken?: () => string;
  store: RunnerStore;
}>;

/** Concrete cancellation composition with credential cleanup and reset fencing. */
export function daytonaRunnerCancellationDependencies(
  dependencies: DaytonaRunnerCancellationDependencies
): CancelRunnerRunDependencies {
  return {
    clock: dependencies.clock,
    operator: dependencies.operator,
    provider: daytonaReconciliationProvider({
      daytona: dependencies.daytona,
      resetSandbox: daytonaCancellationResetter({
        daytona: dependencies.daytona,
        lifecycle: dependencies.lifecycle,
        operator: dependencies.operator,
        store: dependencies.store,
      }),
    }),
    randomToken: dependencies.randomToken,
    releaseCredentialResources: (run) =>
      releaseRunnerCredentialResources(
        run.id,
        dependencies.credentialDependencies
      ),
    store: dependencies.store,
  };
}

type RecoveryResult = Readonly<{
  adopted?: boolean;
  kind: "deferred" | "failed" | "requeued" | "terminalized";
  logEvents?: number;
}>;

type TerminalCleanupResult = "cleaned" | "deferred" | "failed";

function boundedInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum = 100
): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return selected;
}

function nextLease(
  clock: () => Date,
  randomToken: () => string
): Readonly<{ leaseExpiresAt: Date; leaseToken: string }> {
  const now = clock();
  const leaseToken = randomToken();
  if (
    Number.isNaN(now.valueOf()) ||
    !leaseToken ||
    leaseToken.length > 80 ||
    /\p{Cc}/u.test(leaseToken)
  ) {
    throw new Error("Reconciliation lease dependencies are invalid.");
  }
  return {
    leaseExpiresAt: new Date(now.getTime() + DISPATCH_LEASE_MS),
    leaseToken,
  };
}

function secureToken(): string {
  return randomBytes(32).toString("base64url");
}

async function mapBounded<T, Result>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: Each bounded worker serializes its assigned provider operation.
      results[index] = await operation(values[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

async function releaseCredentialResources(
  run: RunnerRunRecord,
  dependencies: Pick<
    ReconcileAndDispatchDependencies | CancelRunnerRunDependencies,
    "releaseCredentialResources"
  >
): Promise<boolean> {
  if (!dependencies.releaseCredentialResources) {
    return true;
  }
  try {
    await dependencies.releaseCredentialResources(run);
    return true;
  } catch {
    return false;
  }
}

type SandboxRecoveryOutcome = "deferred" | "failed" | "recovered";

function classifySandboxRecoveryFailure(
  error: unknown
): SandboxRecoveryOutcome {
  return classifyDaytonaProviderError(error) === "non_retryable"
    ? "failed"
    : "deferred";
}

async function findSandboxForRecovery(
  agent: RunnerAgentRecord,
  daytona: DaytonaSandboxService
): Promise<Sandbox | null> {
  const identifiers = [
    ...(agent.daytonaSandboxId ? [agent.daytonaSandboxId] : []),
    daytonaSandboxName(agent.tenant, agent.id),
  ];
  for (const identifier of new Set(identifiers)) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Deterministic IDs are checked in priority order.
      return await daytona.get(identifier);
    } catch (error) {
      if (classifyDaytonaProviderError(error) !== "not_found") {
        throw error;
      }
    }
  }
  return null;
}

async function recoverSandbox(
  agent: RunnerAgentRecord,
  dependencies: ReconcileDaytonaSandboxesDependencies,
  provisioningStaleBefore: Date
): Promise<SandboxRecoveryOutcome> {
  const fence = {
    agentId: agent.id,
    expectedGeneration: agent.sandboxGeneration,
    expectedVersion: agent.version,
  };
  if (
    agent.sandboxLifecycle === "provisioning" &&
    agent.sandboxUpdatedAt > provisioningStaleBefore
  ) {
    return "deferred";
  }
  if (
    agent.sandboxLifecycle === "provisioning" ||
    agent.sandboxLifecycle === "provisioning_ambiguous"
  ) {
    let sandbox: Sandbox | null;
    try {
      sandbox = await findSandboxForRecovery(agent, dependencies.daytona);
    } catch (error) {
      return classifySandboxRecoveryFailure(error);
    }
    const persisted = sandbox
      ? await dependencies.store.attachDaytonaSandboxForRecovery(
          dependencies.operator,
          { ...fence, sandboxId: sandbox.id }
        )
      : await dependencies.store.resetDaytonaSandboxRecovery(
          dependencies.operator,
          fence
        );
    return persisted.kind === "updated" ? "recovered" : "deferred";
  }
  if (agent.sandboxLifecycle === "resetting") {
    let sandbox: Sandbox | null;
    try {
      sandbox = await findSandboxForRecovery(agent, dependencies.daytona);
    } catch (error) {
      return classifySandboxRecoveryFailure(error);
    }
    if (sandbox) {
      try {
        await sandbox.delete(60, true);
      } catch (error) {
        if (classifyDaytonaProviderError(error) !== "not_found") {
          return classifySandboxRecoveryFailure(error);
        }
      }
    }
    const reset = await dependencies.store.finishDaytonaSandboxResetForRecovery(
      dependencies.operator,
      fence
    );
    return reset.kind === "updated" ? "recovered" : "deferred";
  }
  if (agent.sandboxLifecycle !== "decommissioning") {
    return "deferred";
  }
  let sandbox: Sandbox | null;
  try {
    sandbox = await findSandboxForRecovery(agent, dependencies.daytona);
  } catch (error) {
    return classifySandboxRecoveryFailure(error);
  }
  if (sandbox) {
    try {
      await sandbox.delete(60, true);
    } catch (error) {
      if (classifyDaytonaProviderError(error) !== "not_found") {
        return classifySandboxRecoveryFailure(error);
      }
    }
  }
  const deleted = await dependencies.store.deleteDecommissionedAgentForRecovery(
    dependencies.operator,
    fence
  );
  return deleted.kind === "deleted" ? "recovered" : "deferred";
}

/**
 * Reconciles stale/ambiguous persistent sandbox lifecycle rows without
 * creating resources speculatively. All persistence is version/generation
 * fenced, so another lifecycle actor can safely win a race.
 */
export async function reconcileDaytonaSandboxes(
  dependencies: ReconcileDaytonaSandboxesDependencies
): Promise<DaytonaSandboxReconciliationResult> {
  const batchSize = boundedInteger(
    dependencies.batchSize,
    DEFAULT_BATCH_SIZE,
    "Sandbox reconciliation batch size"
  );
  const providerConcurrency = boundedInteger(
    dependencies.providerConcurrency,
    DEFAULT_PROVIDER_CONCURRENCY,
    "Sandbox provider concurrency",
    16
  );
  const clock = dependencies.clock ?? (() => new Date());
  const provisioningStaleBefore =
    dependencies.provisioningStaleBefore ??
    new Date(clock().getTime() - SANDBOX_PROVISIONING_TIMEOUT_MS);
  let agents: RunnerAgentRecord[];
  try {
    agents = await dependencies.store.scanDaytonaSandboxRecoveries(
      dependencies.operator,
      batchSize
    );
  } catch {
    return { deferred: 0, failures: 1, recovered: 0 };
  }
  const outcomes = await mapBounded(
    agents,
    providerConcurrency,
    async (agent) => {
      try {
        return await recoverSandbox(
          agent,
          dependencies,
          provisioningStaleBefore
        );
      } catch {
        return "failed" as const;
      }
    }
  );
  return outcomes.reduce<DaytonaSandboxReconciliationResult>(
    (result, outcome) => ({
      deferred: result.deferred + (outcome === "deferred" ? 1 : 0),
      failures: result.failures + (outcome === "failed" ? 1 : 0),
      recovered: result.recovered + (outcome === "recovered" ? 1 : 0),
    }),
    { deferred: 0, failures: 0, recovered: 0 }
  );
}

function terminalEvidence(snapshot: DaytonaLogSnapshot): Readonly<{
  commandEvidence: CommandEvidence[];
  error: RunError | null;
  fileEvidence: FileEvidence[];
  output: string;
}> {
  return {
    commandEvidence: snapshot.summary.toolCalls
      .slice(0, AGENT_RUNNER_LIMITS.maxCommandResults)
      .map((call) => ({
        command: call.tool,
        exitCode: call.success ? 0 : 1,
        stderr: "",
        stdout: call.summary,
      })),
    error:
      snapshot.status === "failed"
        ? {
            code: "process_failed",
            message: "The runner process exited unsuccessfully.",
            retryable: false,
          }
        : null,
    fileEvidence: snapshot.summary.fileOperations
      .slice(0, AGENT_RUNNER_LIMITS.maxFileOperations)
      .map((file) => ({ operation: file.operation, path: file.path }))
      .filter(
        (file): file is FileEvidence =>
          file.operation === "create" ||
          file.operation === "modify" ||
          file.operation === "delete"
      ),
    output: truncateUtf8(
      sanitizeRunText(snapshot.summary.output, null),
      AGENT_RUNNER_LIMITS.maxEventOutputLength,
      AGENT_RUNNER_LIMITS.maxEventOutputLength
    ),
  };
}

function withoutEventId(event: RunEvent): Omit<RunEvent, "id"> {
  const { id: _id, ...withoutId } = event;
  return withoutId;
}

async function finalizeRecoveredCancellation(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority,
  dependencies: ReconcileAndDispatchDependencies,
  clock: () => Date
): Promise<RecoveryResult> {
  const finalized = await finalizeCancellation(
    run,
    authority,
    { operator: dependencies.operator, store: dependencies.store },
    clock
  );
  return {
    adopted: true,
    kind: finalized.kind === "cancelled" ? "terminalized" : "deferred",
  };
}

async function reconcileAttachedProcess(
  run: RunnerRunRecord,
  dependencies: ReconcileAndDispatchDependencies,
  lease: Readonly<{ leaseExpiresAt: Date; leaseToken: string }>,
  clock: () => Date
): Promise<RecoveryResult> {
  if (
    !run.daytonaAttemptId ||
    !run.daytonaCommandId ||
    !run.dispatchLeaseToken ||
    (run.dispatchState !== "dispatching" && run.dispatchState !== "running")
  ) {
    return { kind: "deferred" };
  }
  const adopted = await dependencies.store.adoptExpiredDaytonaProcess(
    dependencies.operator,
    {
      attemptId: run.daytonaAttemptId,
      expectedDispatchState: run.dispatchState,
      leaseExpiresAt: lease.leaseExpiresAt,
      newLeaseToken: lease.leaseToken,
      oldLeaseToken: run.dispatchLeaseToken,
      runId: run.id,
    }
  );
  if (adopted.kind !== "adopted") {
    return { kind: "deferred" };
  }

  const sandbox = await dependencies.provider.resolveSandbox(
    adopted.run,
    adopted.authority
  );
  if (adopted.run.cancellationRequestedAt) {
    if (sandbox) {
      const stopped = await dependencies.provider.stop(sandbox, {
        attemptId: run.daytonaAttemptId,
        runId: run.id,
      });
      if (stopped.kind !== "stopped") {
        let reset = false;
        try {
          reset = Boolean(
            await dependencies.provider.resetSandbox?.(
              adopted.run,
              adopted.authority
            )
          );
        } catch {
          reset = false;
        }
        if (!reset) {
          try {
            await dependencies.store.appendCancellationDiagnostic?.(
              dependencies.operator,
              adopted.authority
            );
          } catch {
            // The cancellation intent remains a durable retry record.
          }
          return { adopted: true, kind: "deferred" };
        }
      }
    }
    if (!(await releaseCredentialResources(adopted.run, dependencies))) {
      return { adopted: true, kind: "deferred" };
    }
    return await finalizeRecoveredCancellation(
      adopted.run,
      adopted.authority,
      dependencies,
      clock
    );
  }
  if (!sandbox) {
    if (!(await releaseCredentialResources(adopted.run, dependencies))) {
      return { adopted: true, kind: "deferred" };
    }
    const requeued = await dependencies.store.requeueAfterDaytonaAttemptCleanup(
      dependencies.operator,
      adopted.authority
    );
    return {
      adopted: true,
      kind: requeued.kind === "requeued" ? "requeued" : "deferred",
    };
  }

  if (dependencies.consumeCredentialReservation) {
    try {
      await dependencies.consumeCredentialReservation(adopted.run);
    } catch {
      return { adopted: true, kind: "deferred" };
    }
  }

  const { authority: adoptedAuthority, run: adoptedRun } = adopted;
  let authority = adoptedAuthority;
  let liveRun = adoptedRun;
  if (liveRun.dispatchState === "dispatching") {
    const marked = await dependencies.store.markDispatchRunningForDispatch(
      dependencies.operator,
      authority
    );
    if (marked.kind !== "updated") {
      return { adopted: true, kind: "deferred" };
    }
    const { authority: markedAuthority, value: markedRun } = marked;
    authority = markedAuthority;
    liveRun = markedRun;
  }

  const snapshot = await (
    dependencies.provider.snapshot ?? snapshotDaytonaProcess
  )({
    attemptId: run.daytonaAttemptId,
    commandId: run.daytonaCommandId,
    credential: null,
    cursor: liveRun.daytonaLogCursor,
    harness: "copilot",
    runId: run.id,
    sandbox,
  });
  const toolNames = new Map<string, string>();
  const projected = snapshot.events
    .map((event) => projectHarnessRunEvent(event, 0, null, toolNames))
    .filter((event): event is RunEvent => event !== null);
  for (const [index, event] of projected.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: Event writes advance a version fence in strict cursor order.
    const appended = await dependencies.store.appendDispatchEvent(
      dependencies.operator,
      authority,
      {
        ...(index === projected.length - 1
          ? { daytonaLogCursor: snapshot.cursor }
          : {}),
        event: withoutEventId(event) as never,
      }
    );
    if (appended.kind !== "appended") {
      return {
        adopted: true,
        kind: "deferred",
        logEvents: index,
      };
    }
    const { authority: appendedAuthority } = appended;
    authority = appendedAuthority;
  }
  if (projected.length === 0 && snapshot.cursor > liveRun.daytonaLogCursor) {
    const advanced = await dependencies.store.advanceDaytonaLogCursor(
      dependencies.operator,
      authority,
      snapshot.cursor
    );
    if (advanced.kind !== "updated") {
      return { adopted: true, kind: "deferred" };
    }
    const { authority: advancedAuthority } = advanced;
    authority = advancedAuthority;
  }

  if (snapshot.status === "running" || !snapshot.logsSettled) {
    return {
      adopted: true,
      kind: "deferred",
      logEvents: projected.length,
    };
  }
  const evidence = terminalEvidence(snapshot);
  const finalized = await dependencies.store.finalizeRun(
    dependencies.operator,
    {
      commandEvidence: evidence.commandEvidence,
      completedAt: clock(),
      error: evidence.error,
      expectedVersion: authority.expectedVersion,
      fileEvidence: evidence.fileEvidence,
      leaseToken: authority.leaseToken,
      output: evidence.output,
      runId: run.id,
      status: snapshot.status,
    }
  );
  if (finalized.kind !== "finalized") {
    return {
      adopted: true,
      kind: "deferred",
      logEvents: projected.length,
    };
  }
  const terminalAuthority = {
    attemptId: run.daytonaAttemptId,
    expectedVersion: finalized.run.version,
    leaseToken: authority.leaseToken,
    runId: run.id,
  } as RunnerDispatchAuthority;
  const stopped = await dependencies.provider.stop(sandbox, {
    attemptId: run.daytonaAttemptId,
    runId: run.id,
  });
  if (stopped.kind !== "stopped") {
    return {
      adopted: true,
      kind: "terminalized",
      logEvents: projected.length,
    };
  }
  if (!(await releaseCredentialResources(finalized.run, dependencies))) {
    return {
      adopted: true,
      kind: "terminalized",
      logEvents: projected.length,
    };
  }
  const released = await dependencies.store.releaseTerminalDaytonaAttempt(
    dependencies.operator,
    terminalAuthority,
    { attemptId: run.daytonaAttemptId }
  );
  if (released.kind === "released") {
    await dependencies.store.cleanupTerminalLease(
      dependencies.operator,
      released.authority
    );
  }
  return {
    adopted: true,
    kind: "terminalized",
    logEvents: projected.length,
  };
}

async function recoverExpiredDispatch(
  run: RunnerRunRecord,
  dependencies: ReconcileAndDispatchDependencies,
  lease: Readonly<{ leaseExpiresAt: Date; leaseToken: string }>
): Promise<RecoveryResult> {
  if (
    !run.dispatchLeaseToken ||
    (run.dispatchState !== "dispatching" && run.dispatchState !== "running")
  ) {
    return { kind: "deferred" };
  }
  if (!run.daytonaAttemptId) {
    if (run.cancellationRequestedAt) {
      const claimed = await dependencies.store.requestRunCancellation(
        dependencies.operator,
        { ...lease, runId: run.id }
      );
      if (claimed.kind !== "requested") {
        return { kind: "deferred" };
      }
      if (claimed.run.daytonaSessionId || claimed.run.daytonaCommandId) {
        return { kind: "deferred" };
      }
      if (!(await releaseCredentialResources(claimed.run, dependencies))) {
        return { kind: "deferred" };
      }
      return await finalizeRecoveredCancellation(
        claimed.run,
        claimed.authority,
        dependencies,
        dependencies.clock ?? (() => new Date())
      );
    }
    const requeued = await dependencies.store.requeueExpiredDispatch(
      dependencies.operator,
      {
        expectedDispatchState: run.dispatchState,
        oldLeaseToken: run.dispatchLeaseToken,
        runId: run.id,
      }
    );
    return { kind: requeued.kind === "requeued" ? "requeued" : "deferred" };
  }

  if (run.daytonaCommandId) {
    return await reconcileAttachedProcess(
      run,
      dependencies,
      lease,
      dependencies.clock ?? (() => new Date())
    );
  }

  const claimed = await dependencies.store.claimExpiredDaytonaAttemptCleanup(
    dependencies.operator,
    {
      attemptId: run.daytonaAttemptId,
      expectedDispatchState: run.dispatchState,
      leaseExpiresAt: lease.leaseExpiresAt,
      newLeaseToken: lease.leaseToken,
      oldLeaseToken: run.dispatchLeaseToken,
      runId: run.id,
    }
  );
  if (claimed.kind !== "claimed") {
    return { kind: "deferred" };
  }
  const sandbox = await dependencies.provider.resolveSandbox(
    claimed.run,
    claimed.authority
  );
  if (sandbox) {
    const stopped = await dependencies.provider.stop(sandbox, {
      attemptId: run.daytonaAttemptId,
      runId: run.id,
    });
    if (stopped.kind !== "stopped") {
      return { kind: "deferred" };
    }
  }
  if (!(await releaseCredentialResources(claimed.run, dependencies))) {
    return { kind: "deferred" };
  }
  if (claimed.run.cancellationRequestedAt) {
    return await finalizeRecoveredCancellation(
      claimed.run,
      claimed.authority,
      dependencies,
      dependencies.clock ?? (() => new Date())
    );
  }
  const requeued = await dependencies.store.requeueAfterDaytonaAttemptCleanup(
    dependencies.operator,
    claimed.authority
  );
  return { kind: requeued.kind === "requeued" ? "requeued" : "deferred" };
}

async function recoverTerminalAttempt(
  run: RunnerRunRecord,
  dependencies: ReconcileAndDispatchDependencies,
  lease: Readonly<{ leaseExpiresAt: Date; leaseToken: string }>
): Promise<TerminalCleanupResult> {
  if (
    !dependencies.store.claimTerminalDaytonaAttemptCleanup ||
    !run.daytonaAttemptId ||
    !run.dispatchLeaseToken
  ) {
    return "deferred";
  }
  const claimed = await dependencies.store.claimTerminalDaytonaAttemptCleanup(
    dependencies.operator,
    {
      attemptId: run.daytonaAttemptId,
      expectedVersion: run.version,
      leaseExpiresAt: lease.leaseExpiresAt,
      newLeaseToken: lease.leaseToken,
      oldLeaseToken: run.dispatchLeaseToken,
      runId: run.id,
    }
  );
  if (claimed.kind !== "claimed") {
    return "deferred";
  }
  const sandbox = await dependencies.provider.resolveSandbox(
    claimed.run,
    claimed.authority
  );
  if (sandbox) {
    const stopped = await dependencies.provider.stop(sandbox, {
      attemptId: run.daytonaAttemptId,
      runId: run.id,
    });
    if (stopped.kind !== "stopped") {
      return "deferred";
    }
  }
  if (!(await releaseCredentialResources(claimed.run, dependencies))) {
    return "deferred";
  }
  const released = await dependencies.store.releaseTerminalDaytonaAttempt(
    dependencies.operator,
    claimed.authority,
    { attemptId: run.daytonaAttemptId }
  );
  if (released.kind !== "released") {
    return "deferred";
  }
  const cleaned = await dependencies.store.cleanupTerminalLease(
    dependencies.operator,
    released.authority
  );
  return cleaned.kind === "updated" ? "cleaned" : "deferred";
}

async function finalizeCancellation(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority,
  dependencies: Readonly<{
    operator: RunnerOperator;
    store: CancellationFinalizationStore;
  }>,
  clock: () => Date
): Promise<CancelRunnerRunResult> {
  const finalized = await dependencies.store.finalizeRun(
    dependencies.operator,
    {
      commandEvidence: [],
      completedAt: clock(),
      error: null,
      expectedVersion: authority.expectedVersion,
      fileEvidence: [],
      leaseToken: authority.leaseToken,
      output: "",
      runId: run.id,
      status: "cancelled",
    }
  );
  if (finalized.kind !== "finalized") {
    return { kind: "cleanup_required", runId: run.id };
  }
  if (!run.daytonaAttemptId) {
    const cleaned = await dependencies.store.cleanupTerminalLease(
      dependencies.operator,
      {
        expectedVersion: finalized.run.version,
        leaseToken: authority.leaseToken,
        runId: run.id,
      } as RunnerDispatchAuthority
    );
    return cleaned.kind === "updated"
      ? { kind: "cancelled", runId: run.id }
      : { kind: "cleanup_required", runId: run.id };
  }
  const terminalAuthority = {
    attemptId: run.daytonaAttemptId,
    expectedVersion: finalized.run.version,
    leaseToken: authority.leaseToken,
    runId: run.id,
  } as RunnerDispatchAuthority;
  const released = await dependencies.store.releaseTerminalDaytonaAttempt(
    dependencies.operator,
    terminalAuthority,
    { attemptId: run.daytonaAttemptId }
  );
  if (released.kind !== "released") {
    return { kind: "cleanup_required", runId: run.id };
  }
  const cleaned = await dependencies.store.cleanupTerminalLease(
    dependencies.operator,
    released.authority
  );
  return cleaned.kind === "updated"
    ? { kind: "cancelled", runId: run.id }
    : { kind: "cleanup_required", runId: run.id };
}

/**
 * Persists cancellation intent before the only provider stop operation.
 * It refuses to terminalize as cancelled until the exact attempt's session
 * and credential cleanup are confirmed (or fenced sandbox reset confirms it).
 */
export async function cancelRunnerRun(
  runId: string,
  dependencies: CancelRunnerRunDependencies
): Promise<CancelRunnerRunResult> {
  const clock = dependencies.clock ?? (() => new Date());
  let requested: Awaited<
    ReturnType<CancellationStore["requestRunCancellation"]>
  >;
  try {
    requested = await dependencies.store.requestRunCancellation(
      dependencies.operator,
      { ...nextLease(clock, dependencies.randomToken ?? secureToken), runId }
    );
  } catch {
    return { kind: "cleanup_required", runId };
  }
  if (requested.kind !== "requested") {
    return { kind: requested.kind, runId };
  }
  const { authority, run } = requested;
  if (!run.daytonaAttemptId) {
    if (run.daytonaSessionId || run.daytonaCommandId) {
      return { kind: "cleanup_required", runId };
    }
    try {
      if (!(await releaseCredentialResources(run, dependencies))) {
        return { kind: "cleanup_required", runId };
      }
      return await finalizeCancellation(run, authority, dependencies, clock);
    } catch {
      return { kind: "cleanup_required", runId };
    }
  }

  let sandbox: DaytonaProcessSandbox | null;
  try {
    sandbox = await dependencies.provider.resolveSandbox(run, authority);
  } catch {
    return { kind: "cleanup_required", runId };
  }
  if (sandbox) {
    let stopped: Awaited<ReturnType<RunnerReconciliationProvider["stop"]>>;
    try {
      stopped = await dependencies.provider.stop(sandbox, {
        attemptId: run.daytonaAttemptId,
        runId,
      });
    } catch {
      return { kind: "cleanup_required", runId };
    }
    if (stopped.kind !== "stopped") {
      try {
        if (!(await dependencies.provider.resetSandbox?.(run, authority))) {
          await dependencies.store.appendCancellationDiagnostic(
            dependencies.operator,
            authority
          );
          return { kind: "sandbox_reset_required", runId };
        }
      } catch {
        try {
          await dependencies.store.appendCancellationDiagnostic(
            dependencies.operator,
            authority
          );
        } catch {
          // The durable cancellation intent remains the retry record.
        }
        return { kind: "sandbox_reset_required", runId };
      }
    }
  }
  try {
    if (!(await releaseCredentialResources(run, dependencies))) {
      return { kind: "cleanup_required", runId };
    }
    return await finalizeCancellation(run, authority, dependencies, clock);
  } catch {
    return { kind: "cleanup_required", runId };
  }
}

/**
 * Performs bounded recovery then makes bounded progress through dispatch.
 * Every provider operation is isolated per run so one Daytona outage cannot
 * prevent recovery or dispatch for unrelated work.
 */
export async function reconcileAndDispatch(
  dependencies: ReconcileAndDispatchDependencies
): Promise<RunnerReconciliationResult> {
  const batchSize = boundedInteger(
    dependencies.batchSize,
    DEFAULT_BATCH_SIZE,
    "Reconciliation batch size"
  );
  const providerConcurrency = boundedInteger(
    dependencies.providerConcurrency,
    DEFAULT_PROVIDER_CONCURRENCY,
    "Provider concurrency",
    16
  );
  const dispatchLimit = boundedInteger(
    dependencies.dispatchLimit,
    DEFAULT_DISPATCH_LIMIT,
    "Dispatch limit"
  );
  const clock = dependencies.clock ?? (() => new Date());
  const randomToken = dependencies.randomToken ?? secureToken;
  const result = {
    adopted: 0,
    deferred: 0,
    dispatched: 0,
    expiredScanned: 0,
    failures: 0,
    logEvents: 0,
    requeued: 0,
    sandboxRecovered: 0,
    terminalCleaned: 0,
    terminalized: 0,
  };

  let expired: RunnerRunRecord[];
  try {
    expired = await dependencies.store.scanExpiredDispatchLeases(
      dependencies.operator,
      clock(),
      batchSize
    );
  } catch {
    return { ...result, failures: 1 };
  }
  result.expiredScanned = expired.length;
  const recovery = await mapBounded(
    expired,
    providerConcurrency,
    async (run) => {
      try {
        return await recoverExpiredDispatch(
          run,
          dependencies,
          nextLease(clock, randomToken)
        );
      } catch {
        return { kind: "failed" as const };
      }
    }
  );
  for (const outcome of recovery) {
    result.logEvents += outcome.logEvents ?? 0;
    if (outcome.adopted) {
      result.adopted += 1;
    }
    if (outcome.kind === "requeued") {
      result.requeued += 1;
    } else if (outcome.kind === "terminalized") {
      result.terminalized += 1;
    } else if (outcome.kind === "failed") {
      result.failures += 1;
    } else {
      result.deferred += 1;
    }
  }

  if (dependencies.store.scanTerminalDaytonaAttemptCleanups) {
    let terminal: RunnerRunRecord[];
    try {
      terminal = await dependencies.store.scanTerminalDaytonaAttemptCleanups(
        dependencies.operator,
        batchSize
      );
    } catch {
      result.failures += 1;
      terminal = [];
    }
    const cleanup = await mapBounded(
      terminal,
      providerConcurrency,
      async (run) => {
        try {
          return await recoverTerminalAttempt(
            run,
            dependencies,
            nextLease(clock, randomToken)
          );
        } catch {
          return "failed" as const;
        }
      }
    );
    for (const outcome of cleanup) {
      if (outcome === "cleaned") {
        result.terminalCleaned += 1;
      } else if (outcome === "failed") {
        result.failures += 1;
      } else {
        result.deferred += 1;
      }
    }
  }

  if (dependencies.sandboxRecovery) {
    const sandbox = await reconcileDaytonaSandboxes({
      ...dependencies.sandboxRecovery,
      clock,
      operator: dependencies.operator,
    });
    result.deferred += sandbox.deferred;
    result.failures += sandbox.failures;
    result.sandboxRecovered += sandbox.recovered;
  }

  if (dependencies.dispatch) {
    for (let index = 0; index < dispatchLimit; index += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Claims are intentionally sequential to preserve global fairness.
        const dispatched = await dependencies.dispatch();
        if (dispatched.kind === "idle") {
          break;
        }
        if (dispatched.kind === "started") {
          result.dispatched += 1;
        }
      } catch {
        result.failures += 1;
      }
    }
  }
  return result;
}
