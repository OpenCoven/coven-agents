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
  rollbackRunnerCredentialResources,
} from "@/lib/credentials/runner-credential";
import {
  type DaytonaRunnerDispatchDependencies,
  daytonaRunnerDispatchDependencies,
  dispatchNextRunnerRun,
} from "./admission";
import {
  openRunnerAttemptRedactionFromEnvironment,
  type RunnerAttemptRedactionEnvelope,
  type RunnerAttemptRedactionScope,
} from "./attempt-redaction";
import { daytonaProbeSessionName, daytonaSandboxName } from "./daytona/names";
import {
  cleanupDaytonaProbeSession,
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
  SANDBOX_WARM_TIMEOUT_MS,
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
  | "appendDispatchEventBatch"
  | "cleanupTerminalLease"
  | "finalizeRun"
  | "markDispatchRunningForDispatch"
  | "readAttemptRedaction"
  | "requeueAfterDaytonaAttemptCleanup"
  | "requeueExpiredDispatch"
  | "releaseTerminalDaytonaAttempt"
  | "deleteAttemptRedaction"
  | "scanExpiredDispatchLeases"
> &
  Partial<
    Pick<
      RunnerStore,
      | "appendCancellationDiagnostic"
      | "appendTerminalCleanupDiagnostic"
      | "claimTerminalDaytonaAttemptCleanup"
      | "scanTerminalDaytonaAttemptCleanups"
      | "scanTerminalLeaseCleanups"
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
  ) => Promise<
    Readonly<{
      kind:
        | "provider_not_found"
        | "provider_unavailable"
        | "sandbox_reset_required"
        | "stopped";
    }>
  >;
  snapshot?: (
    input: Parameters<typeof snapshotDaytonaProcess>[0]
  ) => Promise<DaytonaLogSnapshot>;
  /** Fenced reset outcome after a stop cannot confirm exact cleanup. */
  resetSandbox?: (
    run: RunnerRunRecord,
    authority: RunnerDispatchAuthority
  ) => Promise<RunnerSandboxResetResult>;
}>;

export type RunnerSandboxResetResult =
  | Readonly<{ kind: "provider_not_found" | "reset" }>
  | Readonly<{
      kind:
        | "in_progress"
        | "not_found"
        | "sandbox_reset_required"
        | "stale_version";
    }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>;

export type DaytonaReconciliationProviderDependencies = Readonly<{
  daytona: DaytonaSandboxService;
  resetSandbox?: NonNullable<RunnerReconciliationProvider["resetSandbox"]>;
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
  | "finishDaytonaSandboxWarmForRecovery"
  | "finishDaytonaSandboxResetForRecovery"
  | "resetDaytonaSandboxRecovery"
  | "scanDaytonaSandboxRecoveries"
  | "scanDaytonaWarmRecoveries"
>;

export type ReconcileDaytonaSandboxesDependencies = Readonly<{
  batchSize?: number;
  clock?: () => Date;
  daytona: DaytonaSandboxService;
  operator: RunnerOperator;
  providerConcurrency?: number;
  provisioningStaleBefore?: Date;
  store: SandboxRecoveryStore;
  warmStaleBefore?: Date;
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
  terminalLeaseCleaned: number;
  terminalized: number;
}>;

export type RunnerReconciliationExecutionResult =
  | (RunnerReconciliationResult & Readonly<{ execution: "executed" }>)
  | (RunnerReconciliationResult &
      Readonly<{ execution: "skipped"; reason: "overlap" }>);

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
  openAttemptRedaction?: (
    scope: RunnerAttemptRedactionScope,
    envelope: RunnerAttemptRedactionEnvelope
  ) => Promise<string>;
  releaseCredentialResources?: (run: RunnerRunRecord) => Promise<void>;
  rollbackCredentialResources?: (run: RunnerRunRecord) => Promise<void>;
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
    openAttemptRedaction: (scope, envelope) =>
      openRunnerAttemptRedactionFromEnvironment(scope, envelope),
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
    rollbackCredentialResources: (run) =>
      rollbackRunnerCredentialResources(
        { runId: run.id, tenant: run.tenant },
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
  Pick<
    RunnerStore,
    | "appendCancellationDiagnostic"
    | "deleteAttemptRedaction"
    | "requestRunCancellation"
  >;

export type CancelRunnerRunDependencies = Readonly<{
  clock?: () => Date;
  operator: RunnerOperator;
  provider: RunnerReconciliationProvider;
  randomToken?: () => string;
  rollbackCredentialResources?: (run: RunnerRunRecord) => Promise<void>;
  releaseCredentialResources?: (run: RunnerRunRecord) => Promise<void>;
  store: CancellationStore;
}>;

export type CancelRunnerRunResult =
  | { kind: "already_terminal" | "in_progress" | "not_found"; runId: string }
  | { kind: "cancelled"; runId: string }
  | {
      kind: "cleanup_required" | "sandbox_reset_required" | "stale_version";
      runId: string;
    }
  | {
      kind: "unavailable";
      runId: string;
      source: "database" | "provider";
    };

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
    rollbackCredentialResources: (run) =>
      rollbackRunnerCredentialResources(
        { runId: run.id, tenant: run.tenant },
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
    return false;
  }
  try {
    await dependencies.releaseCredentialResources(run);
    return true;
  } catch {
    return false;
  }
}

async function rollbackCredentialResources(
  run: RunnerRunRecord,
  dependencies: Pick<
    ReconcileAndDispatchDependencies | CancelRunnerRunDependencies,
    "rollbackCredentialResources"
  >
): Promise<boolean> {
  if (!dependencies.rollbackCredentialResources) {
    return false;
  }
  try {
    await dependencies.rollbackCredentialResources(run);
    return true;
  } catch {
    return false;
  }
}

async function openAttemptRedaction(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority,
  dependencies: ReconcileAndDispatchDependencies
): Promise<string | null> {
  if (!authority.attemptId || run.daytonaAttemptId !== authority.attemptId) {
    return null;
  }
  const persisted = await dependencies.store.readAttemptRedaction(
    dependencies.operator,
    authority
  );
  if (persisted.kind !== "found") {
    return null;
  }
  const credential = await (
    dependencies.openAttemptRedaction ??
    openRunnerAttemptRedactionFromEnvironment
  )(
    {
      attemptId: authority.attemptId,
      runId: run.id,
      tenant: run.tenant,
    },
    persisted.value
  );
  return credential.trim() ? credential : null;
}

async function retireAttemptRedaction(
  authority: RunnerDispatchAuthority,
  dependencies: Pick<
    ReconcileAndDispatchDependencies | CancelRunnerRunDependencies,
    "operator" | "store"
  >
): Promise<boolean> {
  try {
    return (
      (
        await dependencies.store.deleteAttemptRedaction(
          dependencies.operator,
          authority
        )
      ).kind === "deleted"
    );
  } catch {
    return false;
  }
}

async function resetSandboxAfterStopFailure(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority,
  dependencies: Pick<
    ReconcileAndDispatchDependencies | CancelRunnerRunDependencies,
    "provider"
  >
): Promise<boolean> {
  try {
    const reset = await dependencies.provider.resetSandbox?.(run, authority);
    return reset?.kind === "reset" || reset?.kind === "provider_not_found";
  } catch {
    return false;
  }
}

function providerStopConfirmed(
  stopped: Awaited<ReturnType<RunnerReconciliationProvider["stop"]>>
): boolean {
  return stopped.kind === "stopped" || stopped.kind === "provider_not_found";
}

async function stopTerminalAttempt(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority,
  sandbox: DaytonaProcessSandbox,
  dependencies: ReconcileAndDispatchDependencies
): Promise<boolean> {
  if (!authority.attemptId) {
    return false;
  }
  const stopped = await dependencies.provider.stop(sandbox, {
    attemptId: authority.attemptId,
    runId: run.id,
  });
  if (providerStopConfirmed(stopped)) {
    return true;
  }
  if (
    stopped.kind === "sandbox_reset_required" &&
    (await resetSandboxAfterStopFailure(run, authority, dependencies))
  ) {
    return true;
  }
  if (stopped.kind === "provider_unavailable") {
    return false;
  }
  try {
    await dependencies.store.appendTerminalCleanupDiagnostic?.(
      dependencies.operator,
      authority
    );
  } catch {
    // The terminal attempt and lease remain the durable retry record.
  }
  return false;
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
  provisioningStaleBefore: Date,
  warmStaleBefore: Date
): Promise<SandboxRecoveryOutcome> {
  const fence = {
    agentId: agent.id,
    expectedGeneration: agent.sandboxGeneration,
    expectedVersion: agent.version,
  };
  if (
    agent.sandboxLifecycle === "ready" &&
    agent.warmStatus === "provisioning"
  ) {
    if (agent.warmUpdatedAt > warmStaleBefore) {
      return "deferred";
    }
    let sandbox: Sandbox | null;
    try {
      sandbox = await findSandboxForRecovery(agent, dependencies.daytona);
      if (sandbox) {
        await cleanupDaytonaProbeSession(
          sandbox as unknown as DaytonaProcessSandbox,
          daytonaProbeSessionName(
            agent.id,
            agent.sandboxGeneration,
            agent.warmAttemptVersion,
            agent.warmUpdatedAt
          )
        );
      }
    } catch {
      return "deferred";
    }
    try {
      const finished =
        await dependencies.store.finishDaytonaSandboxWarmForRecovery(
          dependencies.operator,
          fence
        );
      return finished.kind === "updated" ? "recovered" : "deferred";
    } catch {
      return "deferred";
    }
  }
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
  const warmStaleBefore =
    dependencies.warmStaleBefore ??
    new Date(clock().getTime() - SANDBOX_WARM_TIMEOUT_MS);
  let failures = 0;
  let agents: RunnerAgentRecord[] = [];
  try {
    agents = await dependencies.store.scanDaytonaSandboxRecoveries(
      dependencies.operator,
      batchSize
    );
  } catch {
    failures += 1;
  }
  let warmAgents: RunnerAgentRecord[] = [];
  try {
    warmAgents = await dependencies.store.scanDaytonaWarmRecoveries(
      dependencies.operator,
      warmStaleBefore,
      batchSize
    );
  } catch {
    failures += 1;
  }
  const recover = async (agent: RunnerAgentRecord) => {
    try {
      return await recoverSandbox(
        agent,
        dependencies,
        provisioningStaleBefore,
        warmStaleBefore
      );
    } catch {
      return "failed" as const;
    }
  };
  const [lifecycleOutcomes, warmOutcomes] = await Promise.all([
    mapBounded(agents, providerConcurrency, recover),
    mapBounded(warmAgents, providerConcurrency, recover),
  ]);
  const outcomes = [...lifecycleOutcomes, ...warmOutcomes];
  return outcomes.reduce<DaytonaSandboxReconciliationResult>(
    (result, outcome) => ({
      deferred: result.deferred + (outcome === "deferred" ? 1 : 0),
      failures: result.failures + (outcome === "failed" ? 1 : 0),
      recovered: result.recovered + (outcome === "recovered" ? 1 : 0),
    }),
    { deferred: 0, failures, recovered: 0 }
  );
}

function terminalEvidence(
  snapshot: DaytonaLogSnapshot,
  credential: string
): Readonly<{
  commandEvidence: CommandEvidence[];
  error: RunError | null;
  fileEvidence: FileEvidence[];
  output: string;
}> {
  return {
    commandEvidence: snapshot.summary.toolCalls
      .slice(0, AGENT_RUNNER_LIMITS.maxCommandResults)
      .map((call) => ({
        command: sanitizeRunText(call.tool, credential),
        exitCode: call.success ? 0 : 1,
        stderr: "",
        stdout: sanitizeRunText(call.summary, credential),
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
      .map((file) => ({
        operation: file.operation,
        path: sanitizeRunText(file.path, credential),
      }))
      .filter(
        (file): file is FileEvidence =>
          file.operation === "create" ||
          file.operation === "modify" ||
          file.operation === "delete"
      ),
    output: truncateUtf8(
      sanitizeRunText(snapshot.summary.output, credential),
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
      if (
        !providerStopConfirmed(stopped) &&
        (stopped.kind !== "sandbox_reset_required" ||
          !(await resetSandboxAfterStopFailure(
            adopted.run,
            adopted.authority,
            dependencies
          )))
      ) {
        if (stopped.kind === "provider_unavailable") {
          return { adopted: true, kind: "deferred" };
        }
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
    if (!(await retireAttemptRedaction(adopted.authority, dependencies))) {
      return { adopted: true, kind: "deferred" };
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
    if (!(await retireAttemptRedaction(adopted.authority, dependencies))) {
      return { adopted: true, kind: "deferred" };
    }
    if (!(await rollbackCredentialResources(adopted.run, dependencies))) {
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

  let redactionCredential: string | null | undefined;
  try {
    redactionCredential = await openAttemptRedaction(
      adopted.run,
      adopted.authority,
      dependencies
    );
    if (!redactionCredential) {
      return { adopted: true, kind: "deferred" };
    }
    const credentialForRedaction = redactionCredential;
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
      credential: credentialForRedaction,
      cursor: liveRun.daytonaLogCursor,
      harness: "copilot",
      runId: run.id,
      sandbox,
    });
    const toolNames = new Map<string, string>();
    const projected = snapshot.events
      .map((event) =>
        projectHarnessRunEvent(event, 0, credentialForRedaction, toolNames)
      )
      .filter((event): event is RunEvent => event !== null);
    const evidence = terminalEvidence(snapshot, credentialForRedaction);
    const appended = await dependencies.store.appendDispatchEventBatch(
      dependencies.operator,
      authority,
      {
        daytonaLogCursor: snapshot.cursor,
        events: projected.map(withoutEventId) as never,
        snapshot: {
          commandEvidence: evidence.commandEvidence,
          fileEvidence: evidence.fileEvidence,
          output: evidence.output,
        },
      }
    );
    if (appended.kind !== "appended") {
      return { adopted: true, kind: "deferred" };
    }
    ({ authority } = appended);

    if (snapshot.status === "running" || !snapshot.logsSettled) {
      return {
        adopted: true,
        kind: "deferred",
        logEvents: projected.length,
      };
    }
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
    if (
      !(await stopTerminalAttempt(
        finalized.run,
        terminalAuthority,
        sandbox,
        dependencies
      ))
    ) {
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
    if (!(await retireAttemptRedaction(terminalAuthority, dependencies))) {
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
  } finally {
    redactionCredential = undefined;
  }
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
      if (!(await rollbackCredentialResources(claimed.run, dependencies))) {
        return { kind: "deferred" };
      }
      return await finalizeRecoveredCancellation(
        claimed.run,
        claimed.authority,
        dependencies,
        dependencies.clock ?? (() => new Date())
      );
    }
    if (!(await rollbackCredentialResources(run, dependencies))) {
      return { kind: "deferred" };
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
    if (stopped.kind === "provider_unavailable") {
      return { kind: "deferred" };
    }
    if (
      !providerStopConfirmed(stopped) &&
      !(await resetSandboxAfterStopFailure(
        claimed.run,
        claimed.authority,
        dependencies
      ))
    ) {
      return { kind: "deferred" };
    }
  }
  if (!(await retireAttemptRedaction(claimed.authority, dependencies))) {
    return { kind: "deferred" };
  }
  if (!(await rollbackCredentialResources(claimed.run, dependencies))) {
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
  if (
    sandbox &&
    !(await stopTerminalAttempt(
      claimed.run,
      claimed.authority,
      sandbox,
      dependencies
    ))
  ) {
    return "deferred";
  }
  if (!(await retireAttemptRedaction(claimed.authority, dependencies))) {
    return "deferred";
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
  let finalized: Awaited<
    ReturnType<CancellationFinalizationStore["finalizeRun"]>
  >;
  try {
    finalized = await dependencies.store.finalizeRun(dependencies.operator, {
      commandEvidence: [],
      completedAt: clock(),
      error: null,
      expectedVersion: authority.expectedVersion,
      fileEvidence: [],
      leaseToken: authority.leaseToken,
      output: "",
      runId: run.id,
      status: "cancelled",
    });
  } catch {
    return { kind: "unavailable", runId: run.id, source: "database" };
  }
  if (finalized.kind !== "finalized") {
    return finalized.kind === "not_found"
      ? { kind: "not_found", runId: run.id }
      : { kind: "stale_version", runId: run.id };
  }
  if (!run.daytonaAttemptId) {
    let cleaned: Awaited<
      ReturnType<CancellationFinalizationStore["cleanupTerminalLease"]>
    >;
    try {
      cleaned = await dependencies.store.cleanupTerminalLease(
        dependencies.operator,
        {
          expectedVersion: finalized.run.version,
          leaseToken: authority.leaseToken,
          runId: run.id,
        } as RunnerDispatchAuthority
      );
    } catch {
      return { kind: "unavailable", runId: run.id, source: "database" };
    }
    switch (cleaned.kind) {
      case "updated":
        return { kind: "cancelled", runId: run.id };
      case "not_found":
        return { kind: "not_found", runId: run.id };
      case "lease_lost":
      case "stale_version":
        return { kind: "stale_version", runId: run.id };
      case "generation_mismatch":
      case "not_live":
        return { kind: "cleanup_required", runId: run.id };
      default:
        return cleaned;
    }
  }
  const terminalAuthority = {
    attemptId: run.daytonaAttemptId,
    expectedVersion: finalized.run.version,
    leaseToken: authority.leaseToken,
    runId: run.id,
  } as RunnerDispatchAuthority;
  let released: Awaited<
    ReturnType<CancellationFinalizationStore["releaseTerminalDaytonaAttempt"]>
  >;
  try {
    released = await dependencies.store.releaseTerminalDaytonaAttempt(
      dependencies.operator,
      terminalAuthority,
      { attemptId: run.daytonaAttemptId }
    );
  } catch {
    return { kind: "unavailable", runId: run.id, source: "database" };
  }
  if (released.kind !== "released") {
    return released.kind === "not_found"
      ? { kind: "not_found", runId: run.id }
      : { kind: "stale_version", runId: run.id };
  }
  let cleaned: Awaited<
    ReturnType<CancellationFinalizationStore["cleanupTerminalLease"]>
  >;
  try {
    cleaned = await dependencies.store.cleanupTerminalLease(
      dependencies.operator,
      released.authority
    );
  } catch {
    return { kind: "unavailable", runId: run.id, source: "database" };
  }
  switch (cleaned.kind) {
    case "updated":
      return { kind: "cancelled", runId: run.id };
    case "not_found":
      return { kind: "not_found", runId: run.id };
    case "lease_lost":
    case "stale_version":
      return { kind: "stale_version", runId: run.id };
    case "generation_mismatch":
    case "not_live":
      return { kind: "cleanup_required", runId: run.id };
    default:
      return cleaned;
  }
}

function terminalCleanupConfirmed(run: RunnerRunRecord): boolean {
  return (
    run.dispatchState === "terminal" &&
    run.daytonaAttemptId === null &&
    run.daytonaCommandId === null &&
    run.daytonaSessionId === null &&
    run.dispatchLeaseExpiresAt === null &&
    run.dispatchLeaseToken === null
  );
}

async function recoverTerminalLease(
  run: RunnerRunRecord,
  dependencies: Pick<ReconcileAndDispatchDependencies, "operator" | "store">
): Promise<"cleaned" | "deferred" | "skipped"> {
  if (
    run.dispatchState !== "terminal" ||
    run.daytonaAttemptId !== null ||
    run.daytonaCommandId !== null ||
    run.daytonaSessionId !== null ||
    run.dispatchLeaseToken === null ||
    run.dispatchLeaseExpiresAt === null
  ) {
    return "skipped";
  }
  const cleaned = await dependencies.store.cleanupTerminalLease(
    dependencies.operator,
    {
      expectedVersion: run.version,
      leaseToken: run.dispatchLeaseToken,
      runId: run.id,
    } as RunnerDispatchAuthority
  );
  return cleaned.kind === "updated" ? "cleaned" : "deferred";
}

async function retireCancellationAttemptRedaction(
  authority: RunnerDispatchAuthority,
  dependencies: CancelRunnerRunDependencies
): Promise<CancelRunnerRunResult | null> {
  let retired: Awaited<ReturnType<CancellationStore["deleteAttemptRedaction"]>>;
  try {
    retired = await dependencies.store.deleteAttemptRedaction(
      dependencies.operator,
      authority
    );
  } catch {
    return {
      kind: "unavailable",
      runId: authority.runId,
      source: "database",
    };
  }
  switch (retired.kind) {
    case "deleted":
      return null;
    case "not_found":
      return { kind: "not_found", runId: authority.runId };
    case "lease_lost":
    case "stale_version":
      return { kind: "stale_version", runId: authority.runId };
    case "not_live":
      return { kind: "stale_version", runId: authority.runId };
    default:
      return retired;
  }
}

async function resetSandboxForCancellation(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority,
  dependencies: CancelRunnerRunDependencies
): Promise<CancelRunnerRunResult | null> {
  let reset: RunnerSandboxResetResult;
  try {
    reset = (await dependencies.provider.resetSandbox?.(run, authority)) ?? {
      kind: "sandbox_reset_required",
    };
  } catch {
    return { kind: "unavailable", runId: run.id, source: "provider" };
  }
  switch (reset.kind) {
    case "provider_not_found":
    case "reset":
      return null;
    case "in_progress":
    case "not_found":
    case "sandbox_reset_required":
    case "stale_version":
      return { kind: reset.kind, runId: run.id };
    case "unavailable":
      return { ...reset, runId: run.id };
    default:
      return reset;
  }
}

async function cleanupCancellationAccounting(
  run: RunnerRunRecord,
  dependencies: CancelRunnerRunDependencies
): Promise<boolean> {
  return run.daytonaCommandId
    ? await releaseCredentialResources(run, dependencies)
    : await rollbackCredentialResources(run, dependencies);
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
    return { kind: "unavailable", runId, source: "database" };
  }
  if (requested.kind !== "requested") {
    if (
      requested.kind === "already_terminal" &&
      !terminalCleanupConfirmed(requested.run)
    ) {
      return { kind: "cleanup_required", runId };
    }
    return { kind: requested.kind, runId };
  }
  const { authority, run } = requested;
  if (!run.daytonaAttemptId) {
    if (run.daytonaSessionId || run.daytonaCommandId) {
      return { kind: "cleanup_required", runId };
    }
    try {
      if (!(await rollbackCredentialResources(run, dependencies))) {
        return { kind: "cleanup_required", runId };
      }
      return await finalizeCancellation(run, authority, dependencies, clock);
    } catch {
      return { kind: "unavailable", runId, source: "database" };
    }
  }

  let sandbox: DaytonaProcessSandbox | null;
  try {
    sandbox = await dependencies.provider.resolveSandbox(run, authority);
  } catch {
    return { kind: "unavailable", runId, source: "provider" };
  }
  if (sandbox) {
    let stopped: Awaited<ReturnType<RunnerReconciliationProvider["stop"]>>;
    try {
      stopped = await dependencies.provider.stop(sandbox, {
        attemptId: run.daytonaAttemptId,
        runId,
      });
    } catch {
      return { kind: "unavailable", runId, source: "provider" };
    }
    if (stopped.kind === "provider_unavailable") {
      return { kind: "unavailable", runId, source: "provider" };
    }
    if (stopped.kind === "sandbox_reset_required") {
      const reset = await resetSandboxForCancellation(
        run,
        authority,
        dependencies
      );
      if (reset?.kind === "sandbox_reset_required") {
        try {
          await dependencies.store.appendCancellationDiagnostic(
            dependencies.operator,
            authority
          );
        } catch {
          // The durable cancellation intent remains the retry record.
        }
        return reset;
      }
      if (reset) {
        return reset;
      }
    }
  }
  const redactionFailure = await retireCancellationAttemptRedaction(
    authority,
    dependencies
  );
  if (redactionFailure) {
    return redactionFailure;
  }
  if (!(await cleanupCancellationAccounting(run, dependencies))) {
    return { kind: "cleanup_required", runId };
  }
  return await finalizeCancellation(run, authority, dependencies, clock);
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
    terminalLeaseCleaned: 0,
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

  if (dependencies.store.scanTerminalLeaseCleanups) {
    let terminalLeases: RunnerRunRecord[];
    try {
      terminalLeases = await dependencies.store.scanTerminalLeaseCleanups(
        dependencies.operator,
        batchSize
      );
    } catch {
      result.failures += 1;
      terminalLeases = [];
    }
    const leaseCleanup = await mapBounded(
      terminalLeases,
      providerConcurrency,
      async (run) => {
        try {
          return await recoverTerminalLease(run, dependencies);
        } catch {
          return "failed" as const;
        }
      }
    );
    for (const outcome of leaseCleanup) {
      if (outcome === "cleaned") {
        result.terminalLeaseCleaned += 1;
      } else if (outcome === "failed") {
        result.failures += 1;
      } else if (outcome === "deferred") {
        result.deferred += 1;
      }
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
