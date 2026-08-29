import "server-only";

import type {
  CommandEvidence,
  FileEvidence,
  RunError,
  RunEvent,
  RunSnapshot,
} from "@opencoven/agent-contracts";

/**
 * A subscriber's authority to access only their tenant's runner records.
 * This is deliberately not interchangeable with RunnerOperator.
 */
export type RunnerPrincipal = {
  kind: "subscriber";
  tenant: string;
  userId: string;
};

/**
 * Authority used by the scheduler, cron reconciliation, and Daytona dispatcher.
 * It is intentionally a separate capability from a subscriber identity.
 */
export type RunnerOperator = { kind: "runner-operator" };

declare const runnerDispatchAuthorityBrand: unique symbol;
declare const runnerDaytonaAttemptIdBrand: unique symbol;

/**
 * Opaque authority minted from a live operator dispatch claim. It cannot be
 * constructed by subscriber-facing code and every use is re-fenced in SQL.
 */
export type RunnerDispatchAuthority = Readonly<{
  expectedVersion: number;
  leaseToken: string;
  attemptId?: RunnerDaytonaAttemptId;
  runId: string;
  readonly [runnerDispatchAuthorityBrand]: "RunnerDispatchAuthority";
}>;

/**
 * Opaque ownership of a deterministic Daytona launch preparation. The store
 * mints it before provider mutation and persists it separately from provider
 * identifiers.
 */
export type RunnerDaytonaAttemptId = string & {
  readonly [runnerDaytonaAttemptIdBrand]: "RunnerDaytonaAttemptId";
};

export type RunnerReconciliationLease = Readonly<{
  expiresAt: Date;
  fence: number;
  ownerToken: string;
}>;

export type AcquireRunnerReconciliationLeaseInput = Readonly<{
  ownerToken: string;
  ttlSeconds: number;
}>;

export type AcquireRunnerReconciliationLeaseResult =
  | Readonly<{ kind: "acquired"; lease: RunnerReconciliationLease }>
  | Readonly<{ kind: "held" }>;

export type ReleaseRunnerReconciliationLeaseResult =
  | Readonly<{ kind: "released" }>
  | Readonly<{ kind: "stale" }>;

export type RunnerRuntime = "codex" | "claude" | "copilot";
export type RunnerAgentStatus = "idle" | "running" | "error";
export type RunnerSandboxLifecycle =
  | "unprovisioned"
  | "provisioning"
  | "provisioning_ambiguous"
  | "ready"
  | "resetting"
  | "decommissioning"
  | "decommission_failed";
export type RunnerWarmStatus =
  | "not_started"
  | "provisioning"
  | "ready"
  | "failed";
export type RunnerDispatchState =
  | "queued"
  | "dispatching"
  | "running"
  | "terminal";

export type RunnerAdmissionLimits = Readonly<{
  consecutiveDispatches: number;
  deploymentActiveRuns: number;
  tenantActiveRuns: number;
  tenantQueuedRuns: number;
}>;

export const DEFAULT_RUNNER_ADMISSION_LIMITS: RunnerAdmissionLimits = {
  consecutiveDispatches: 2,
  deploymentActiveRuns: 25,
  tenantActiveRuns: 2,
  tenantQueuedRuns: 10,
};

export type RunnerAgentRecord = {
  createdAt: Date;
  daytonaSandboxId: string | null;
  description: string;
  id: string;
  instructions: string;
  lastRunAt: Date | null;
  model: string;
  name: string;
  runtime: RunnerRuntime;
  sandboxGeneration: number;
  sandboxLifecycle: RunnerSandboxLifecycle;
  sandboxUpdatedAt: Date;
  status: RunnerAgentStatus;
  tenant: string;
  updatedAt: Date;
  version: number;
  warmAttemptVersion: number;
  warmStatus: RunnerWarmStatus;
  warmUpdatedAt: Date;
  workspace: string | null;
};

export type RunnerRunRecord = Omit<
  RunSnapshot,
  "apiVersion" | "completedAt" | "createdAt" | "error" | "startedAt"
> & {
  authVersion: number | null;
  cancellationRequestedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  daytonaCommandId: string | null;
  daytonaAttemptId: RunnerDaytonaAttemptId | null;
  daytonaSessionId: string | null;
  daytonaLogCursor: number;
  dispatchLeaseExpiresAt: Date | null;
  dispatchLeaseToken: string | null;
  dispatchState: RunnerDispatchState;
  error: RunError | null;
  logCursor: number;
  queueSequence: number;
  requestHash: string;
  startedAt: Date | null;
  tenant: string;
  version: number;
};

export type RunnerRunEventRecord = {
  createdAt: Date;
  event: RunEvent;
  eventId: number;
  runId: string;
};

/**
 * Server-only encrypted attempt material. It must never be nested in
 * RunnerRunRecord or any subscriber-facing projection.
 */
export type RunnerAttemptRedactionRecord = {
  aadVersion: number;
  attemptId: RunnerDaytonaAttemptId;
  ciphertext: string;
  createdAt: Date;
  iv: string;
  kekVersion: string;
  runId: string;
  wrappedKey: string;
};

export type PersistRunnerAttemptRedactionInput = Omit<
  RunnerAttemptRedactionRecord,
  "createdAt" | "runId"
>;

export type CreateRunnerAgentInput = {
  description?: string;
  id: string;
  instructions: string;
  model: string;
  name: string;
  runtime: RunnerRuntime;
  workspace?: string | null;
};

export type UpdateRunnerAgentInput = {
  description: string;
  expectedVersion: number;
  id: string;
  instructions: string;
  model: string;
  name: string;
  runtime: RunnerRuntime;
  workspace: string | null;
};

export type StartRunnerRunInput = {
  agentId: string;
  admission?: RunnerAdmissionLimits;
  authVersion: number;
  id: string;
  initialDispatch?: Pick<DispatchClaimInput, "leaseExpiresAt" | "leaseToken">;
  operationId: string;
  requestHash: string;
  task: string;
};

export type RunnerSnapshotPatch = {
  commandEvidence?: CommandEvidence[];
  fileEvidence?: FileEvidence[];
  output?: string;
};

type WithoutEventId<T> = T extends unknown ? Omit<T, "id"> : never;

export type DispatchFence = {
  expectedVersion: number;
  leaseToken: string;
  runId: string;
};

export type AppendRunnerEventInput = DispatchFence & {
  daytonaLogCursor?: number;
  event: WithoutEventId<RunEvent>;
  snapshot?: RunnerSnapshotPatch;
};

export type AppendRunnerEventBatchInput = DispatchFence & {
  daytonaLogCursor: number;
  events: readonly WithoutEventId<RunEvent>[];
  snapshot?: RunnerSnapshotPatch;
};

export type DispatchClaimInput = {
  leaseExpiresAt: Date;
  leaseToken: string;
  limits?: RunnerAdmissionLimits;
};

export type RunnerClaimedDispatch = Readonly<{
  authority: RunnerDispatchAuthority;
  run: RunnerRunRecord;
}>;

export type DispatchSandboxFence = {
  expectedGeneration: number;
  expectedVersion: number;
};

export type FinalizeRunnerRunInput = DispatchFence & {
  commandEvidence: CommandEvidence[];
  completedAt: Date;
  error?: RunError | null;
  fileEvidence: FileEvidence[];
  output: string;
  status: "completed" | "failed" | "cancelled";
};

export type ReserveDaytonaSandboxInput = {
  agentId: string;
  expectedGeneration: number;
  expectedSandboxId: string | null;
  expectedVersion: number;
  provisioningStaleBefore: Date;
};

export type DaytonaSandboxFence = {
  agentId: string;
  expectedGeneration: number;
  expectedVersion: number;
};

export type BeginDaytonaSandboxWarmInput = DaytonaSandboxFence;

export type BeginDaytonaSandboxDecommissionInput = {
  agentId: string;
  provisioningStaleBefore: Date;
};

export type ExpiredDispatchRequeueInput = {
  expectedDispatchState: Extract<
    RunnerDispatchState,
    "dispatching" | "running"
  >;
  oldLeaseToken: string;
  runId: string;
};

export type ExpiredDispatchLeaseAdoptionInput = ExpiredDispatchRequeueInput & {
  leaseExpiresAt: Date;
  newLeaseToken: string;
};

export type ReleaseDaytonaAttemptInput = {
  attemptId: RunnerDaytonaAttemptId;
};

export type ReleaseExpiredDaytonaAttemptInput = ExpiredDispatchRequeueInput & {
  attemptId: RunnerDaytonaAttemptId;
};

export type ClaimExpiredDaytonaAttemptCleanupInput =
  ReleaseExpiredDaytonaAttemptInput & {
    leaseExpiresAt: Date;
    newLeaseToken: string;
  };

export type ExpiredDaytonaAttemptCleanupClaim =
  | {
      authority: RunnerDispatchAuthority;
      kind: "claimed";
      run: RunnerRunRecord;
    }
  | { kind: "lease_lost" | "not_expired" | "not_found" | "not_live" };

export type AdoptExpiredDaytonaProcessInput =
  ClaimExpiredDaytonaAttemptCleanupInput;

export type ExpiredDaytonaProcessAdoption =
  | {
      authority: RunnerDispatchAuthority;
      kind: "adopted";
      run: RunnerRunRecord;
    }
  | { kind: "lease_lost" | "not_expired" | "not_found" | "not_live" };

export type ClaimTerminalDaytonaAttemptCleanupInput = {
  attemptId: RunnerDaytonaAttemptId;
  expectedVersion: number;
  leaseExpiresAt: Date;
  newLeaseToken: string;
  oldLeaseToken: string;
  runId: string;
};

export type TerminalDaytonaAttemptCleanupClaim =
  | {
      authority: RunnerDispatchAuthority;
      kind: "claimed";
      run: RunnerRunRecord;
    }
  | { kind: "lease_lost" | "not_expired" | "not_found" | "not_live" };

export type RequestRunnerCancellationInput = {
  leaseExpiresAt: Date;
  leaseToken: string;
  runId: string;
};

export type RunnerCancellationRequestOutcome =
  | {
      authority: RunnerDispatchAuthority;
      kind: "requested";
      run: RunnerRunRecord;
    }
  | { kind: "already_terminal"; run: RunnerRunRecord }
  | { kind: "in_progress" }
  | { kind: "not_found" };

export type RunnerMutationOutcome<T> =
  | { kind: "updated"; value: T }
  | { kind: "not_found" }
  | { kind: "stale_version" }
  | { kind: "lease_lost" }
  | { kind: "not_live" }
  | { kind: "generation_mismatch" };

export type ExpiredDispatchRecoveryOutcome =
  | { kind: "requeued"; value: RunnerRunRecord }
  | { kind: "adopted"; value: RunnerRunRecord }
  | { kind: "not_found" }
  | { kind: "lease_lost" }
  | { kind: "not_live" }
  | { kind: "provider_identifiers_attached" }
  | { attemptId: RunnerDaytonaAttemptId; kind: "cleanup_required" }
  | { kind: "not_expired" };
