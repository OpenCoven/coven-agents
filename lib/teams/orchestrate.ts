// biome-ignore-all lint/performance/noAwaitInLoops: Team claims, attachments, cancellations, and projections are intentionally serialized.
import "server-only";

import type { TeamCapability } from "@opencoven/agent-contracts";
import type {
  AdmitRunnerRunInput,
  AdmitRunnerRunResult,
} from "@/lib/runner/admission";
import { hashRunRequest } from "@/lib/runner/evidence";
import type {
  RunnerClaimedDispatch,
  RunnerOperator,
  RunnerPrincipal,
} from "@/lib/runner/types";
import type { TeamChildRunnerIds } from "./child-ids";
import type { createTeamStore } from "./store";
import { buildTeamStepTask, type GitHubCapability } from "./task";

export { type TeamChildRunnerIds, teamChildRunnerIds } from "./child-ids";

const DEFAULT_RECONCILIATION_LIMIT = 20;
const MAX_RECONCILIATION_LIMIT = 100;

type TeamOrchestrationStore = Pick<
  ReturnType<typeof createTeamStore>,
  | "attachTeamStepRunnerRun"
  | "claimNextTeamStep"
  | "failTeamStepAdmission"
  | "findNextCancelledTeamChild"
  | "projectNextTerminalTeamStep"
>;

export type TeamClaimReconciliationResult = Readonly<{
  admitted: number;
  claimedDispatches: readonly RunnerClaimedDispatch[];
  deferred: number;
  failures: number;
  waitingApproval: number;
}>;

export type TeamProjectionReconciliationResult = Readonly<{
  cancellationDeferred: number;
  cancellationRequested: number;
  failures: number;
  projected: number;
}>;

export type TeamOrchestratorDependencies = Readonly<{
  admit: (input: AdmitRunnerRunInput) => Promise<AdmitRunnerRunResult>;
  cancelRun: (
    principal: RunnerPrincipal,
    runId: string
  ) => Promise<Readonly<{ kind: string }>>;
  limit?: number;
  operator: RunnerOperator;
  store: TeamOrchestrationStore;
}>;

function reconciliationLimit(value: number | undefined): number {
  const resolved = value ?? DEFAULT_RECONCILIATION_LIMIT;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_RECONCILIATION_LIMIT
  ) {
    throw new Error(
      `Team reconciliation limit must be an integer between 1 and ${MAX_RECONCILIATION_LIMIT}.`
    );
  }
  return resolved;
}

function githubCapabilityMode(
  capabilities: readonly TeamCapability[]
): GitHubCapability {
  if (
    capabilities.some(
      (capability) =>
        capability.startsWith("github.") && capability.endsWith(".write")
    )
  ) {
    return "write";
  }
  return capabilities.some((capability) => capability.startsWith("github."))
    ? "read"
    : "none";
}

export function createTeamOrchestrator(
  dependencies: TeamOrchestratorDependencies
) {
  const limit = reconciliationLimit(dependencies.limit);

  async function failAdmission(
    claim: Awaited<ReturnType<TeamOrchestrationStore["claimNextTeamStep"]>>,
    error: Readonly<{
      code: string;
      message: string;
      retryable: false;
    }>
  ): Promise<boolean> {
    if (claim.kind !== "ready") {
      return false;
    }
    const failed = await dependencies.store.failTeamStepAdmission(
      dependencies.operator,
      {
        error,
        expectedVersion: claim.teamStepVersion,
        teamStepId: claim.teamStepId,
      }
    );
    return failed.kind === "failed";
  }

  return {
    claimReadySteps: async (): Promise<TeamClaimReconciliationResult> => {
      let admitted = 0;
      const claimedDispatches: RunnerClaimedDispatch[] = [];
      let deferred = 0;
      const deferredTeamRunIds = new Set<string>();
      let failures = 0;
      let waitingApproval = 0;

      for (let index = 0; index < limit; index += 1) {
        let claim: Awaited<
          ReturnType<TeamOrchestrationStore["claimNextTeamStep"]>
        >;
        try {
          claim = await dependencies.store.claimNextTeamStep(
            dependencies.operator
          );
        } catch {
          failures += 1;
          break;
        }
        if (claim.kind === "idle") {
          break;
        }
        if (claim.kind === "waiting_approval") {
          waitingApproval += 1;
          continue;
        }
        if (deferredTeamRunIds.has(claim.teamRunId)) {
          break;
        }

        const ids: TeamChildRunnerIds = {
          operationId: claim.plannedOperationId,
          runId: claim.plannedRunnerRunId,
        };
        let result: AdmitRunnerRunResult;
        try {
          const task = buildTeamStepTask({
            githubCapability: githubCapabilityMode(claim.declaredCapabilities),
            memberResponsibility: claim.responsibility,
            mission: claim.mission,
            priorHandoffs: claim.priorHandoffs,
            profileInstructions: claim.agentSnapshot.instructions,
            skillSnapshots: claim.skillSnapshots,
          });
          result = await dependencies.admit({
            agentId: claim.agentId,
            agentSnapshot: claim.agentSnapshot,
            authVersion: claim.authVersion,
            id: ids.runId,
            operationId: ids.operationId,
            principal: claim.principal,
            requestHash: hashRunRequest(claim.agentId, task),
            task,
          });
        } catch {
          failures += 1;
          if (
            await failAdmission(claim, {
              code: "task_invalid",
              message: "The immutable team step task could not be composed.",
              retryable: false,
            })
          ) {
            continue;
          }
          break;
        }
        if (result.kind === "refused") {
          if (result.error.retryable) {
            deferred += 1;
            deferredTeamRunIds.add(claim.teamRunId);
            continue;
          }
          failures += 1;
          if (
            await failAdmission(claim, {
              code: result.error.code,
              message:
                result.error.code === "agent_not_found"
                  ? "The snapshotted runner agent is unavailable."
                  : "Runner admission rejected the immutable team step.",
              retryable: false,
            })
          ) {
            continue;
          }
          break;
        }
        let attachment: Awaited<
          ReturnType<TeamOrchestrationStore["attachTeamStepRunnerRun"]>
        >;
        try {
          attachment = await dependencies.store.attachTeamStepRunnerRun(
            dependencies.operator,
            {
              expectedVersion: claim.teamStepVersion,
              operationId: ids.operationId,
              runnerRunId: ids.runId,
              teamStepId: claim.teamStepId,
            }
          );
        } catch {
          failures += 1;
          break;
        }
        if (attachment.kind !== "attached" && attachment.kind !== "duplicate") {
          if (attachment.kind === "cancel_required") {
            const cancellation = await dependencies.cancelRun(
              claim.principal,
              ids.runId
            );
            if (
              cancellation.kind !== "stopped" &&
              cancellation.kind !== "already_terminal"
            ) {
              deferred += 1;
            }
            continue;
          }
          failures += 1;
          break;
        }
        admitted += 1;
        if (result.kind === "claimed") {
          claimedDispatches.push(result.claimed);
        }
      }

      return {
        admitted,
        claimedDispatches,
        deferred,
        failures,
        waitingApproval,
      };
    },

    projectTerminalSteps:
      async (): Promise<TeamProjectionReconciliationResult> => {
        let cancellationDeferred = 0;
        let cancellationRequested = 0;
        const deferredTeamRunIds = new Set<string>();
        let failures = 0;
        let projected = 0;

        for (let index = 0; index < limit; index += 1) {
          let candidate: Awaited<
            ReturnType<TeamOrchestrationStore["findNextCancelledTeamChild"]>
          >;
          try {
            candidate = await dependencies.store.findNextCancelledTeamChild(
              dependencies.operator
            );
          } catch {
            failures += 1;
            break;
          }
          if (candidate.kind === "idle") {
            break;
          }
          if (deferredTeamRunIds.has(candidate.teamRunId)) {
            break;
          }
          let result: Readonly<{ kind: string }>;
          try {
            result = await dependencies.cancelRun(
              candidate.principal,
              candidate.runnerRunId
            );
          } catch {
            cancellationDeferred += 1;
            break;
          }
          if (result.kind === "stopped" || result.kind === "already_terminal") {
            cancellationRequested += 1;
          } else {
            cancellationDeferred += 1;
            deferredTeamRunIds.add(candidate.teamRunId);
          }
        }

        for (let index = 0; index < limit; index += 1) {
          try {
            const result = await dependencies.store.projectNextTerminalTeamStep(
              dependencies.operator
            );
            if (result.kind === "idle") {
              break;
            }
            projected += 1;
          } catch {
            failures += 1;
          }
        }

        return {
          cancellationDeferred,
          cancellationRequested,
          failures,
          projected,
        };
      },
  };
}
