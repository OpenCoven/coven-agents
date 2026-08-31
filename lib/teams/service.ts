import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  approveTeamRunInputSchema,
  createSkillInputSchema,
  createTeamInputSchema,
  createTeamRunInputSchema,
  expectedVersionInputSchema,
  type SkillResource,
  skillIdSchema,
  skillResourceSchema,
  type TeamResource,
  type TeamRun,
  teamIdSchema,
  teamResourceSchema,
  teamRunIdSchema,
  teamRunSchema,
  teamStepIdSchema,
  updateSkillInputSchema,
  updateTeamInputSchema,
} from "@opencoven/agent-contracts";
import type { RunnerPrincipal } from "@/lib/runner/types";
import type {
  createTeamStore,
  TeamRecord,
  TeamRunRecord,
  TeamSkillRecord,
} from "./store";

export type TeamServiceStore = Pick<
  ReturnType<typeof createTeamStore>,
  | "cancelTeamRun"
  | "createSkill"
  | "createTeam"
  | "createTeamRun"
  | "decideTeamStepApproval"
  | "deleteSkill"
  | "deleteTeam"
  | "getSkill"
  | "getTeam"
  | "getTeamRun"
  | "listSkills"
  | "listTeamRuns"
  | "listTeams"
  | "updateSkill"
  | "updateTeam"
>;

export type TeamCrudStore = TeamServiceStore;

export type TeamCreateSkillResult =
  | Readonly<{ kind: "created"; skill: SkillResource }>
  | Readonly<{ kind: "conflict" | "invalid" }>;

export type TeamCreateTeamResult =
  | Readonly<{ kind: "created"; team: TeamResource }>
  | Readonly<{ kind: "conflict" | "invalid" | "not_found" }>;

export type TeamReadSkillResult =
  | Readonly<{ kind: "found"; skill: SkillResource }>
  | Readonly<{ kind: "not_found" }>;

export type TeamReadTeamResult =
  | Readonly<{ kind: "found"; team: TeamResource }>
  | Readonly<{ kind: "not_found" }>;

export type TeamUpdateSkillResult =
  | Readonly<{ kind: "updated"; skill: SkillResource }>
  | Readonly<{ kind: "invalid" | "not_found" | "stale_version" }>;

export type TeamUpdateTeamResult =
  | Readonly<{ kind: "updated"; team: TeamResource }>
  | Readonly<{ kind: "invalid" | "not_found" | "stale_version" }>;

export type TeamDeleteResult =
  | Readonly<{ kind: "conflict" }>
  | Readonly<{ kind: "deleted" }>
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "stale_version" }>;

export type TeamCreateRunResult =
  | Readonly<{ kind: "created" | "duplicate"; teamRun: TeamRun }>
  | Readonly<{ kind: "conflict" | "invalid" | "not_found" }>;

export type TeamReadRunResult =
  | Readonly<{ kind: "found"; teamRun: TeamRun }>
  | Readonly<{ kind: "not_found" }>;

export type TeamListRunsResult =
  | Readonly<{ kind: "found"; teamRuns: readonly TeamRun[] }>
  | Readonly<{ kind: "not_found" }>;

export type TeamApproveRunResult =
  | Readonly<{ kind: "approved" | "rejected"; teamRun: TeamRun }>
  | Readonly<{
      kind:
        | "invalid"
        | "invalid_capabilities"
        | "invalid_transition"
        | "not_found"
        | "stale_version";
    }>;

export type TeamStopRunResult =
  | Readonly<{
      cancellation: "confirmed" | "deferred" | "not_required";
      kind: "stopped";
      scheduleReconciliation: true;
      teamRun: TeamRun;
    }>
  | Readonly<{
      kind: "already_terminal" | "invalid" | "not_found" | "stale_version";
    }>;

export type TeamService = Readonly<{
  approveRun: (
    principal: RunnerPrincipal,
    id: string,
    input: unknown
  ) => Promise<TeamApproveRunResult>;
  createRun: (
    principal: RunnerPrincipal,
    authVersion: number,
    teamId: string,
    input: unknown
  ) => Promise<TeamCreateRunResult>;
  createSkill: (
    principal: RunnerPrincipal,
    input: unknown,
    creationKey?: string
  ) => Promise<TeamCreateSkillResult>;
  createTeam: (
    principal: RunnerPrincipal,
    input: unknown,
    creationKey?: string
  ) => Promise<TeamCreateTeamResult>;
  deleteSkill: (
    principal: RunnerPrincipal,
    id: string,
    expectedVersion: number
  ) => Promise<TeamDeleteResult>;
  deleteTeam: (
    principal: RunnerPrincipal,
    id: string,
    expectedVersion: number
  ) => Promise<TeamDeleteResult>;
  getSkill: (
    principal: RunnerPrincipal,
    id: string
  ) => Promise<TeamReadSkillResult>;
  getTeam: (
    principal: RunnerPrincipal,
    id: string
  ) => Promise<TeamReadTeamResult>;
  getRun: (
    principal: RunnerPrincipal,
    id: string
  ) => Promise<TeamReadRunResult>;
  listSkills: (principal: RunnerPrincipal) => Promise<readonly SkillResource[]>;
  listTeams: (principal: RunnerPrincipal) => Promise<readonly TeamResource[]>;
  listRuns: (
    principal: RunnerPrincipal,
    teamId: string
  ) => Promise<TeamListRunsResult>;
  stopRun: (
    principal: RunnerPrincipal,
    id: string,
    expectedVersion: number
  ) => Promise<TeamStopRunResult>;
  updateSkill: (
    principal: RunnerPrincipal,
    id: string,
    input: unknown
  ) => Promise<TeamUpdateSkillResult>;
  updateTeam: (
    principal: RunnerPrincipal,
    id: string,
    input: unknown
  ) => Promise<TeamUpdateTeamResult>;
}>;

export type TeamServiceDependencies = Readonly<{
  cancelChild?: (
    principal: RunnerPrincipal,
    runId: string
  ) => Promise<Readonly<{ kind: string }>>;
  createId?: (scope?: string) => string;
  store: TeamServiceStore;
}>;

function projectSkill(record: TeamSkillRecord): SkillResource {
  return skillResourceSchema.parse({
    createdAt: record.createdAt.toISOString(),
    description: record.description,
    id: record.id,
    instructions: record.instructions,
    name: record.name,
    requiredCapabilities: record.requiredCapabilities,
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
  });
}

function projectTeam(record: TeamRecord): TeamResource {
  return teamResourceSchema.parse({
    createdAt: record.createdAt.toISOString(),
    description: record.description,
    id: record.id,
    members: record.members.map((member) => ({
      agentId: member.agentId,
      id: member.id,
      position: member.position,
      required: member.required,
      responsibility: member.responsibility,
      skillIds: member.skillIds,
    })),
    name: record.name,
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
  });
}

function projectTeamRun(record: TeamRunRecord): TeamRun {
  return teamRunSchema.parse({
    completedAt: record.completedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    currentPosition: record.currentPosition,
    error: record.error,
    id: record.id,
    mission: record.mission,
    operationId: record.operationId,
    startedAt: record.startedAt?.toISOString() ?? null,
    status: record.status,
    steps: record.steps.map((step) => ({
      agentId: step.agentId,
      approvalStatus: step.approvalStatus,
      completedAt: step.completedAt?.toISOString() ?? null,
      createdAt: step.createdAt.toISOString(),
      error: step.error,
      handoff: step.handoff,
      id: step.id,
      position: step.position,
      required: step.required,
      responsibility: step.responsibility,
      runnerRunId: step.runnerRunId,
      skillIds: step.skillIds,
      startedAt: step.startedAt?.toISOString() ?? null,
      status: step.status,
      updatedAt: step.updatedAt.toISOString(),
      version: step.version,
    })),
    teamId: record.teamId,
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
  });
}

function generatedId(
  createId: (scope?: string) => string,
  scope: string | undefined,
  schema:
    | typeof skillIdSchema
    | typeof teamIdSchema
    | typeof teamRunIdSchema
    | typeof teamStepIdSchema
): string {
  const id = createId(scope);
  if (!schema.safeParse(id).success) {
    throw new Error("Team service ID generation failed.");
  }
  return id;
}

function deterministicUuid(scope: string): string {
  const bytes = createHash("sha256")
    .update(scope, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function unreachable(value: never, operation: string): never {
  throw new Error(
    `Team service ${operation} returned an unsupported outcome: ${JSON.stringify(value)}`
  );
}

export function createTeamService(
  dependencies: TeamServiceDependencies
): TeamService {
  const createId =
    dependencies.createId ??
    ((scope?: string) => (scope ? deterministicUuid(scope) : randomUUID()));

  return {
    approveRun: async (principal, id, input) => {
      if (!teamRunIdSchema.safeParse(id).success) {
        return { kind: "not_found" };
      }
      const parsed = approveTeamRunInputSchema.safeParse(input);
      if (!parsed.success) {
        return { kind: "invalid" };
      }
      const run = await dependencies.store.getTeamRun(principal, id);
      if (!run) {
        return { kind: "not_found" };
      }
      const step = run.steps[run.currentPosition];
      if (
        run.status !== "waiting_approval" ||
        !step ||
        step.status !== "waiting_approval" ||
        step.approvalStatus !== "pending"
      ) {
        return { kind: "invalid_transition" };
      }
      const result = await dependencies.store.decideTeamStepApproval(
        principal,
        {
          ...parsed.data,
          id: step.id,
        }
      );
      switch (result.kind) {
        case "updated": {
          const updated = await dependencies.store.getTeamRun(principal, id);
          if (!updated) {
            throw new Error("Decided team run disappeared.");
          }
          return {
            kind: parsed.data.decision === "approve" ? "approved" : "rejected",
            teamRun: projectTeamRun(updated),
          };
        }
        case "invalid_capabilities":
        case "invalid_transition":
        case "not_found":
        case "stale_version":
          return result;
        default:
          return unreachable(result, "team run approval");
      }
    },

    createRun: async (principal, authVersion, teamId, input) => {
      if (
        !teamIdSchema.safeParse(teamId).success ||
        !expectedVersionInputSchema.safeParse({
          expectedVersion: authVersion,
        }).success
      ) {
        return { kind: "invalid" };
      }
      const parsed = createTeamRunInputSchema.safeParse(input);
      if (!parsed.success) {
        return { kind: "invalid" };
      }
      const team = await dependencies.store.getTeam(principal, teamId);
      if (!team) {
        return { kind: "not_found" };
      }
      const runId = generatedId(
        createId,
        `team-run:${teamId}:${parsed.data.operationId}`,
        teamRunIdSchema
      );
      const requestHash = createHash("sha256")
        .update(`${teamId}\0${parsed.data.task}`, "utf8")
        .digest("hex");
      const result = await dependencies.store.createTeamRun(principal, {
        authVersion,
        id: runId,
        mission: parsed.data.task,
        operationId: parsed.data.operationId,
        requestHash,
        stepIds: team.members.map((_, position) =>
          generatedId(
            createId,
            `team-run:${runId}:step:${position}`,
            teamStepIdSchema
          )
        ),
        teamId,
      });
      switch (result.kind) {
        case "created":
        case "duplicate":
          return {
            kind: result.kind,
            teamRun: projectTeamRun(result.run),
          };
        case "conflict":
        case "not_found":
          return result;
        default:
          return unreachable(result, "team run creation");
      }
    },

    createSkill: async (principal, input, creationKey) => {
      const parsed = createSkillInputSchema.safeParse(input);
      if (!parsed.success) {
        return { kind: "invalid" };
      }
      const result = await dependencies.store.createSkill(principal, {
        ...parsed.data,
        id: generatedId(
          createId,
          creationKey ? `skill:${creationKey}` : undefined,
          skillIdSchema
        ),
      });
      switch (result.kind) {
        case "created":
        case "duplicate":
          return { kind: "created", skill: projectSkill(result.skill) };
        case "conflict":
          return result;
        default:
          return unreachable(result, "skill creation");
      }
    },

    createTeam: async (principal, input, creationKey) => {
      const parsed = createTeamInputSchema.safeParse(input);
      if (!parsed.success) {
        return { kind: "invalid" };
      }
      const result = await dependencies.store.createTeam(principal, {
        ...parsed.data,
        id: generatedId(
          createId,
          creationKey ? `team:${creationKey}` : undefined,
          teamIdSchema
        ),
        members: parsed.data.members.map((member, position) => ({
          ...member,
          id: generatedId(
            createId,
            creationKey ? `team:${creationKey}:member:${position}` : undefined,
            teamIdSchema
          ),
        })),
      });
      switch (result.kind) {
        case "created":
        case "duplicate":
          return { kind: "created", team: projectTeam(result.team) };
        case "conflict":
        case "not_found":
          return result;
        default:
          return unreachable(result, "team creation");
      }
    },

    deleteSkill: async (principal, id, expectedVersion) => {
      if (
        !skillIdSchema.safeParse(id).success ||
        !expectedVersionInputSchema.safeParse({ expectedVersion }).success
      ) {
        return { kind: "invalid" };
      }
      const result = await dependencies.store.deleteSkill(principal, {
        expectedVersion,
        id,
      });
      switch (result.kind) {
        case "conflict":
        case "deleted":
        case "not_found":
        case "stale_version":
          return result;
        default:
          return unreachable(result, "skill deletion");
      }
    },

    deleteTeam: async (principal, id, expectedVersion) => {
      if (
        !teamIdSchema.safeParse(id).success ||
        !expectedVersionInputSchema.safeParse({ expectedVersion }).success
      ) {
        return { kind: "invalid" };
      }
      const result = await dependencies.store.deleteTeam(principal, {
        expectedVersion,
        id,
      });
      switch (result.kind) {
        case "conflict":
        case "deleted":
        case "not_found":
        case "stale_version":
          return result;
        default:
          return unreachable(result, "team deletion");
      }
    },

    getRun: async (principal, id) => {
      if (!teamRunIdSchema.safeParse(id).success) {
        return { kind: "not_found" };
      }
      const record = await dependencies.store.getTeamRun(principal, id);
      return record
        ? { kind: "found", teamRun: projectTeamRun(record) }
        : { kind: "not_found" };
    },

    getSkill: async (principal, id) => {
      if (!skillIdSchema.safeParse(id).success) {
        return { kind: "not_found" };
      }
      const record = await dependencies.store.getSkill(principal, id);
      return record
        ? { kind: "found", skill: projectSkill(record) }
        : { kind: "not_found" };
    },

    getTeam: async (principal, id) => {
      if (!teamIdSchema.safeParse(id).success) {
        return { kind: "not_found" };
      }
      const record = await dependencies.store.getTeam(principal, id);
      return record
        ? { kind: "found", team: projectTeam(record) }
        : { kind: "not_found" };
    },

    listRuns: async (principal, teamId) => {
      if (!teamIdSchema.safeParse(teamId).success) {
        return { kind: "not_found" };
      }
      if (!(await dependencies.store.getTeam(principal, teamId))) {
        return { kind: "not_found" };
      }
      return {
        kind: "found",
        teamRuns: (
          await dependencies.store.listTeamRuns(principal, teamId)
        ).map(projectTeamRun),
      };
    },

    listSkills: async (principal) =>
      (await dependencies.store.listSkills(principal)).map(projectSkill),

    listTeams: async (principal) =>
      (await dependencies.store.listTeams(principal)).map(projectTeam),

    stopRun: async (principal, id, expectedVersion) => {
      if (
        !teamRunIdSchema.safeParse(id).success ||
        !expectedVersionInputSchema.safeParse({ expectedVersion }).success
      ) {
        return { kind: "invalid" };
      }
      const result = await dependencies.store.cancelTeamRun(principal, {
        expectedVersion,
        id,
      });
      switch (result.kind) {
        case "not_found":
        case "stale_version":
          return result;
        case "already_terminal": {
          const terminal = await dependencies.store.getTeamRun(principal, id);
          if (!terminal) {
            return { kind: "not_found" };
          }
          return {
            cancellation: "not_required",
            kind: "stopped",
            scheduleReconciliation: true,
            teamRun: projectTeamRun(terminal),
          };
        }
        case "updated": {
          let cancellation: "confirmed" | "deferred" | "not_required" =
            "not_required";
          if (result.childRunId) {
            if (!dependencies.cancelChild) {
              throw new Error("Team child cancellation is not configured.");
            }
            const child = await dependencies.cancelChild(
              principal,
              result.childRunId
            );
            cancellation =
              child.kind === "stopped" || child.kind === "already_terminal"
                ? "confirmed"
                : "deferred";
          }
          return {
            cancellation,
            kind: "stopped",
            scheduleReconciliation: true,
            teamRun: projectTeamRun(result.value),
          };
        }
        default:
          return unreachable(result, "team run cancellation");
      }
    },

    updateSkill: async (principal, id, input) => {
      if (!skillIdSchema.safeParse(id).success) {
        return { kind: "not_found" };
      }
      const parsed = updateSkillInputSchema.safeParse(input);
      if (!parsed.success) {
        return { kind: "invalid" };
      }
      const result = await dependencies.store.updateSkill(principal, {
        ...parsed.data,
        id,
      });
      switch (result.kind) {
        case "updated":
          return { kind: "updated", skill: projectSkill(result.value) };
        case "not_found":
        case "stale_version":
          return result;
        default:
          return unreachable(result, "skill update");
      }
    },

    updateTeam: async (principal, id, input) => {
      if (!teamIdSchema.safeParse(id).success) {
        return { kind: "not_found" };
      }
      const parsed = updateTeamInputSchema.safeParse(input);
      if (!parsed.success) {
        return { kind: "invalid" };
      }
      const result = await dependencies.store.updateTeam(principal, {
        ...parsed.data,
        id,
        members: parsed.data.members.map((member) => ({
          ...member,
          id: generatedId(createId, undefined, teamIdSchema),
        })),
      });
      switch (result.kind) {
        case "updated":
          return { kind: "updated", team: projectTeam(result.value) };
        case "not_found":
        case "stale_version":
          return result;
        default:
          return unreachable(result, "team update");
      }
    },
  };
}
