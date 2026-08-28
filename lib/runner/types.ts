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
 * Authority used by the scheduler, cron reconciliation, and Daytona worker.
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

export type RunnerRuntime = "cloud" | "codex" | "claude" | "copilot";
export type RunnerAgentStatus = "idle" | "running" | "error";
export type RunnerSandboxLifecycle =
  | "unprovisioned"
  | "provisioning"
  | "provisioning_ambiguous"
  | "ready"
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
  warmStatus: RunnerWarmStatus;
  warmUpdatedAt: Date;
  workspace: string | null;
};

export type RunnerRunRecord = Omit<
  RunSnapshot,
  "apiVersion" | "completedAt" | "createdAt" | "error" | "startedAt"
> & {
  completedAt: Date | null;
  createdAt: Date;
  daytonaCommandId: string | null;
  daytonaAttemptId: RunnerDaytonaAttemptId | null;
  daytonaSessionId: string | null;
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
  id: string;
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
  event: WithoutEventId<RunEvent>;
  snapshot?: RunnerSnapshotPatch;
};

export type DispatchClaimInput = {
  leaseExpiresAt: Date;
  leaseToken: string;
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

export type BeginDaytonaSandboxWarmInput = DaytonaSandboxFence & {
  warmStaleBefore: Date;
};

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
