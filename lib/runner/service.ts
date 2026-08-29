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
} from "./admission";
import { hashRunRequest, isTerminalRun } from "./evidence";
import type {
  CancelRunnerRunResult,
  RunnerReconciliationResult,
} from "./reconcile";
import type { RunnerStore } from "./store";
import type { RunnerAgentRecord, RunnerPrincipal } from "./types";

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
      error: "non_retryable" | "retryable";
      kind: "failed";
    }>;

export type RunnerWarmSandboxResult =
  | Readonly<{ agent: RunnerAgentRecord; kind: "ready" }>
  | Readonly<{ kind: "in_progress" }>
  | Readonly<{ error: "non_retryable" | "retryable"; kind: "failed" }>;

export type RunnerDiagnosticResult = Readonly<{
  exitCode: number;
  ok: boolean;
  output: string;
}>;

export type RunnerServiceErrorCode =
  | "diagnostic_unavailable"
  | "reconcile_unavailable"
  | "service_unavailable";

/**
 * A deliberately message-safe error for adapters whose original failure can
 * contain a provider URL, credential, or database detail.
 */
export class RunnerServiceError extends Error {
  readonly code: RunnerServiceErrorCode;
  readonly retryable: boolean;

  constructor(
    code: RunnerServiceErrorCode,
    message: string,
    retryable = true,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.name = "RunnerServiceError";
    this.retryable = retryable;
  }
}

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
  listHarnesses?: () => Promise<readonly HarnessStatus[]>;
  reconcileAndDispatch?: () => Promise<RunnerReconciliationResult>;
  store: RunnerServiceStore;
  warmSandbox?: (
    principal: RunnerPrincipal,
    agent: RunnerAgentRecord
  ) => Promise<RunnerWarmSandboxResult>;
}>;

export type RunnerCreateAgentResult =
  | Readonly<{ agent: AgentDefinition; kind: "created" }>
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "unsupported_harness" }>;

export type RunnerReadAgentResult =
  | Readonly<{ agent: AgentDefinition; kind: "found" }>
  | Readonly<{ kind: "not_found" }>;

export type RunnerUpdateAgentResult =
  | Readonly<{ agent: AgentDefinition; kind: "updated" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "lifecycle_conflict" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale_version" }>
  | Readonly<{ kind: "unsupported_harness" }>;

export type RunnerDeleteResult =
  | Readonly<{ kind: "deleted" }>
  | Readonly<{ kind: "busy" | "not_found" | "stale_version" }>
  | Readonly<{ kind: "provider_failure"; retryable: boolean }>;

export type RunnerListRunsResult =
  | Readonly<{ kind: "found"; runs: readonly RunSnapshot[] }>
  | Readonly<{ kind: "not_found" }>;

export type RunnerStartResult =
  | Readonly<{ kind: "accepted"; run: RunSnapshot }>
  | Readonly<{ kind: "not_found" }>
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
      run: RunSnapshot;
      scheduleReconciliation: true;
    }>
  | Readonly<{
      kind: "not_found";
    }>
  | Readonly<{
      kind: "stopped";
      run: RunSnapshot;
      scheduleReconciliation: true;
    }>;

export type RunnerPrewarmResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ agentId: string; kind: "warmed"; warm: WarmState }>;

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
    principal: RunnerPrincipal
  ) => Promise<RunnerPrewarmResult>;
  readRunEvents: (
    principal: RunnerPrincipal,
    runId: string,
    afterEventId: number
  ) => Promise<RunnerEventPageResult>;
  reconcileAndDispatch: () => Promise<RunnerReconciliationResult>;
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
  ) => Promise<
    RunnerReadAgentResult | Readonly<{ kind: "warmed"; warm: WarmState }>
  >;
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
  result: RunnerWarmSandboxResult,
  clock: () => Date
): WarmState {
  if (result.kind === "ready") {
    return warmStateSchema.parse({
      status: result.agent.warmStatus,
      updatedAt: result.agent.warmUpdatedAt.toISOString(),
    });
  }
  return warmStateSchema.parse({
    status: result.kind === "in_progress" ? "provisioning" : "failed",
    updatedAt: clock().toISOString(),
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
  const clock = dependencies.clock ?? (() => new Date());
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
  ): Promise<
    RunnerReadAgentResult | Readonly<{ kind: "warmed"; warm: WarmState }>
  > {
    if (!validId(agentId)) {
      return { kind: "not_found" };
    }
    const agent = await dependencies.store.getAgent(principal, agentId);
    if (!agent) {
      return { kind: "not_found" };
    }
    if (!dependencies.warmSandbox) {
      throw configuredError("sandbox warming");
    }
    const result = await dependencies.warmSandbox(principal, agent);
    return { kind: "warmed", warm: projectWarm(result, clock) };
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
      const created = await dependencies.store.createAgent(principal, {
        ...parsed.value,
        id,
        workspace: parsed.value.workspace ?? null,
      });
      return created.kind === "created"
        ? { agent: projectAgent(created.agent), kind: "created" }
        : { kind: "conflict" };
    },

    deleteAgent: async (principal, agentId) => {
      if (!validId(agentId)) {
        return { kind: "not_found" };
      }
      if (!dependencies.deleteSandbox) {
        throw configuredError("agent deletion");
      }
      const deleted = await dependencies.deleteSandbox(principal, agentId);
      if (deleted.kind === "deleted") {
        return { kind: "deleted" };
      }
      if (deleted.kind === "not_found") {
        return { kind: "not_found" };
      }
      if (deleted.kind === "busy" || deleted.kind === "stale_version") {
        return deleted;
      }
      return {
        kind: "provider_failure",
        retryable: deleted.error === "retryable",
      };
    },

    diagnoseSandbox: () => {
      if (!dependencies.diagnoseSandbox) {
        throw configuredError("diagnostic");
      }
      return dependencies.diagnoseSandbox();
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

    prewarmMostRecent: async (principal) => {
      const agents = await dependencies.store.listAgents(principal);
      const [target] = [...agents].sort(newerAgent);
      if (!target) {
        return { kind: "none" };
      }
      if (!dependencies.warmSandbox) {
        throw configuredError("sandbox warming");
      }
      let result: RunnerWarmSandboxResult;
      try {
        result = await dependencies.warmSandbox(principal, target);
      } catch {
        result = { error: "retryable", kind: "failed" };
      }
      return {
        agentId: target.id,
        kind: "warmed",
        warm: projectWarm(result, clock),
      };
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
      const id = createId();
      if (!validId(id)) {
        throw configuredError("run creation");
      }
      const admitted = await admit({
        agentId,
        authVersion,
        id,
        operationId: parsed.data.operationId,
        principal,
        requestHash: hashRunRequest(agentId, parsed.data.task),
        task: parsed.data.task,
      });
      if (
        admitted.kind === "created" ||
        admitted.kind === "duplicate" ||
        admitted.kind === "claimed"
      ) {
        return { kind: "accepted", run: requireSnapshot(admitted.run) };
      }
      if (admitted.kind === "refused") {
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
          case "global_busy":
          case "tenant_queue_full":
            return { code: "busy", kind: "refused", retryable: true };
          default:
            throw configuredError("run admission");
        }
      }
      throw configuredError("run admission");
    },

    stopRun: async (principal, runId) => {
      if (!validId(runId)) {
        return { kind: "not_found" };
      }
      // The tenant-scoped read is required before cancellation, whose
      // orchestration primitive intentionally holds operator authority.
      const owned = await dependencies.store.getRun(principal, runId);
      if (!owned) {
        return { kind: "not_found" };
      }
      if (!dependencies.cancelRun) {
        throw configuredError("cancellation");
      }
      const outcome = await dependencies.cancelRun(runId);
      if (outcome.kind === "not_found") {
        return { kind: "not_found" };
      }
      const current = await dependencies.store.getRun(principal, runId);
      if (!current) {
        return { kind: "not_found" };
      }
      const run = requireSnapshot(current);
      return outcome.kind === "cleanup_required" ||
        outcome.kind === "sandbox_reset_required"
        ? { kind: "cleanup_required", run, scheduleReconciliation: true }
        : { kind: "stopped", run, scheduleReconciliation: true };
    },

    updateAgent: async (principal, agentId, input) => {
      if (!validId(agentId)) {
        return { kind: "not_found" };
      }
      const parsed = parsedDefinition(input);
      if (parsed.kind !== "ok") {
        return parsed;
      }
      const current = await dependencies.store.getAgent(principal, agentId);
      if (!current) {
        return { kind: "not_found" };
      }
      const updated = await dependencies.store.updateAgent(principal, {
        ...parsed.value,
        expectedVersion: current.version,
        id: agentId,
        workspace: parsed.value.workspace ?? null,
      });
      if (updated.kind === "updated") {
        return { agent: projectAgent(updated.value), kind: "updated" };
      }
      return updated;
    },

    warmAgent,
  };
}
