import "server-only";

import { randomBytes } from "node:crypto";
import {
  AGENT_RUNNER_LIMITS,
  type CommandEvidence,
  type EvidenceRedactionInput,
  exactEvidenceRedactions,
  type FileEvidence,
  type RunError,
  type RunEvent as RunnerPersistedEvent,
} from "@opencoven/agent-contracts";
import {
  openRunnerAttemptRedactionFromEnvironment,
  type RunnerAttemptRedactionEnvelope,
  type RunnerAttemptRedactionScope,
} from "./attempt-redaction";
import {
  RUNNER_MID_RUN_ENTITLEMENT_POLICY,
  runnerEntitlementContinuation,
} from "./entitlement-policy";
import {
  projectHarnessRunEvent,
  sanitizeRunText,
  truncateUtf8,
} from "./evidence";
import type { RunEvent, RunSummary } from "./harness";
import type {
  RunnerPersistentResourceLifecycle,
  RunnerResourceResetResult,
} from "./resource-lifecycle";
import type { RunnerStore } from "./store";
import type {
  RunnerClaimedDispatch,
  RunnerDispatchAuthority,
  RunnerExecutionAttemptId,
  RunnerOperator,
  RunnerRunRecord,
} from "./types";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_DISPATCH_LIMIT = 1;
const DEFAULT_PROVIDER_CONCURRENCY = 4;
const DISPATCH_LEASE_MS = 60_000;

declare const runnerReconciliationContextBrand: unique symbol;

/** Opaque provider-owned context used only to reconcile one fenced attempt. */
export type RunnerReconciliationContext = Readonly<{
  readonly [runnerReconciliationContextBrand]: "RunnerReconciliationContext";
}>;

export type RunnerAttemptLogSnapshot = Readonly<{
  cursor: number;
  events: readonly RunEvent[];
  exitCode: number | null;
  logsSettled: boolean;
  status: "running" | "completed" | "failed";
  summary: RunSummary;
}>;

export type RunnerAttemptSnapshotInput = Readonly<{
  attemptId: RunnerExecutionAttemptId;
  commandId: string;
  context: RunnerReconciliationContext;
  credential: EvidenceRedactionInput;
  cursor: number;
  harness: "copilot";
  runId: string;
}>;

export type RunnerStopAttemptResult = Readonly<{
  kind:
    | "provider_not_found"
    | "provider_unavailable"
    | "sandbox_reset_required"
    | "stopped";
}>;

/**
 * Provider-neutral attempt recovery boundary. Only confirmed absence is null;
 * all provider failures throw so callers preserve the durable retry record.
 */
export type RunnerReconciliationProvider = Readonly<{
  /**
   * Production providers need the persisted credential only to redact opaque
   * output. The hermetic adapter emits fixed, credential-free evidence and
   * therefore must not retain credential material solely for recovery.
   */
  requiresAttemptRedaction?: boolean;
  resolveExecutionContext: (
    run: RunnerRunRecord,
    authority: RunnerDispatchAuthority
  ) => Promise<RunnerReconciliationContext | null>;
  snapshot?: (
    input: RunnerAttemptSnapshotInput
  ) => Promise<RunnerAttemptLogSnapshot>;
  stop: (
    context: RunnerReconciliationContext,
    input: Readonly<{
      attemptId: RunnerExecutionAttemptId;
      runId: string;
    }>
  ) => Promise<RunnerStopAttemptResult>;
}>;

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
  claimTeamRuns?: () => Promise<
    Readonly<{
      claimedDispatches: readonly RunnerClaimedDispatch[];
      deferred: number;
      failures: number;
    }>
  >;
  clock?: () => Date;
  dispatch?: () => Promise<Readonly<{ kind: string }>>;
  dispatchClaim?: (
    claimed: RunnerClaimedDispatch
  ) => Promise<Readonly<{ kind: string }>>;
  dispatchLimit?: number;
  operator: RunnerOperator;
  provider: RunnerReconciliationProvider;
  providerConcurrency?: number;
  maxRunDurationMs?: number;
  preflightQueuedDispatch?: () => Promise<void>;
  randomToken?: () => string;
  consumeCredentialReservation?: (run: RunnerRunRecord) => Promise<void>;
  openAttemptRedaction?: (
    scope: RunnerAttemptRedactionScope,
    envelope: RunnerAttemptRedactionEnvelope
  ) => Promise<string>;
  projectTeamRuns?: () => Promise<
    Readonly<{ cancellationDeferred: number; failures: number }>
  >;
  releaseCredentialResources?: (run: RunnerRunRecord) => Promise<void>;
  resourceLifecycle?: Partial<
    Pick<RunnerPersistentResourceLifecycle, "recover" | "reset">
  >;
  rollbackCredentialResources?: (run: RunnerRunRecord) => Promise<void>;
  store: ReconciliationStore;
}>;

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
  resourceLifecycle?: Partial<Pick<RunnerPersistentResourceLifecycle, "reset">>;
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

async function resetResourceAfterStopFailure(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority,
  dependencies: Pick<
    ReconcileAndDispatchDependencies | CancelRunnerRunDependencies,
    "resourceLifecycle"
  >
): Promise<boolean> {
  try {
    const reset = await dependencies.resourceLifecycle?.reset?.(run, authority);
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
  context: RunnerReconciliationContext,
  dependencies: ReconcileAndDispatchDependencies
): Promise<boolean> {
  if (!authority.attemptId) {
    return false;
  }
  const stopped = await dependencies.provider.stop(context, {
    attemptId: authority.attemptId,
    runId: run.id,
  });
  if (providerStopConfirmed(stopped)) {
    return true;
  }
  if (
    stopped.kind === "sandbox_reset_required" &&
    (await resetResourceAfterStopFailure(run, authority, dependencies))
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

function terminalEvidence(
  snapshot: RunnerAttemptLogSnapshot,
  credential: EvidenceRedactionInput
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

/**
 * Provider identifiers stay internal for fenced provider calls, but are exact
 * redactions at the neutral evidence boundary in case an adapter regresses.
 * Product run IDs are intentionally not included in public evidence redaction.
 */
function attemptEvidenceRedactions(
  run: RunnerRunRecord,
  credential: string | null
): EvidenceRedactionInput {
  return exactEvidenceRedactions(
    credential,
    run.daytonaAttemptId,
    run.daytonaSessionId,
    run.daytonaCommandId
  );
}

function withoutEventId(
  event: RunnerPersistedEvent
): Omit<RunnerPersistedEvent, "id"> {
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
  clock: () => Date,
  maxRunDurationMs: number
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

  const context = await dependencies.provider.resolveExecutionContext(
    adopted.run,
    adopted.authority
  );
  if (adopted.run.cancellationRequestedAt) {
    if (context) {
      const stopped = await dependencies.provider.stop(context, {
        attemptId: run.daytonaAttemptId,
        runId: run.id,
      });
      if (
        !providerStopConfirmed(stopped) &&
        (stopped.kind !== "sandbox_reset_required" ||
          !(await resetResourceAfterStopFailure(
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
  if (!context) {
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
    if (
      !redactionCredential &&
      (dependencies.provider.requiresAttemptRedaction ?? true)
    ) {
      return { adopted: true, kind: "deferred" };
    }
    const credentialForRedaction = redactionCredential ?? null;
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

    if (!dependencies.provider.snapshot) {
      return { adopted: true, kind: "deferred" };
    }
    const evidenceRedactions = attemptEvidenceRedactions(
      liveRun,
      credentialForRedaction
    );
    const snapshot = await dependencies.provider.snapshot({
      attemptId: run.daytonaAttemptId,
      commandId: run.daytonaCommandId,
      context,
      credential: evidenceRedactions,
      cursor: liveRun.daytonaLogCursor,
      harness: "copilot",
      runId: run.id,
    });
    const toolNames = new Map<string, string>();
    const projected = snapshot.events
      .map((event) =>
        projectHarnessRunEvent(event, 0, evidenceRedactions, toolNames)
      )
      .filter((event): event is RunnerPersistedEvent => event !== null);
    const evidence = terminalEvidence(snapshot, evidenceRedactions);
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

    const completedAt = clock();
    const runWindowExpired =
      runnerEntitlementContinuation({
        dispatchState: liveRun.dispatchState,
        hasDurablyAuthorizedLaunch: Boolean(
          liveRun.daytonaAttemptId && liveRun.daytonaCommandId
        ),
        now: completedAt,
        policy: {
          ...RUNNER_MID_RUN_ENTITLEMENT_POLICY,
          maxDurationMs: maxRunDurationMs,
        },
        startedAt: liveRun.startedAt,
      }) === "max_duration_elapsed";
    const timedOut = snapshot.status === "running" && runWindowExpired;
    const terminalOutputIncomplete =
      snapshot.status !== "running" &&
      !snapshot.logsSettled &&
      runWindowExpired;
    if (
      !timedOut &&
      !terminalOutputIncomplete &&
      (snapshot.status === "running" || !snapshot.logsSettled)
    ) {
      return {
        adopted: true,
        kind: "deferred",
        logEvents: projected.length,
      };
    }
    const terminalStatus =
      timedOut || terminalOutputIncomplete || snapshot.status === "failed"
        ? "failed"
        : "completed";
    const finalized = await dependencies.store.finalizeRun(
      dependencies.operator,
      {
        commandEvidence: evidence.commandEvidence,
        completedAt,
        error:
          timedOut || terminalOutputIncomplete
            ? {
                code: timedOut ? "run_timeout" : "run_output_incomplete",
                details:
                  "Complete sanitized updates received before shutdown are preserved in this record.",
                message: timedOut
                  ? "The runner stopped this run after it reached the execution time limit."
                  : "The command ended, but its final output record remained incomplete until the execution time limit.",
                retryable: true,
              }
            : evidence.error,
        expectedVersion: authority.expectedVersion,
        fileEvidence: evidence.fileEvidence,
        leaseToken: authority.leaseToken,
        output: evidence.output,
        runId: run.id,
        status: terminalStatus,
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
        context,
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
  lease: Readonly<{ leaseExpiresAt: Date; leaseToken: string }>,
  maxRunDurationMs: number
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
      dependencies.clock ?? (() => new Date()),
      maxRunDurationMs
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
  const context = await dependencies.provider.resolveExecutionContext(
    claimed.run,
    claimed.authority
  );
  if (context) {
    const stopped = await dependencies.provider.stop(context, {
      attemptId: run.daytonaAttemptId,
      runId: run.id,
    });
    if (stopped.kind === "provider_unavailable") {
      return { kind: "deferred" };
    }
    if (
      !providerStopConfirmed(stopped) &&
      !(await resetResourceAfterStopFailure(
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
  const context = await dependencies.provider.resolveExecutionContext(
    claimed.run,
    claimed.authority
  );
  if (
    context &&
    !(await stopTerminalAttempt(
      claimed.run,
      claimed.authority,
      context,
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

async function resetResourceForCancellation(
  run: RunnerRunRecord,
  authority: RunnerDispatchAuthority,
  dependencies: CancelRunnerRunDependencies
): Promise<CancelRunnerRunResult | null> {
  let reset: RunnerResourceResetResult;
  try {
    reset = (await dependencies.resourceLifecycle?.reset?.(run, authority)) ?? {
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

  let context: RunnerReconciliationContext | null;
  try {
    context = await dependencies.provider.resolveExecutionContext(
      run,
      authority
    );
  } catch {
    return { kind: "unavailable", runId, source: "provider" };
  }
  if (context) {
    let stopped: Awaited<ReturnType<RunnerReconciliationProvider["stop"]>>;
    try {
      stopped = await dependencies.provider.stop(context, {
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
      const reset = await resetResourceForCancellation(
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
  const maxRunDurationMs = boundedInteger(
    dependencies.maxRunDurationMs,
    RUNNER_MID_RUN_ENTITLEMENT_POLICY.maxDurationMs,
    "Maximum run duration",
    24 * 60 * 60 * 1000
  );
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
          nextLease(clock, randomToken),
          maxRunDurationMs
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

  if (dependencies.resourceLifecycle?.recover) {
    const sandbox = await dependencies.resourceLifecycle.recover(clock);
    result.deferred += sandbox.deferred;
    result.failures += sandbox.failures;
    result.sandboxRecovered += sandbox.recovered;
  }

  if (dependencies.projectTeamRuns) {
    try {
      const projected = await dependencies.projectTeamRuns();
      result.deferred += projected.cancellationDeferred;
      result.failures += projected.failures;
    } catch {
      result.failures += 1;
    }
  }

  if (dependencies.preflightQueuedDispatch) {
    try {
      await dependencies.preflightQueuedDispatch();
    } catch {
      result.failures += 1;
    }
  }

  let claimedDispatches: readonly RunnerClaimedDispatch[] = [];
  if (dependencies.claimTeamRuns) {
    try {
      const claimed = await dependencies.claimTeamRuns();
      ({ claimedDispatches } = claimed);
      result.deferred += claimed.deferred;
      result.failures += claimed.failures;
    } catch {
      result.failures += 1;
    }
  }

  if (claimedDispatches.length > 0) {
    if (dependencies.dispatchClaim) {
      for (const claimed of claimedDispatches) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: Exact zero-queue claims must dispatch sequentially.
          const dispatched = await dependencies.dispatchClaim(claimed);
          if (dispatched.kind === "started") {
            result.dispatched += 1;
          }
        } catch {
          result.failures += 1;
        }
      }
    } else {
      result.failures += claimedDispatches.length;
    }
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
  return result;
}
