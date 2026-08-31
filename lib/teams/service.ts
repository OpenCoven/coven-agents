import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  createSkillInputSchema,
  createTeamInputSchema,
  expectedVersionInputSchema,
  type SkillResource,
  skillIdSchema,
  skillResourceSchema,
  type TeamResource,
  teamIdSchema,
  teamResourceSchema,
  updateSkillInputSchema,
  updateTeamInputSchema,
} from "@opencoven/agent-contracts";
import type { RunnerPrincipal } from "@/lib/runner/types";
import type { createTeamStore, TeamRecord, TeamSkillRecord } from "./store";

export type TeamCrudStore = Pick<
  ReturnType<typeof createTeamStore>,
  | "createSkill"
  | "createTeam"
  | "deleteSkill"
  | "deleteTeam"
  | "getSkill"
  | "getTeam"
  | "listSkills"
  | "listTeams"
  | "updateSkill"
  | "updateTeam"
>;

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

export type TeamService = Readonly<{
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
  listSkills: (principal: RunnerPrincipal) => Promise<readonly SkillResource[]>;
  listTeams: (principal: RunnerPrincipal) => Promise<readonly TeamResource[]>;
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
  createId?: (scope?: string) => string;
  store: TeamCrudStore;
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

function generatedId(
  createId: (scope?: string) => string,
  scope: string | undefined,
  schema: typeof skillIdSchema | typeof teamIdSchema
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

    listSkills: async (principal) =>
      (await dependencies.store.listSkills(principal)).map(projectSkill),

    listTeams: async (principal) =>
      (await dependencies.store.listTeams(principal)).map(projectTeam),

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
