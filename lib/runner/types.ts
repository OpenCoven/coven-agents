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

export type RunnerRuntime = "cloud" | "codex" | "claude" | "copilot";
export type RunnerAgentStatus = "idle" | "running" | "error";
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
  status: RunnerAgentStatus;
  tenant: string;
  updatedAt: Date;
  warmStatus: RunnerWarmStatus;
  warmUpdatedAt: Date;
  workspace: string | null;
};

export type RunnerRunRecord = Omit<
  RunSnapshot,
  "completedAt" | "createdAt" | "startedAt"
> & {
  completedAt: Date | null;
  createdAt: Date;
  daytonaCommandId: string | null;
  daytonaSessionId: string | null;
  dispatchLeaseExpiresAt: Date | null;
  dispatchLeaseToken: string | null;
  dispatchState: RunnerDispatchState;
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
  expectedUpdatedAt: Date;
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

export type AppendRunnerEventInput = {
  event: WithoutEventId<RunEvent>;
  expectedVersion: number;
  leaseToken: string;
  runId: string;
  snapshot?: RunnerSnapshotPatch;
};

export type DispatchClaimInput = {
  leaseExpiresAt: Date;
  leaseToken: string;
  now: Date;
};

export type DispatchFence = {
  expectedVersion: number;
  leaseToken: string;
  now: Date;
  runId: string;
};

export type AttachDaytonaIdentifiersInput = DispatchFence & {
  sandboxGeneration: number;
  sandboxId?: string;
} & (
    | { commandId: string; sessionId: string }
    | { commandId?: undefined; sessionId?: string }
  );

export type FinalizeRunnerRunInput = DispatchFence & {
  commandEvidence: CommandEvidence[];
  completedAt: Date;
  error?: RunError | null;
  fileEvidence: FileEvidence[];
  output: string;
  status: "completed" | "failed" | "cancelled";
};

export type RunnerMutationOutcome<T> =
  | { kind: "updated"; value: T }
  | { kind: "not_found" }
  | { kind: "stale_version" }
  | { kind: "lease_lost" }
  | { kind: "generation_mismatch" };
