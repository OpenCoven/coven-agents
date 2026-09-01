import "server-only";

import { randomUUID } from "node:crypto";
import {
  type AgentDefinition,
  agentDefinitionSchema,
  agentIdSchema,
  createAgentInputSchema,
  type RunEvent,
  type RunSnapshot,
  runEventSchema,
  runSnapshotSchema,
  startRunInputSchema,
  type WarmState,
  warmStateSchema,
} from "@opencoven/agent-contracts";
import {
  type HarnessStatus,
  harnessesEnvelopeSchema,
  isRunnableHarness,
} from "@opencoven/harness";
import {
  type AdmitRunnerRunResult,
  admitRunnerRun,
  type RunnerAdmissionLimits,
  type RunnerDispatchResult,
} from "./admission";
import type {
  CancelRunnerRunResult,
  RunnerReconciliationExecutionResult,
} from "./attempt-reconcile";
import { RunnerServiceError } from "./errors";
import { hashRunRequest, isTerminalRun } from "./evidence";
import type { RunnerStore } from "./store";
import type {
  RunnerAgentRecord,
  RunnerClaimedDispatch,
  RunnerPrincipal,
} from "./types";

type RunnerServiceStore = Pick<
  RunnerStore,
  | "createAgent"
  | "getAgent"
  | "getRun"
  | "listAgentRuns"
  | "listAgents"
  | "readEventsAfter"
  | "startRun"
  | "updateAgent"
>;

export type RunnerDeleteAgentResult =
  | Readonly<{ kind: "deleted" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale_version" }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>
  | Readonly<{ kind: "provider_rejected" }>;

export type RunnerWarmSandboxResult =
  | Readonly<{ agent: RunnerAgentRecord; kind: "ready" }>
  | Readonly<{ agent: RunnerAgentRecord; kind: "in_progress" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale_version" }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>
  | Readonly<{ kind: "provider_rejected" }>;

export type RunnerDiagnosticResult = Readonly<{
  exitCode: number;
  ok: boolean;
  output: string;
}>;

export {
  RunnerServiceError,
  type RunnerServiceErrorCode,
} from "./errors";

export type RunnerServiceDependencies = Readonly<{
  admit?: (
    input: Parameters<typeof admitRunnerRun>[0]
  ) => Promise<AdmitRunnerRunResult>;
  admissionLimits?: RunnerAdmissionLimits;
  cancelRun?: (runId: string) => Promise<CancelRunnerRunResult>;
  clock?: () => Date;
  createId?: () => string;
  deleteSandbox?: (
    principal: RunnerPrincipal,
    agentId: string
  ) => Promise<RunnerDeleteAgentResult>;
  diagnoseSandbox?: () => Promise<RunnerDiagnosticResult>;
  dispatchClaim?: (
    claimed: RunnerClaimedDispatch
  ) => Promise<RunnerDispatchResult>;
  listHarnesses?: () => Promise<readonly HarnessStatus[]>;
  reconcileAndDispatch?: () => Promise<RunnerReconciliationExecutionResult>;
  store: RunnerServiceStore;
  warmSandbox?: (
    principal: RunnerPrincipal,
    agent: RunnerAgentRecord,
    options?: RunnerPrewarmOptions
  ) => Promise<RunnerWarmSandboxResult>;
}>;

export type RunnerPrewarmOptions = Readonly<{
  deadline?: number;
  signal?: AbortSignal;
}>;

export type RunnerCreateAgentResult =
  | Readonly<{ agent: AgentDefinition; kind: "created" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "unavailable"; source: "database" }>
  | Readonly<{ kind: "unsupported_harness" }>;

export type RunnerReadAgentResult =
  | Readonly<{ agent: AgentDefinition; kind: "found" }>
  | Readonly<{ kind: "not_found" }>;

export type RunnerUpdateAgentResult =
  | Readonly<{ agent: AgentDefinition; kind: "updated" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale_version" }>
  | Readonly<{ kind: "unavailable"; source: "database" }>
  | Readonly<{ kind: "unsupported_harness" }>;

export type RunnerDeleteResult = RunnerDeleteAgentResult;

export type RunnerListRunsResult =
  | Readonly<{ kind: "found"; runs: readonly RunSnapshot[] }>
  | Readonly<{ kind: "not_found" }>;

export type RunnerStartResult =
  | Readonly<{
      admission: "claimed";
      claimed: RunnerClaimedDispatch;
      kind: "accepted";
      run: RunSnapshot;
    }>
  | Readonly<{
      admission: "created" | "duplicate";
      kind: "accepted";
      run: RunSnapshot;
    }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "unsupported_harness" }>
  | Readonly<{
      code:
        | "admission_unavailable"
        | "busy"
        | "lifecycle_conflict"
        | "operation_conflict";
      kind: "refused";
      retryable: boolean;
    }>
  | Readonly<{ kind: "invalid" }>;

export type RunnerScheduledStartResult =
  | Readonly<{ kind: "accepted"; run: RunSnapshot }>
  | Exclude<RunnerStartResult, { kind: "accepted" }>;

export type RunnerReadRunResult =
  | Readonly<{ kind: "found"; run: RunSnapshot }>
  | Readonly<{ kind: "not_found" }>;

export type RunnerEventPageResult =
  | Readonly<{
      events: readonly RunEvent[];
      kind: "found";
      terminal: boolean;
    }>
  | Readonly<{ kind: "not_found" }>;

export type RunnerStopResult =
  | Readonly<{
      kind: "cleanup_required";
      scheduleReconciliation: true;
    }>
  | Readonly<{
      kind: "not_found";
    }>
  | Readonly<{
      kind: "in_progress";
      run: RunSnapshot;
      scheduleReconciliation: true;
    }>
  | Readonly<{
      kind: "sandbox_reset_required";
      scheduleReconciliation: true;
    }>
  | Readonly<{
      kind: "stopped";
      run: RunSnapshot;
      scheduleReconciliation: true;
    }>
  | Readonly<{ kind: "stale_version" }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>;

export type RunnerPrewarmResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      agentId: string;
      kind: "ready" | "in_progress";
      warm: WarmState;
    }>
  | Readonly<{ kind: "not_found" | "stale_version" }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>
  | Readonly<{ kind: "unsupported_harness" }>
  | Readonly<{ kind: "provider_rejected" }>;

export type RunnerWarmResult =
  | RunnerReadAgentResult
  | Readonly<{ kind: "ready" | "in_progress"; warm: WarmState }>
  | Readonly<{ kind: "stale_version" }>
  | Readonly<{
      kind: "unavailable";
      source: "database" | "provider";
    }>
  | Readonly<{ kind: "unsupported_harness" }>
  | Readonly<{ kind: "provider_rejected" }>;

export type RunnerService = Readonly<{
  createAgent: (
    principal: RunnerPrincipal,
    input: unknown
  ) => Promise<RunnerCreateAgentResult>;
  deleteAgent: (
    principal: RunnerPrincipal,
    agentId: string
  ) => Promise<RunnerDeleteResult>;
  diagnoseSandbox: () => Promise<RunnerDiagnosticResult>;
  dispatchClaim: (
    claimed: RunnerClaimedDispatch
  ) => Promise<RunnerDispatchResult>;
  getAgent: (
    principal: RunnerPrincipal,
    agentId: string
  ) => Promise<RunnerReadAgentResult>;
  getRun: (
    principal: RunnerPrincipal,
    runId: string
  ) => Promise<RunnerReadRunResult>;
  listAgentRuns: (
    principal: RunnerPrincipal,
    agentId: string
  ) => Promise<RunnerListRunsResult>;
  listAgents: (
    principal: RunnerPrincipal
  ) => Promise<readonly AgentDefinition[]>;
  listHarnesses: () => Promise<readonly HarnessStatus[]>;
  prewarmMostRecent: (
    principal: RunnerPrincipal,
    options?: RunnerPrewarmOptions
  ) => Promise<RunnerPrewarmResult>;
  readRunEvents: (
    principal: RunnerPrincipal,
    runId: string,
    afterEventId: number
  ) => Promise<RunnerEventPageResult>;
  reconcileAndDispatch: () => Promise<RunnerReconciliationExecutionResult>;
  startRun: (
    principal: RunnerPrincipal,
    authVersion: number,
    agentId: string,
    input: unknown
  ) => Promise<RunnerStartResult>;
  stopRun: (
    principal: RunnerPrincipal,
    runId: string
  ) => Promise<RunnerStopResult>;
  updateAgent: (
    principal: RunnerPrincipal,
    agentId: string,
    input: unknown
  ) => Promise<RunnerUpdateAgentResult>;
  warmAgent: (
    principal: RunnerPrincipal,
    agentId: string
  ) => Promise<RunnerWarmResult>;
}>;

function projectAgent(record: RunnerAgentRecord): AgentDefinition {
  return agentDefinitionSchema.parse({
    backend: "cloud",
    createdAt: record.createdAt.toISOString(),
    description: record.description,
    id: record.id,
    instructions: record.instructions,
    lastRunAt: record.lastRunAt?.toISOString() ?? null,
    model: record.model,
    name: record.name,
    owner: { kind: "tenant", tenantId: record.tenant },
    runtime: record.runtime,
    status: record.status,
    updatedAt: record.updatedAt.toISOString(),
    warm: {
      status: record.warmStatus,
      updatedAt: record.warmUpdatedAt.toISOString(),
    },
  });
}

function projectWarm(
  result: Extract<RunnerWarmSandboxResult, { kind: "in_progress" | "ready" }>
): WarmState {
  return warmStateSchema.parse({
    status: result.agent.warmStatus,
    updatedAt: result.agent.warmUpdatedAt.toISOString(),
  });
}

function configuredError(operation: string): RunnerServiceError {
  return new RunnerServiceError(
    "service_unavailable",
    `Runner ${operation} is unavailable.`
  );
}

function validId(value: string): boolean {
  return agentIdSchema.safeParse(value).success;
}

function unreachable(_value: never, operation: string): never {
  throw new RunnerServiceError(
    "service_unavailable",
    `Runner ${operation} returned an unsupported outcome.`
  );
}

function parsedDefinition(input: unknown):
  | { kind: "invalid" }
  | {
      kind: "ok";
      value: {
        backend: "cloud";
        description: string;
        instructions: string;
        model: string;
        name: string;
        runtime: "claude" | "codex" | "copilot";
        workspace?: string;
      };
    }
  | { kind: "unsupported_harness" } {
  const parsed = createAgentInputSchema.safeParse(input);
  if (!parsed.success) {
    return { kind: "invalid" };
  }
  if (!isRunnableHarness(parsed.data.runtime)) {
    return { kind: "unsupported_harness" };
  }
  return {
    kind: "ok",
    value: {
      ...parsed.data,
      runtime: parsed.data.runtime,
    },
  };
}

function requireSnapshot(snapshot: RunSnapshot): RunSnapshot {
  return runSnapshotSchema.parse(snapshot);
}

function newerAgent(left: RunnerAgentRecord, right: RunnerAgentRecord): number {
  const leftAt = left.lastRunAt ?? left.updatedAt;
  const rightAt = right.lastRunAt ?? right.updatedAt;
  return (
    rightAt.getTime() - leftAt.getTime() || right.id.localeCompare(left.id)
  );
}

export function createRunnerService(
  dependencies: RunnerServiceDependencies
): RunnerService {
  const createId = dependencies.createId ?? randomUUID;
  const admit =
    dependencies.admit ??
    ((input) =>
      admitRunnerRun(input, {
        limits: dependencies.admissionLimits,
        store: dependencies.store as unknown as Parameters<
          typeof admitRunnerRun
        >[1]["store"],
      }));

  async function getAgent(
    principal: RunnerPrincipal,
    agentId: string
  ): Promise<RunnerReadAgentResult> {
    if (!validId(agentId)) {
      return { kind: "not_found" };
    }
    const agent = await dependencies.store.getAgent(principal, agentId);
    return agent
      ? { agent: projectAgent(agent), kind: "found" }
      : { kind: "not_found" };
  }

  async function warmAgent(
    principal: RunnerPrincipal,
    agentId: string
  ): Promise<RunnerWarmResult> {
    if (!validId(agentId)) {
      return { kind: "not_found" };
    }
    let agent: RunnerAgentRecord | null;
    try {
      agent = await dependencies.store.getAgent(principal, agentId);
    } catch {
      return { kind: "unavailable", source: "database" };
    }
    if (!agent) {
      return { kind: "not_found" };
    }
    if (!isRunnableHarness(agent.runtime)) {
      return { kind: "unsupported_harness" };
    }
    if (!dependencies.warmSandbox) {
      throw configuredError("sandbox warming");
    }
    let result: RunnerWarmSandboxResult;
    try {
      result = await dependencies.warmSandbox(principal, agent);
    } catch {
      return { kind: "unavailable", source: "provider" };
    }
    switch (result.kind) {
      case "ready":
      case "in_progress":
        return { kind: result.kind, warm: projectWarm(result) };
      case "not_found":
      case "stale_version":
      case "provider_rejected":
        return result;
      case "unavailable":
        return result;
      default:
        return unreachable(result, "sandbox warming");
    }
  }

  return {
    createAgent: async (principal, input) => {
      const parsed = parsedDefinition(input);
      if (parsed.kind !== "ok") {
        return parsed;
      }
      const id = createId();
      if (!validId(id)) {
        throw configuredError("agent creation");
      }
      let created: Awaited<ReturnType<RunnerServiceStore["createAgent"]>>;
      try {
        created = await dependencies.store.createAgent(principal, {
          ...parsed.value,
          id,
          workspace: parsed.value.workspace ?? null,
        });
      } catch {
        return { kind: "unavailable", source: "database" };
      }
      switch (created.kind) {
        case "created":
          return { agent: projectAgent(created.agent), kind: "created" };
        case "conflict":
          return { kind: "conflict" };
        default:
          return unreachable(created, "agent creation");
      }
    },

    deleteAgent: async (principal, agentId) => {
      if (!validId(agentId)) {
        return { kind: "not_found" };
      }
      if (!dependencies.deleteSandbox) {
        throw configuredError("agent deletion");
      }
      let deleted: RunnerDeleteAgentResult;
      try {
        deleted = await dependencies.deleteSandbox(principal, agentId);
      } catch {
        return { kind: "unavailable", source: "provider" };
      }
      switch (deleted.kind) {
        case "deleted":
        case "not_found":
        case "busy":
        case "stale_version":
        case "unavailable":
        case "provider_rejected":
          return deleted;
        default:
          return unreachable(deleted, "agent deletion");
      }
    },

    diagnoseSandbox: () => {
      if (!dependencies.diagnoseSandbox) {
        throw configuredError("diagnostic");
      }
      return dependencies.diagnoseSandbox();
    },

    dispatchClaim: (claimed) => {
      if (!dependencies.dispatchClaim) {
        throw configuredError("dispatch");
      }
      return dependencies.dispatchClaim(claimed);
    },

    getAgent,

    getRun: async (principal, runId) => {
      if (!validId(runId)) {
        return { kind: "not_found" };
      }
      const run = await dependencies.store.getRun(principal, runId);
      return run
        ? { kind: "found", run: requireSnapshot(run) }
        : { kind: "not_found" };
    },

    listAgentRuns: async (principal, agentId) => {
      if (!validId(agentId)) {
        return { kind: "not_found" };
      }
      const agent = await dependencies.store.getAgent(principal, agentId);
      if (!agent) {
        return { kind: "not_found" };
      }
      const runs = await dependencies.store.listAgentRuns(principal, agentId);
      return { kind: "found", runs: runs.map(requireSnapshot) };
    },

    listAgents: async (principal) =>
      (await dependencies.store.listAgents(principal)).map(projectAgent),

    listHarnesses: async () => {
      if (!dependencies.listHarnesses) {
        throw configuredError("harness discovery");
      }
      const harnesses = await dependencies.listHarnesses();
      return harnessesEnvelopeSchema.parse({ harnesses }).harnesses;
    },

    prewarmMostRecent: async (principal, options) => {
      let agents: RunnerAgentRecord[];
      try {
        agents = await dependencies.store.listAgents(principal);
      } catch {
        return { kind: "unavailable", source: "database" };
      }
      const [target] = [...agents].sort(newerAgent);
      if (!target) {
        return { kind: "none" };
      }
      if (!isRunnableHarness(target.runtime)) {
        return { kind: "unsupported_harness" };
      }
      if (!dependencies.warmSandbox) {
        throw configuredError("sandbox warming");
      }
      let result: RunnerWarmSandboxResult;
      try {
        result = await dependencies.warmSandbox(principal, target, options);
      } catch {
        return { kind: "unavailable", source: "provider" };
      }
      switch (result.kind) {
        case "ready":
        case "in_progress":
          return {
            agentId: target.id,
            kind: result.kind,
            warm: projectWarm(result),
          };
        case "not_found":
        case "stale_version":
        case "unavailable":
        case "provider_rejected":
          return result;
        default:
          return unreachable(result, "tenant prewarming");
      }
    },

    readRunEvents: async (principal, runId, afterEventId) => {
      if (
        !validId(runId) ||
        !Number.isSafeInteger(afterEventId) ||
        afterEventId < 0
      ) {
        return { kind: "not_found" };
      }
      const run = await dependencies.store.getRun(principal, runId);
      if (!run) {
        return { kind: "not_found" };
      }
      const events = await dependencies.store.readEventsAfter(
        principal,
        runId,
        afterEventId
      );
      return {
        events: events.map((entry) => runEventSchema.parse(entry.event)),
        kind: "found",
        terminal: isTerminalRun(run.status),
      };
    },

    reconcileAndDispatch: () => {
      if (!dependencies.reconcileAndDispatch) {
        throw configuredError("reconciliation");
      }
      return dependencies.reconcileAndDispatch();
    },

    startRun: async (principal, authVersion, agentId, input) => {
      if (!validId(agentId)) {
        return { kind: "invalid" };
      }
      const parsed = startRunInputSchema.safeParse(input);
      if (!parsed.success) {
        return { kind: "invalid" };
      }
      let agent: RunnerAgentRecord | null;
      try {
        agent = await dependencies.store.getAgent(principal, agentId);
      } catch {
        return {
          code: "admission_unavailable",
          kind: "refused",
          retryable: true,
        };
      }
      if (!agent) {
        return { kind: "not_found" };
      }
      if (!isRunnableHarness(agent.runtime)) {
        return { kind: "unsupported_harness" };
      }
      const id = createId();
      if (!validId(id)) {
        throw configuredError("run creation");
      }
      let admitted: AdmitRunnerRunResult;
      try {
        admitted = await admit({
          agentId,
          authVersion,
          id,
          operationId: parsed.data.operationId,
          principal,
          requestHash: hashRunRequest(agentId, parsed.data.task),
          task: parsed.data.task,
        });
      } catch {
        return {
          code: "admission_unavailable",
          kind: "refused",
          retryable: true,
        };
      }
      switch (admitted.kind) {
        case "claimed":
          return {
            admission: "claimed",
            claimed: admitted.claimed,
            kind: "accepted",
            run: requireSnapshot(admitted.run),
          };
        case "created":
          return {
            admission: "created",
            kind: "accepted",
            run: requireSnapshot(admitted.run),
          };
        case "duplicate":
          return {
            admission: "duplicate",
            kind: "accepted",
            run: requireSnapshot(admitted.run),
          };
        case "refused":
          switch (admitted.error.code) {
            case "agent_not_found":
              return { kind: "not_found" };
            case "operation_conflict":
              return {
                code: "operation_conflict",
                kind: "refused",
                retryable: false,
              };
            case "admission_unavailable":
              return {
                code: "admission_unavailable",
                kind: "refused",
                retryable: true,
              };
            case "sandbox_unavailable":
              return {
                code: "lifecycle_conflict",
                kind: "refused",
                retryable: true,
              };
            case "sandbox_trust_conflict":
              return {
                code: "lifecycle_conflict",
                kind: "refused",
                retryable: false,
              };
            case "global_busy":
            case "tenant_queue_full":
              return { code: "busy", kind: "refused", retryable: true };
            default:
              return unreachable(admitted.error.code, "run admission");
          }
        default:
          return unreachable(admitted, "run admission");
      }
    },

    stopRun: async (principal, runId) => {
      if (!validId(runId)) {
        return { kind: "not_found" };
      }
      // The tenant-scoped read is required before cancellation, whose
      // orchestration primitive intentionally holds operator authority.
      let owned: RunSnapshot | null;
      try {
        owned = await dependencies.store.getRun(principal, runId);
      } catch {
        return { kind: "unavailable", source: "database" };
      }
      if (!owned) {
        return { kind: "not_found" };
      }
      if (!dependencies.cancelRun) {
        throw configuredError("cancellation");
      }
      const outcome = await dependencies.cancelRun(runId);
      switch (outcome.kind) {
        case "not_found":
          return { kind: "not_found" };
        case "stale_version":
          return { kind: "stale_version" };
        case "unavailable":
          return { kind: "unavailable", source: outcome.source };
        case "in_progress":
        case "already_terminal":
        case "cancelled":
        case "cleanup_required":
        case "sandbox_reset_required":
          break;
        default:
          return unreachable(outcome, "run cancellation");
      }
      let current: RunSnapshot | null;
      try {
        current = await dependencies.store.getRun(principal, runId);
      } catch {
        return { kind: "unavailable", source: "database" };
      }
      if (!current) {
        return { kind: "not_found" };
      }
      const run = requireSnapshot(current);
      const outcomeKind = outcome.kind;
      switch (outcomeKind) {
        case "in_progress":
          return {
            kind: "in_progress",
            run,
            scheduleReconciliation: true,
          };
        case "cleanup_required":
          return {
            kind: "cleanup_required",
            scheduleReconciliation: true,
          };
        case "sandbox_reset_required":
          return {
            kind: "sandbox_reset_required",
            scheduleReconciliation: true,
          };
        case "already_terminal":
        case "cancelled":
          if (
            run.completedAt === null ||
            run.status === "queued" ||
            run.status === "running"
          ) {
            return {
              kind: "cleanup_required",
              scheduleReconciliation: true,
            };
          }
          return { kind: "stopped", run, scheduleReconciliation: true };
        default:
          return unreachable(outcomeKind, "run cancellation");
      }
    },

    updateAgent: async (principal, agentId, input) => {
      if (!validId(agentId)) {
        return { kind: "not_found" };
      }
      const parsed = parsedDefinition(input);
      if (parsed.kind !== "ok") {
        return parsed;
      }
      let current: RunnerAgentRecord | null;
      try {
        current = await dependencies.store.getAgent(principal, agentId);
      } catch {
        return { kind: "unavailable", source: "database" };
      }
      if (!current) {
        return { kind: "not_found" };
      }
      let updated: Awaited<ReturnType<RunnerServiceStore["updateAgent"]>>;
      try {
        updated = await dependencies.store.updateAgent(principal, {
          ...parsed.value,
          expectedVersion: current.version,
          id: agentId,
          workspace: parsed.value.workspace ?? null,
        });
      } catch {
        return { kind: "unavailable", source: "database" };
      }
      switch (updated.kind) {
        case "updated":
          return { agent: projectAgent(updated.value), kind: "updated" };
        case "busy":
        case "not_found":
        case "stale_version":
          return updated;
        default:
          return unreachable(updated, "agent update");
      }
    },

    warmAgent,
  };
}
