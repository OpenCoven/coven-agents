import "server-only";

import {
  createSkillInputSchema,
  createTeamInputSchema,
  type GitHubOperationKind,
  type GitHubOperationStatus,
  githubOperationKindSchema,
  type RunError,
  runErrorSchema,
  TEAM_LIMITS,
  type TeamApprovalStatus,
  type TeamCapability,
  type TeamHandoff,
  type TeamRunStatus,
  type TeamStepStatus,
  teamHandoffSchema,
} from "@opencoven/agent-contracts";
import { type SQL, sql } from "drizzle-orm";
import type { databaseFor } from "@/lib/db/access";
import type { RunnerPrincipal } from "@/lib/runner/types";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL_ID = /^(0|[1-9][0-9]{0,19})$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const MAX_CAPABILITY_CALLS = 32;
const MAX_REPOSITORIES = 16;
const GITHUB_CAPABILITIES = new Set<TeamCapability>([
  "github.issues.read",
  "github.issues.write",
  "github.pull_requests.read",
  "github.pull_requests.write",
  "github.projects.read",
  "github.projects.write",
]);

export type TeamStoreStatement = {
  args: Readonly<Record<string, unknown>>;
  name: string;
  query: SQL;
};

export type TeamStoreTransaction = {
  execute: <Row extends Record<string, unknown>>(
    statement: TeamStoreStatement
  ) => Promise<Row[]>;
};

export type TeamStoreDatabase = {
  transaction: <T>(
    callback: (transaction: TeamStoreTransaction) => Promise<T>
  ) => Promise<T>;
};

type ProductionDatabase = ReturnType<typeof databaseFor>;

export function drizzleTeamStoreDatabase(
  database: ProductionDatabase
): TeamStoreDatabase {
  return {
    transaction: (callback) =>
      database.transaction((transaction) =>
        callback({
          execute: async <Row extends Record<string, unknown>>(
            queryStatement: TeamStoreStatement
          ) =>
            (await transaction.execute(
              queryStatement.query
            )) as unknown as Row[],
        })
      ),
  };
}

export type TeamSkillRecord = {
  createdAt: Date;
  description: string;
  id: string;
  instructions: string;
  name: string;
  requiredCapabilities: TeamCapability[];
  tenant: string;
  updatedAt: Date;
  version: number;
};

export type TeamMemberRecord = {
  agentId: string;
  id: string;
  position: number;
  required: boolean;
  responsibility: string;
  skillIds: string[];
};

export type TeamRecord = {
  createdAt: Date;
  description: string;
  id: string;
  members: TeamMemberRecord[];
  name: string;
  tenant: string;
  updatedAt: Date;
  version: number;
};

export type TeamSkillSnapshot = {
  description: string;
  id: string;
  instructions: string;
  name: string;
  requiredCapabilities: TeamCapability[];
};

export type TeamStepRecord = {
  agentId: string;
  approvalStatus: TeamApprovalStatus;
  completedAt: Date | null;
  createdAt: Date;
  error: RunError | null;
  handoff: TeamHandoff | null;
  id: string;
  memberId: string;
  position: number;
  required: boolean;
  responsibility: string;
  runnerRunId: string | null;
  skillIds: string[];
  skillSnapshots: TeamSkillSnapshot[];
  startedAt: Date | null;
  status: TeamStepStatus;
  tenant: string;
  updatedAt: Date;
  version: number;
};

export type TeamRunRecord = {
  completedAt: Date | null;
  createdAt: Date;
  currentPosition: number;
  error: RunError | null;
  id: string;
  mission: string;
  operationId: string;
  requestHash: string;
  startedAt: Date | null;
  status: TeamRunStatus;
  steps: TeamStepRecord[];
  teamId: string;
  tenant: string;
  updatedAt: Date;
  version: number;
};

export type GitHubConnectionRecord = {
  accountId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  createdAt: Date;
  id: string;
  installationId: string;
  repositoryId: string;
  repositoryName: string;
  repositoryNodeId: string;
  repositoryOwner: string;
  tenant: string;
  updatedAt: Date;
  version: number;
};

export type GitHubCapabilityRecord = {
  approvedCapabilities: TeamCapability[];
  createdAt: Date;
  expiresAt: Date;
  id: string;
  maxCallCount: number;
  repositoryAllowlist: string[];
  revokedAt: Date | null;
  teamStepId: string;
  tenant: string;
  tokenHash: string;
  usedCallCount: number;
  version: number;
};

export type GitHubOperationRecord = {
  capabilityId: string;
  completedAt: Date | null;
  createdAt: Date;
  error: RunError | null;
  id: string;
  kind: GitHubOperationKind;
  operationId: string;
  providerRequestId: string | null;
  requestHash: string;
  resultNodeId: string | null;
  resultUrl: string | null;
  startedAt: Date | null;
  status: GitHubOperationStatus;
  target: string;
  teamStepId: string;
  tenant: string;
  updatedAt: Date;
  version: number;
};

export type CreateSkillStoreInput = {
  description?: string;
  id: string;
  instructions: string;
  name: string;
  requiredCapabilities?: TeamCapability[];
};

export type UpdateSkillStoreInput = CreateSkillStoreInput & {
  expectedVersion: number;
};

export type TeamMemberStoreInput = {
  agentId: string;
  id: string;
  required?: boolean;
  responsibility: string;
  skillIds?: string[];
};

export type CreateTeamStoreInput = {
  description?: string;
  id: string;
  members: TeamMemberStoreInput[];
  name: string;
};

export type UpdateTeamStoreInput = CreateTeamStoreInput & {
  expectedVersion: number;
};

export type CreateTeamRunStoreInput = {
  id: string;
  mission: string;
  operationId: string;
  requestHash: string;
  stepIds: string[];
  teamId: string;
};

export type UpdateTeamStepStoreInput = {
  approvalStatus: TeamApprovalStatus;
  error: RunError | null;
  expectedVersion: number;
  handoff: TeamHandoff | null;
  id: string;
  runnerRunId: string | null;
  status: TeamStepStatus;
};

export type CreateGitHubCapabilityInput = {
  approvedCapabilities: TeamCapability[];
  expiresAt: Date;
  id: string;
  maxCallCount: number;
  repositoryAllowlist: string[];
  teamStepId: string;
  tokenHash: string;
};

export type BeginGitHubOperationInput = {
  capabilityId: string;
  id: string;
  kind: GitHubOperationKind;
  operationId: string;
  repository: string;
  requestHash: string;
  target: string;
  teamStepId: string;
};

function statement(
  name: string,
  args: Readonly<Record<string, unknown>>,
  query: SQL
): TeamStoreStatement {
  return { args, name, query };
}

function column<T>(row: Record<string, unknown>, name: string): T {
  const value = row[name];
  if (value === undefined) {
    throw new Error(`Team query did not return "${name}".`);
  }
  return value as T;
}

function postgresTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.includes("T")
    ? value
    : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function timestampColumn(row: Record<string, unknown>, name: string): Date {
  const value = postgresTimestamp(column(row, name));
  if (!value) {
    throw new Error(`Team query returned an invalid "${name}".`);
  }
  return value;
}

function nullableTimestampColumn(
  row: Record<string, unknown>,
  name: string
): Date | null {
  const value = column<unknown>(row, name);
  if (value === null) {
    return null;
  }
  const timestamp = postgresTimestamp(value);
  if (!timestamp) {
    throw new Error(`Team query returned an invalid "${name}".`);
  }
  return timestamp;
}

function arrayColumn<T>(row: Record<string, unknown>, name: string): T[] {
  const value = column<unknown>(row, name);
  if (!Array.isArray(value)) {
    throw new Error(`Team query returned an invalid "${name}".`);
  }
  return value as T[];
}

function asSkill(row: Record<string, unknown>): TeamSkillRecord {
  return {
    createdAt: timestampColumn(row, "createdAt"),
    description: column(row, "description"),
    id: column(row, "id"),
    instructions: column(row, "instructions"),
    name: column(row, "name"),
    requiredCapabilities: arrayColumn(row, "requiredCapabilities"),
    tenant: column(row, "tenant"),
    updatedAt: timestampColumn(row, "updatedAt"),
    version: column(row, "version"),
  };
}

function asMember(value: unknown): TeamMemberRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Team query returned an invalid member.");
  }
  const row = value as Record<string, unknown>;
  return {
    agentId: column(row, "agentId"),
    id: column(row, "id"),
    position: column(row, "position"),
    required: column(row, "required"),
    responsibility: column(row, "responsibility"),
    skillIds: arrayColumn<string>(row, "skillIds").sort(),
  };
}

function asTeam(row: Record<string, unknown>): TeamRecord {
  return {
    createdAt: timestampColumn(row, "createdAt"),
    description: column(row, "description"),
    id: column(row, "id"),
    members: arrayColumn<unknown>(row, "members")
      .map(asMember)
      .sort((left, right) => left.position - right.position),
    name: column(row, "name"),
    tenant: column(row, "tenant"),
    updatedAt: timestampColumn(row, "updatedAt"),
    version: column(row, "version"),
  };
}

function asSkillSnapshot(value: unknown): TeamSkillSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Team query returned an invalid skill snapshot.");
  }
  const row = value as Record<string, unknown>;
  return {
    description: column(row, "description"),
    id: column(row, "id"),
    instructions: column(row, "instructions"),
    name: column(row, "name"),
    requiredCapabilities: arrayColumn(row, "requiredCapabilities"),
  };
}

function asStep(row: Record<string, unknown>): TeamStepRecord {
  return {
    agentId: column(row, "agentId"),
    approvalStatus: column(row, "approvalStatus"),
    completedAt: nullableTimestampColumn(row, "completedAt"),
    createdAt: timestampColumn(row, "createdAt"),
    error: column(row, "error"),
    handoff: column(row, "handoff"),
    id: column(row, "id"),
    memberId: column(row, "memberId"),
    position: column(row, "position"),
    required: column(row, "required"),
    responsibility: column(row, "responsibility"),
    runnerRunId: column(row, "runnerRunId"),
    skillIds: arrayColumn<string>(row, "skillIds").sort(),
    skillSnapshots: arrayColumn<unknown>(row, "skillSnapshots")
      .map(asSkillSnapshot)
      .sort((left, right) => left.id.localeCompare(right.id)),
    startedAt: nullableTimestampColumn(row, "startedAt"),
    status: column(row, "status"),
    tenant: column(row, "tenant"),
    updatedAt: timestampColumn(row, "updatedAt"),
    version: column(row, "version"),
  };
}

function asRun(row: Record<string, unknown>): TeamRunRecord {
  return {
    completedAt: nullableTimestampColumn(row, "completedAt"),
    createdAt: timestampColumn(row, "createdAt"),
    currentPosition: column(row, "currentPosition"),
    error: column(row, "error"),
    id: column(row, "id"),
    mission: column(row, "mission"),
    operationId: column(row, "operationId"),
    requestHash: column(row, "requestHash"),
    startedAt: nullableTimestampColumn(row, "startedAt"),
    status: column(row, "status"),
    steps: arrayColumn<Record<string, unknown>>(row, "steps")
      .map(asStep)
      .sort((left, right) => left.position - right.position),
    teamId: column(row, "teamId"),
    tenant: column(row, "tenant"),
    updatedAt: timestampColumn(row, "updatedAt"),
    version: column(row, "version"),
  };
}

function asConnection(row: Record<string, unknown>): GitHubConnectionRecord {
  return {
    accountId: column(row, "accountId"),
    accountLogin: column(row, "accountLogin"),
    accountType: column(row, "accountType"),
    createdAt: timestampColumn(row, "createdAt"),
    id: column(row, "id"),
    installationId: column(row, "installationId"),
    repositoryId: column(row, "repositoryId"),
    repositoryName: column(row, "repositoryName"),
    repositoryNodeId: column(row, "repositoryNodeId"),
    repositoryOwner: column(row, "repositoryOwner"),
    tenant: column(row, "tenant"),
    updatedAt: timestampColumn(row, "updatedAt"),
    version: column(row, "version"),
  };
}

function asCapability(row: Record<string, unknown>): GitHubCapabilityRecord {
  return {
    approvedCapabilities: arrayColumn(row, "approvedCapabilities"),
    createdAt: timestampColumn(row, "createdAt"),
    expiresAt: timestampColumn(row, "expiresAt"),
    id: column(row, "id"),
    maxCallCount: column(row, "maxCallCount"),
    repositoryAllowlist: arrayColumn(row, "repositoryAllowlist"),
    revokedAt: nullableTimestampColumn(row, "revokedAt"),
    teamStepId: column(row, "teamStepId"),
    tenant: column(row, "tenant"),
    tokenHash: column(row, "tokenHash"),
    usedCallCount: column(row, "usedCallCount"),
    version: column(row, "version"),
  };
}

function asGitHubOperation(
  row: Record<string, unknown>
): GitHubOperationRecord {
  return {
    capabilityId: column(row, "capabilityId"),
    completedAt: nullableTimestampColumn(row, "completedAt"),
    createdAt: timestampColumn(row, "createdAt"),
    error: column(row, "error"),
    id: column(row, "id"),
    kind: column(row, "kind"),
    operationId: column(row, "operationId"),
    providerRequestId: column(row, "providerRequestId"),
    requestHash: column(row, "requestHash"),
    resultNodeId: column(row, "resultNodeId"),
    resultUrl: column(row, "resultUrl"),
    startedAt: nullableTimestampColumn(row, "startedAt"),
    status: column(row, "status"),
    target: column(row, "target"),
    teamStepId: column(row, "teamStepId"),
    tenant: column(row, "tenant"),
    updatedAt: timestampColumn(row, "updatedAt"),
    version: column(row, "version"),
  };
}

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) {
    throw new Error(`${field} must be a UUID.`);
  }
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error("Expected version must be a non-negative integer.");
  }
}

function assertRequestHash(requestHash: string): void {
  if (!SHA256.test(requestHash)) {
    throw new Error("Request hash must be a lowercase SHA-256 digest.");
  }
}

function validateSkillInput(input: CreateSkillStoreInput): void {
  assertUuid(input.id, "Skill id");
  createSkillInputSchema.parse({
    description: input.description,
    instructions: input.instructions,
    name: input.name,
    requiredCapabilities: input.requiredCapabilities,
  });
}

function validateTeamInput(input: CreateTeamStoreInput): void {
  assertUuid(input.id, "Team id");
  for (const member of input.members) {
    assertUuid(member.id, "Team member id");
  }
  createTeamInputSchema.parse({
    description: input.description,
    members: input.members.map(({ id: _id, ...member }) => member),
    name: input.name,
  });
  const memberIds = input.members.map(({ id }) => id);
  if (new Set(memberIds).size !== memberIds.length) {
    throw new Error("Team member ids must be unique.");
  }
}

function jsonParameter(value: unknown): string {
  return JSON.stringify(value);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(jsonParameter(value)).byteLength;
}

function idList(ids: readonly string[]): SQL {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
}

async function validateTeamOwnership(
  transaction: TeamStoreTransaction,
  tenant: string,
  members: readonly TeamMemberStoreInput[]
): Promise<boolean> {
  const agentIds = [...new Set(members.map(({ agentId }) => agentId))];
  const agents = await transaction.execute(
    statement(
      "validate-team-agents",
      { agentIds, tenant },
      sql`SELECT "id" FROM "RunnerAgent"
        WHERE "tenant" = ${tenant}
          AND "id" IN (${idList(agentIds)})
        FOR SHARE`
    )
  );
  if (agents.length !== agentIds.length) {
    return false;
  }

  const skillIds = [
    ...new Set(
      members.flatMap(({ skillIds: memberSkillIds = [] }) => memberSkillIds)
    ),
  ];
  if (skillIds.length === 0) {
    return true;
  }
  const skills = await transaction.execute(
    statement(
      "validate-team-skills",
      { skillIds, tenant },
      sql`SELECT "id" FROM "RunnerSkill"
        WHERE "tenant" = ${tenant}
          AND "id" IN (${idList(skillIds)})
        FOR SHARE`
    )
  );
  return skills.length === skillIds.length;
}

function normalizedMembers(
  members: readonly TeamMemberStoreInput[]
): TeamMemberRecord[] {
  return members.map((member, position) => ({
    agentId: member.agentId,
    id: member.id,
    position,
    required: member.required ?? true,
    responsibility: member.responsibility,
    skillIds: [...(member.skillIds ?? [])].sort(),
  }));
}

async function insertTeamMembers(
  transaction: TeamStoreTransaction,
  tenant: string,
  teamId: string,
  members: readonly TeamMemberRecord[]
): Promise<void> {
  const memberPayload = members.map(
    ({ agentId, id, position, required, responsibility }) => ({
      agentId,
      id,
      position,
      required,
      responsibility,
    })
  );
  await transaction.execute(
    statement(
      "insert-team-members",
      {
        members: memberPayload,
        positions: members.map(({ position }) => position),
        teamId,
        tenant,
      },
      sql`INSERT INTO "RunnerTeamMember" (
          "id", "tenant", "teamId", "agentId", "position", "responsibility", "required"
        )
        SELECT "member"."id", ${tenant}, ${teamId}, "member"."agentId",
          "member"."position", "member"."responsibility", "member"."required"
        FROM jsonb_to_recordset(CAST(${jsonParameter(memberPayload)} AS jsonb))
          AS "member"(
            "id" uuid,
            "agentId" uuid,
            "position" integer,
            "responsibility" text,
            "required" boolean
          )
        ORDER BY "member"."position"
        RETURNING *`
    )
  );

  const assignments = members.flatMap(({ id: memberId, skillIds }) =>
    skillIds.map((skillId) => ({ memberId, skillId }))
  );
  await transaction.execute(
    statement(
      "insert-team-member-skills",
      { assignments, teamId, tenant },
      sql`INSERT INTO "RunnerTeamMemberSkill" ("memberId", "tenant", "skillId")
        SELECT "assignment"."memberId", ${tenant}, "assignment"."skillId"
        FROM jsonb_to_recordset(CAST(${jsonParameter(assignments)} AS jsonb))
          AS "assignment"("memberId" uuid, "skillId" uuid)
        ORDER BY "assignment"."memberId", "assignment"."skillId"`
    )
  );
}

function teamFromParts(
  team: Record<string, unknown>,
  members: TeamMemberRecord[]
): TeamRecord {
  return asTeam({ ...team, members });
}

function teamSelect(where: SQL, suffix: SQL = sql``): SQL {
  return sql`SELECT
      "team".*,
      COALESCE((
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', "member"."id",
            'agentId', "member"."agentId",
            'position', "member"."position",
            'responsibility', "member"."responsibility",
            'required', "member"."required",
            'skillIds', COALESCE((
              SELECT jsonb_agg("memberSkill"."skillId" ORDER BY "memberSkill"."skillId")
              FROM "RunnerTeamMemberSkill" AS "memberSkill"
              WHERE "memberSkill"."memberId" = "member"."id"
                AND "memberSkill"."tenant" = "member"."tenant"
            ), '[]'::jsonb)
          )
          ORDER BY "member"."position"
        )
        FROM "RunnerTeamMember" AS "member"
        WHERE "member"."teamId" = "team"."id"
          AND "member"."tenant" = "team"."tenant"
      ), '[]'::jsonb) AS "members"
    FROM "RunnerTeam" AS "team"
    WHERE ${where}
    ${suffix}`;
}

function teamRunSelect(where: SQL, suffix: SQL = sql``): SQL {
  return sql`SELECT
      "teamRun".*,
      COALESCE((
        SELECT jsonb_agg(to_jsonb("step") ORDER BY "step"."position")
        FROM "RunnerTeamStep" AS "step"
        WHERE "step"."teamRunId" = "teamRun"."id"
          AND "step"."tenant" = "teamRun"."tenant"
      ), '[]'::jsonb) AS "steps"
    FROM "RunnerTeamRun" AS "teamRun"
    WHERE ${where}
    ${suffix}`;
}

function validStepTransition(
  current: TeamStepStatus,
  next: TeamStepStatus
): boolean {
  if (current === next) {
    return true;
  }
  const transitions: Record<TeamStepStatus, readonly TeamStepStatus[]> = {
    cancelled: [],
    completed: [],
    failed: [],
    pending: ["queued", "waiting_approval", "cancelled", "skipped"],
    queued: ["running", "cancelled", "failed"],
    running: ["waiting_approval", "completed", "failed", "cancelled"],
    skipped: [],
    waiting_approval: ["queued", "running", "completed", "failed", "cancelled"],
  };
  return transitions[current].includes(next);
}

function requiredCapability(kind: GitHubOperationKind): TeamCapability {
  const write = new Set<GitHubOperationKind>([
    "issue.create",
    "issue.comment",
    "pull.create",
    "pull.comment",
    "pull.review",
    "project.item.add",
    "project.item.field.update",
  ]);
  const namespace = kind.startsWith("issue.")
    ? "issues"
    : kind.startsWith("pull.")
      ? "pull_requests"
      : "projects";
  return `github.${namespace}.${write.has(kind) ? "write" : "read"}` as TeamCapability;
}

function validateCapabilityInput(input: CreateGitHubCapabilityInput): void {
  assertUuid(input.id, "GitHub capability id");
  assertUuid(input.teamStepId, "Team step id");
  if (!SHA256.test(input.tokenHash)) {
    throw new Error("Capability token hash must be a SHA-256 digest.");
  }
  if (
    !Number.isSafeInteger(input.maxCallCount) ||
    input.maxCallCount < 1 ||
    input.maxCallCount > MAX_CAPABILITY_CALLS
  ) {
    throw new Error(
      `Capability call count must be between 1 and ${MAX_CAPABILITY_CALLS}.`
    );
  }
  if (
    input.approvedCapabilities.length < 1 ||
    input.approvedCapabilities.length > TEAM_LIMITS.maxSkillsPerMember ||
    new Set(input.approvedCapabilities).size !==
      input.approvedCapabilities.length ||
    input.approvedCapabilities.some(
      (capability) => !GITHUB_CAPABILITIES.has(capability)
    )
  ) {
    throw new Error("Capability allowlist contains an invalid capability.");
  }
  if (
    input.repositoryAllowlist.length < 1 ||
    input.repositoryAllowlist.length > MAX_REPOSITORIES ||
    new Set(input.repositoryAllowlist).size !==
      input.repositoryAllowlist.length ||
    input.repositoryAllowlist.some((repository) => !REPOSITORY.test(repository))
  ) {
    throw new Error("Capability repository allowlist is invalid.");
  }
  if (Number.isNaN(input.expiresAt.getTime())) {
    throw new Error("Capability expiry is invalid.");
  }
}

function validateConnectionInput(input: {
  accountId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  id: string;
  installationId: string;
  repositoryId: string;
  repositoryName: string;
  repositoryNodeId: string;
  repositoryOwner: string;
}): void {
  assertUuid(input.id, "GitHub connection id");
  for (const [name, value] of [
    ["installation id", input.installationId],
    ["account id", input.accountId],
    ["repository id", input.repositoryId],
  ] as const) {
    if (!DECIMAL_ID.test(value)) {
      throw new Error(`GitHub ${name} must be a decimal string.`);
    }
  }
  if (
    !input.accountLogin ||
    input.accountLogin.length > 100 ||
    !input.repositoryOwner ||
    input.repositoryOwner.length > 100 ||
    !input.repositoryName ||
    input.repositoryName.length > 100 ||
    !input.repositoryNodeId ||
    input.repositoryNodeId.length > 256
  ) {
    throw new Error("GitHub connection metadata is invalid.");
  }
}

function validateReceipt(input: {
  error: RunError | null;
  providerRequestId: string | null;
  resultNodeId: string | null;
  resultUrl: string | null;
  status: "completed" | "failed";
}): void {
  if (input.error !== null) {
    runErrorSchema.parse(input.error);
  }
  if (
    input.providerRequestId !== null &&
    (input.providerRequestId.trim().length < 1 ||
      input.providerRequestId.length > 256)
  ) {
    throw new Error("Provider request id is invalid.");
  }
  if (
    input.resultNodeId !== null &&
    (input.resultNodeId.trim().length < 1 || input.resultNodeId.length > 256)
  ) {
    throw new Error("Result node id is invalid.");
  }
  if (input.resultUrl !== null) {
    if (input.resultUrl.length > 2048) {
      throw new Error("Result URL is too long.");
    }
    const url = new URL(input.resultUrl);
    if (url.protocol !== "https:" || url.hostname !== "github.com") {
      throw new Error("Result URL must be an HTTPS github.com URL.");
    }
  }
  if (input.status === "completed" && input.error !== null) {
    throw new Error("Completed GitHub operations cannot contain an error.");
  }
  if (input.status === "failed" && input.error === null) {
    throw new Error("Failed GitHub operations require an error.");
  }
}

export function createTeamStore(database: TeamStoreDatabase) {
  return {
    beginGitHubOperation: async (
      principal: RunnerPrincipal,
      input: BeginGitHubOperationInput
    ) => {
      assertUuid(input.id, "GitHub operation id");
      assertUuid(input.operationId, "Operation id");
      assertUuid(input.teamStepId, "Team step id");
      assertUuid(input.capabilityId, "Capability id");
      assertRequestHash(input.requestHash);
      githubOperationKindSchema.parse(input.kind);
      if (!REPOSITORY.test(input.repository)) {
        throw new Error("GitHub operation repository is invalid.");
      }
      if (!input.target.trim() || input.target.length > 512) {
        throw new Error("GitHub operation target is invalid.");
      }
      const capability = requiredCapability(input.kind);

      return await database.transaction(async (transaction) => {
        const [existing] = await transaction.execute(
          statement(
            "get-github-operation",
            {
              operationId: input.operationId,
              teamStepId: input.teamStepId,
              tenant: principal.tenant,
            },
            sql`SELECT * FROM "RunnerGitHubOperation"
              WHERE "teamStepId" = ${input.teamStepId}
                AND "tenant" = ${principal.tenant}
                AND "operationId" = ${input.operationId}
              FOR UPDATE`
          )
        );
        if (existing) {
          const operation = asGitHubOperation(existing);
          return operation.requestHash === input.requestHash &&
            operation.kind === input.kind &&
            operation.capabilityId === input.capabilityId &&
            operation.target === input.target
            ? { kind: "duplicate" as const, operation }
            : { kind: "conflict" as const, operation };
        }
        const [owner] = await transaction.execute(
          statement(
            "validate-github-operation-owner",
            {
              capabilityId: input.capabilityId,
              repository: input.repository,
              requiredCapability: capability,
              teamStepId: input.teamStepId,
              tenant: principal.tenant,
            },
            sql`SELECT "step"."id"
              FROM "RunnerTeamStep" AS "step"
              JOIN "RunnerGitHubCapability" AS "capability"
                ON "capability"."teamStepId" = "step"."id"
                AND "capability"."tenant" = "step"."tenant"
              WHERE "step"."id" = ${input.teamStepId}
                AND "step"."tenant" = ${principal.tenant}
                AND "capability"."id" = ${input.capabilityId}
                AND "capability"."revokedAt" IS NULL
                AND "capability"."expiresAt" > now()
                AND "capability"."usedCallCount" < "capability"."maxCallCount"
                AND "capability"."approvedCapabilities" @> CAST(${jsonParameter([capability])} AS jsonb)
                AND "capability"."repositoryAllowlist" @> CAST(${jsonParameter([input.repository])} AS jsonb)
              FOR SHARE OF "step"
              FOR UPDATE OF "capability"`
          )
        );
        if (!owner) {
          return { kind: "not_found" as const };
        }
        const [inserted] = await transaction.execute(
          statement(
            "insert-github-operation",
            {
              ...input,
              requiredCapability: capability,
              tenant: principal.tenant,
            },
            sql`WITH "inserted" AS (
                INSERT INTO "RunnerGitHubOperation" (
                  "id", "tenant", "teamStepId", "capabilityId", "operationId",
                  "kind", "requestHash", "target"
                )
                SELECT
                  ${input.id}, ${principal.tenant}, ${input.teamStepId}, ${input.capabilityId},
                  ${input.operationId}, ${input.kind}, ${input.requestHash}, ${input.target}
                FROM "RunnerGitHubCapability"
                WHERE "id" = ${input.capabilityId}
                  AND "tenant" = ${principal.tenant}
                  AND "teamStepId" = ${input.teamStepId}
                  AND "revokedAt" IS NULL
                  AND "expiresAt" > now()
                  AND "usedCallCount" < "maxCallCount"
                  AND "approvedCapabilities" @> CAST(${jsonParameter([capability])} AS jsonb)
                  AND "repositoryAllowlist" @> CAST(${jsonParameter([input.repository])} AS jsonb)
                ON CONFLICT ("teamStepId", "tenant", "operationId") DO NOTHING
                RETURNING *
              ),
              "consumed" AS (
                UPDATE "RunnerGitHubCapability" AS "capability"
                SET "usedCallCount" = "capability"."usedCallCount" + 1,
                    "version" = "capability"."version" + 1
                FROM "inserted"
                WHERE "capability"."id" = "inserted"."capabilityId"
                  AND "capability"."tenant" = "inserted"."tenant"
                RETURNING "capability"."id"
              )
              SELECT "inserted".*
              FROM "inserted"
              JOIN "consumed" ON "consumed"."id" = "inserted"."capabilityId"`
          )
        );
        if (inserted) {
          return {
            kind: "created" as const,
            operation: asGitHubOperation(inserted),
          };
        }
        const [raced] = await transaction.execute(
          statement(
            "get-raced-github-operation",
            {
              operationId: input.operationId,
              teamStepId: input.teamStepId,
              tenant: principal.tenant,
            },
            sql`SELECT * FROM "RunnerGitHubOperation"
              WHERE "teamStepId" = ${input.teamStepId}
                AND "tenant" = ${principal.tenant}
                AND "operationId" = ${input.operationId}
              FOR UPDATE`
          )
        );
        if (!raced) {
          return { kind: "not_found" as const };
        }
        const operation = asGitHubOperation(raced);
        return operation.requestHash === input.requestHash &&
          operation.kind === input.kind &&
          operation.capabilityId === input.capabilityId &&
          operation.target === input.target
          ? { kind: "duplicate" as const, operation }
          : { kind: "conflict" as const, operation };
      });
    },

    cancelTeamRun: (
      principal: RunnerPrincipal,
      input: { expectedVersion: number; id: string }
    ) =>
      database.transaction(async (transaction) => {
        assertVersion(input.expectedVersion);
        const [current] = await transaction.execute(
          statement(
            "lock-team-run-for-cancel",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerTeamRun"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" as const };
        }
        if (column<number>(current, "version") !== input.expectedVersion) {
          return { kind: "stale_version" as const };
        }
        if (
          [
            "completed",
            "completed_with_warnings",
            "failed",
            "cancelled",
          ].includes(column<string>(current, "status"))
        ) {
          return { kind: "already_terminal" as const };
        }
        const [updated] = await transaction.execute(
          statement(
            "cancel-team-run",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerTeamRun"
              SET "status" = 'cancelled',
                  "completedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "status" IN ('queued', 'running', 'waiting_approval')
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "stale_version" as const };
        }
        await transaction.execute(
          statement(
            "cancel-team-run-steps",
            { id: input.id, tenant: principal.tenant },
            sql`UPDATE "RunnerTeamStep"
              SET "status" = 'cancelled',
                  "completedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "teamRunId" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "status" IN ('pending', 'queued', 'running', 'waiting_approval')`
          )
        );
        const [hydrated] = await transaction.execute(
          statement(
            "get-cancelled-team-run",
            { id: input.id, tenant: principal.tenant },
            teamRunSelect(
              sql`"teamRun"."id" = ${input.id}
                AND "teamRun"."tenant" = ${principal.tenant}`,
              sql`LIMIT 1`
            )
          )
        );
        if (!hydrated) {
          throw new Error("Cancelled team run disappeared.");
        }
        return { kind: "updated" as const, value: asRun(hydrated) };
      }),

    completeGitHubOperation: async (
      principal: RunnerPrincipal,
      input: {
        error: RunError | null;
        expectedVersion: number;
        id: string;
        providerRequestId: string | null;
        resultNodeId: string | null;
        resultUrl: string | null;
        status: "completed" | "failed";
      }
    ) => {
      assertVersion(input.expectedVersion);
      validateReceipt(input);
      return await database.transaction(async (transaction) => {
        const [current] = await transaction.execute(
          statement(
            "lock-github-operation-for-completion",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerGitHubOperation"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" as const };
        }
        if (column<number>(current, "version") !== input.expectedVersion) {
          return { kind: "stale_version" as const };
        }
        if (
          !["pending", "running"].includes(column<string>(current, "status"))
        ) {
          return { kind: "already_terminal" as const };
        }
        const [updated] = await transaction.execute(
          statement(
            "complete-github-operation",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerGitHubOperation"
              SET "status" = ${input.status},
                  "providerRequestId" = ${input.providerRequestId},
                  "resultNodeId" = ${input.resultNodeId},
                  "resultUrl" = ${input.resultUrl},
                  "error" = CAST(${jsonParameter(input.error)} AS jsonb),
                  "startedAt" = COALESCE("startedAt", now()),
                  "completedAt" = now(),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "status" IN ('pending', 'running')
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated" as const, value: asGitHubOperation(updated) }
          : { kind: "stale_version" as const };
      });
    },

    createGitHubCapability: async (
      principal: RunnerPrincipal,
      input: CreateGitHubCapabilityInput
    ) => {
      validateCapabilityInput(input);
      return await database.transaction(async (transaction) => {
        const [step] = await transaction.execute(
          statement(
            "validate-github-capability-step",
            { teamStepId: input.teamStepId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerTeamStep"
              WHERE "id" = ${input.teamStepId}
                AND "tenant" = ${principal.tenant}
              FOR SHARE`
          )
        );
        if (!step) {
          return { kind: "not_found" as const };
        }
        const [capability] = await transaction.execute(
          statement(
            "insert-github-capability",
            { ...input, tenant: principal.tenant },
            sql`INSERT INTO "RunnerGitHubCapability" (
                "id", "tenant", "teamStepId", "tokenHash", "expiresAt",
                "approvedCapabilities", "repositoryAllowlist", "maxCallCount"
              ) VALUES (
                ${input.id}, ${principal.tenant}, ${input.teamStepId}, ${input.tokenHash},
                ${input.expiresAt.toISOString()},
                CAST(${jsonParameter(input.approvedCapabilities)} AS jsonb),
                CAST(${jsonParameter(input.repositoryAllowlist)} AS jsonb),
                ${input.maxCallCount}
              )
              ON CONFLICT DO NOTHING
              RETURNING *`
          )
        );
        return capability
          ? { capability: asCapability(capability), kind: "created" as const }
          : { kind: "conflict" as const };
      });
    },
    createSkill: async (
      principal: RunnerPrincipal,
      input: CreateSkillStoreInput
    ) => {
      validateSkillInput(input);
      return await database.transaction(async (transaction) => {
        const [row] = await transaction.execute(
          statement(
            "create-skill",
            { ...input, tenant: principal.tenant },
            sql`INSERT INTO "RunnerSkill" (
                "id", "tenant", "name", "description", "instructions", "requiredCapabilities"
              ) VALUES (
                ${input.id}, ${principal.tenant}, ${input.name}, ${input.description ?? ""},
                ${input.instructions}, CAST(${jsonParameter(input.requiredCapabilities ?? [])} AS jsonb)
              )
              ON CONFLICT DO NOTHING
              RETURNING *`
          )
        );
        return row
          ? { kind: "created" as const, skill: asSkill(row) }
          : { kind: "conflict" as const };
      });
    },

    createTeam: async (
      principal: RunnerPrincipal,
      input: CreateTeamStoreInput
    ) => {
      validateTeamInput(input);
      return await database.transaction(async (transaction) => {
        if (
          !(await validateTeamOwnership(
            transaction,
            principal.tenant,
            input.members
          ))
        ) {
          return { kind: "not_found" as const };
        }
        const [team] = await transaction.execute(
          statement(
            "insert-team",
            { ...input, members: undefined, tenant: principal.tenant },
            sql`INSERT INTO "RunnerTeam" ("id", "tenant", "name", "description")
              VALUES (
                ${input.id}, ${principal.tenant}, ${input.name}, ${input.description ?? ""}
              )
              ON CONFLICT DO NOTHING
              RETURNING *`
          )
        );
        if (!team) {
          return { kind: "conflict" as const };
        }
        const members = normalizedMembers(input.members);
        await insertTeamMembers(
          transaction,
          principal.tenant,
          input.id,
          members
        );
        return {
          kind: "created" as const,
          team: teamFromParts(team, members),
        };
      });
    },

    createTeamRun: async (
      principal: RunnerPrincipal,
      input: CreateTeamRunStoreInput
    ) => {
      assertUuid(input.id, "Team run id");
      assertUuid(input.teamId, "Team id");
      assertUuid(input.operationId, "Operation id");
      assertRequestHash(input.requestHash);
      if (
        !input.mission.trim() ||
        input.mission.length > TEAM_LIMITS.maxMissionLength
      ) {
        throw new Error("Team mission is invalid.");
      }
      if (
        input.stepIds.length < 1 ||
        input.stepIds.length > TEAM_LIMITS.maxMembers ||
        new Set(input.stepIds).size !== input.stepIds.length
      ) {
        throw new Error("Team step ids are invalid.");
      }
      for (const stepId of input.stepIds) {
        assertUuid(stepId, "Team step id");
      }

      return await database.transaction(async (transaction) => {
        const [team] = await transaction.execute(
          statement(
            "lock-team-for-run",
            { teamId: input.teamId, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerTeam"
              WHERE "id" = ${input.teamId}
                AND "tenant" = ${principal.tenant}
              FOR SHARE`
          )
        );
        if (!team) {
          return { kind: "not_found" as const };
        }
        const [existing] = await transaction.execute(
          statement(
            "get-team-run-operation",
            {
              operationId: input.operationId,
              teamId: input.teamId,
              tenant: principal.tenant,
            },
            teamRunSelect(
              sql`"teamRun"."teamId" = ${input.teamId}
                AND "teamRun"."tenant" = ${principal.tenant}
                AND "teamRun"."operationId" = ${input.operationId}`,
              sql`FOR UPDATE`
            )
          )
        );
        if (existing) {
          const run = asRun(existing);
          return run.requestHash === input.requestHash
            ? { kind: "duplicate" as const, run }
            : { kind: "conflict" as const, run };
        }
        const snapshots = await transaction.execute(
          statement(
            "load-team-run-snapshots",
            { teamId: input.teamId, tenant: principal.tenant },
            sql`SELECT
                "member"."id" AS "memberId",
                "member"."agentId",
                "member"."position",
                "member"."responsibility",
                "member"."required",
                COALESCE(
                  jsonb_agg("skill"."id" ORDER BY "skill"."id")
                    FILTER (WHERE "skill"."id" IS NOT NULL),
                  '[]'::jsonb
                ) AS "skillIds",
                COALESCE(
                  jsonb_agg(
                    jsonb_build_object(
                      'id', "skill"."id",
                      'name', "skill"."name",
                      'description', "skill"."description",
                      'instructions', "skill"."instructions",
                      'requiredCapabilities', "skill"."requiredCapabilities"
                    )
                    ORDER BY "skill"."id"
                  ) FILTER (WHERE "skill"."id" IS NOT NULL),
                  '[]'::jsonb
                ) AS "skillSnapshots"
              FROM "RunnerTeamMember" AS "member"
              LEFT JOIN "RunnerTeamMemberSkill" AS "memberSkill"
                ON "memberSkill"."memberId" = "member"."id"
                AND "memberSkill"."tenant" = "member"."tenant"
              LEFT JOIN "RunnerSkill" AS "skill"
                ON "skill"."id" = "memberSkill"."skillId"
                AND "skill"."tenant" = "memberSkill"."tenant"
              WHERE "member"."teamId" = ${input.teamId}
                AND "member"."tenant" = ${principal.tenant}
              GROUP BY "member"."id"
              ORDER BY "member"."position"`
          )
        );
        if (
          snapshots.length === 0 ||
          snapshots.length !== input.stepIds.length
        ) {
          throw new Error("Team membership changed while creating its run.");
        }
        const [inserted] = await transaction.execute(
          statement(
            "insert-team-run",
            { ...input, stepIds: undefined, tenant: principal.tenant },
            sql`INSERT INTO "RunnerTeamRun" (
                "id", "tenant", "teamId", "operationId", "requestHash", "mission"
              ) VALUES (
                ${input.id}, ${principal.tenant}, ${input.teamId}, ${input.operationId},
                ${input.requestHash}, ${input.mission}
              )
              ON CONFLICT ("teamId", "tenant", "operationId") DO NOTHING
              RETURNING *`
          )
        );
        if (!inserted) {
          const [raced] = await transaction.execute(
            statement(
              "get-raced-team-run-operation",
              {
                operationId: input.operationId,
                teamId: input.teamId,
                tenant: principal.tenant,
              },
              teamRunSelect(
                sql`"teamRun"."teamId" = ${input.teamId}
                  AND "teamRun"."tenant" = ${principal.tenant}
                  AND "teamRun"."operationId" = ${input.operationId}`,
                sql`FOR UPDATE`
              )
            )
          );
          if (!raced) {
            throw new Error("Team run operation conflict returned no row.");
          }
          const run = asRun(raced);
          return run.requestHash === input.requestHash
            ? { kind: "duplicate" as const, run }
            : { kind: "conflict" as const, run };
        }
        const stepPayload = snapshots.map((snapshot, position) => {
          const skillSnapshots = arrayColumn<TeamSkillSnapshot>(
            snapshot,
            "skillSnapshots"
          );
          return {
            agentId: column<string>(snapshot, "agentId"),
            approvalStatus: skillSnapshots.some(({ requiredCapabilities }) =>
              requiredCapabilities.some(
                (capability) =>
                  capability.startsWith("github.") &&
                  capability.endsWith(".write")
              )
            )
              ? "pending"
              : "not_required",
            id: input.stepIds[position],
            memberId: column<string>(snapshot, "memberId"),
            position: column<number>(snapshot, "position"),
            required: column<boolean>(snapshot, "required"),
            responsibility: column<string>(snapshot, "responsibility"),
            skillIds: arrayColumn<string>(snapshot, "skillIds"),
            skillSnapshots,
          };
        });
        const steps = await transaction.execute(
          statement(
            "insert-team-run-steps",
            {
              stepIds: input.stepIds,
              steps: stepPayload,
              teamRunId: input.id,
              tenant: principal.tenant,
            },
            sql`INSERT INTO "RunnerTeamStep" (
                "id", "tenant", "teamRunId", "memberId", "agentId", "position",
                "responsibility", "required", "skillIds", "skillSnapshots",
                "approvalStatus"
              )
              SELECT
                "step"."id", ${principal.tenant}, ${input.id}, "step"."memberId",
                "step"."agentId", "step"."position", "step"."responsibility",
                "step"."required", "step"."skillIds", "step"."skillSnapshots",
                "step"."approvalStatus"
              FROM jsonb_to_recordset(CAST(${jsonParameter(stepPayload)} AS jsonb))
                AS "step"(
                  "id" uuid,
                  "memberId" uuid,
                  "agentId" uuid,
                  "position" integer,
                  "responsibility" text,
                  "required" boolean,
                  "skillIds" jsonb,
                  "skillSnapshots" jsonb,
                  "approvalStatus" text
                )
              ORDER BY "position"
              RETURNING *`
          )
        );
        return {
          kind: "created" as const,
          run: asRun({ ...inserted, steps }),
        };
      });
    },

    decideTeamStepApproval: (
      principal: RunnerPrincipal,
      input: {
        decision: "approve" | "reject";
        expectedVersion: number;
        id: string;
      }
    ) =>
      database.transaction(async (transaction) => {
        assertVersion(input.expectedVersion);
        const [current] = await transaction.execute(
          statement(
            "lock-team-step-for-approval",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerTeamStep"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" as const };
        }
        if (column<number>(current, "version") !== input.expectedVersion) {
          return { kind: "stale_version" as const };
        }
        if (column(current, "approvalStatus") !== "pending") {
          return { kind: "invalid_transition" as const };
        }
        const approvalStatus =
          input.decision === "approve" ? "approved" : "rejected";
        const [updated] = await transaction.execute(
          statement(
            "decide-team-step-approval",
            { ...input, approvalStatus, tenant: principal.tenant },
            sql`UPDATE "RunnerTeamStep"
              SET "approvalStatus" = ${approvalStatus},
                  "status" = CASE
                    WHEN ${approvalStatus} = 'rejected' THEN 'failed'
                    ELSE "status"
                  END,
                  "error" = CASE
                    WHEN ${approvalStatus} = 'rejected'
                      THEN '{"code":"approval_rejected","message":"GitHub operation approval was rejected.","retryable":false}'::jsonb
                    ELSE "error"
                  END,
                  "completedAt" = CASE
                    WHEN ${approvalStatus} = 'rejected' THEN now()
                    ELSE "completedAt"
                  END,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND "approvalStatus" = 'pending'
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated" as const, value: asStep(updated) }
          : { kind: "stale_version" as const };
      }),

    deleteSkill: (
      principal: RunnerPrincipal,
      input: { expectedVersion: number; id: string }
    ) =>
      database.transaction(async (transaction) => {
        assertVersion(input.expectedVersion);
        const [current] = await transaction.execute(
          statement(
            "lock-skill-for-delete",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerSkill"
              WHERE "id" = ${input.id} AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" as const };
        }
        if (column<number>(current, "version") !== input.expectedVersion) {
          return { kind: "stale_version" as const };
        }
        const [reference] = await transaction.execute(
          statement(
            "find-skill-reference",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT "memberId" FROM "RunnerTeamMemberSkill"
              WHERE "skillId" = ${input.id}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        if (reference) {
          return { kind: "conflict" as const };
        }
        const [deleted] = await transaction.execute(
          statement(
            "delete-skill",
            { ...input, tenant: principal.tenant },
            sql`DELETE FROM "RunnerSkill"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
              RETURNING "id"`
          )
        );
        return deleted
          ? { kind: "deleted" as const }
          : { kind: "stale_version" as const };
      }),

    deleteTeam: (
      principal: RunnerPrincipal,
      input: { expectedVersion: number; id: string }
    ) =>
      database.transaction(async (transaction) => {
        assertVersion(input.expectedVersion);
        const [current] = await transaction.execute(
          statement(
            "lock-team-for-delete",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT "version" FROM "RunnerTeam"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" as const };
        }
        if (column<number>(current, "version") !== input.expectedVersion) {
          return { kind: "stale_version" as const };
        }
        const [reference] = await transaction.execute(
          statement(
            "find-team-run-reference",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerTeamRun"
              WHERE "teamId" = ${input.id}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        if (reference) {
          return { kind: "conflict" as const };
        }
        const [deleted] = await transaction.execute(
          statement(
            "delete-team",
            { ...input, tenant: principal.tenant },
            sql`DELETE FROM "RunnerTeam"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
              RETURNING "id"`
          )
        );
        return deleted
          ? { kind: "deleted" as const }
          : { kind: "stale_version" as const };
      }),

    getGitHubConnection: (principal: RunnerPrincipal, repositoryId: string) =>
      database.transaction(async (transaction) => {
        if (!DECIMAL_ID.test(repositoryId)) {
          throw new Error("GitHub repository id must be a decimal string.");
        }
        const [row] = await transaction.execute(
          statement(
            "get-github-connection",
            { repositoryId, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerGitHubConnection"
              WHERE "repositoryId" = ${repositoryId}
                AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return row ? asConnection(row) : null;
      }),

    getSkill: (principal: RunnerPrincipal, id: string) =>
      database.transaction(async (transaction) => {
        const [row] = await transaction.execute(
          statement(
            "get-skill",
            { id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerSkill"
              WHERE "id" = ${id} AND "tenant" = ${principal.tenant}
              LIMIT 1`
          )
        );
        return row ? asSkill(row) : null;
      }),

    getTeam: (principal: RunnerPrincipal, id: string) =>
      database.transaction(async (transaction) => {
        const [row] = await transaction.execute(
          statement(
            "get-team",
            { id, tenant: principal.tenant },
            teamSelect(
              sql`"team"."id" = ${id} AND "team"."tenant" = ${principal.tenant}`,
              sql`LIMIT 1`
            )
          )
        );
        return row ? asTeam(row) : null;
      }),

    getTeamRun: (principal: RunnerPrincipal, id: string) =>
      database.transaction(async (transaction) => {
        const [row] = await transaction.execute(
          statement(
            "get-team-run",
            { id, tenant: principal.tenant },
            teamRunSelect(
              sql`"teamRun"."id" = ${id}
                AND "teamRun"."tenant" = ${principal.tenant}`,
              sql`LIMIT 1`
            )
          )
        );
        return row ? asRun(row) : null;
      }),

    listSkills: (principal: RunnerPrincipal) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "list-skills",
            { tenant: principal.tenant },
            sql`SELECT * FROM "RunnerSkill"
              WHERE "tenant" = ${principal.tenant}
              ORDER BY "updatedAt" DESC, "id"`
          )
        );
        return rows.map(asSkill);
      }),

    listTeamRuns: (principal: RunnerPrincipal, teamId: string) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "list-team-runs",
            { teamId, tenant: principal.tenant },
            teamRunSelect(
              sql`"teamRun"."teamId" = ${teamId}
                AND "teamRun"."tenant" = ${principal.tenant}`,
              sql`ORDER BY "teamRun"."createdAt" DESC, "teamRun"."id"`
            )
          )
        );
        return rows.map(asRun);
      }),

    listTeams: (principal: RunnerPrincipal) =>
      database.transaction(async (transaction) => {
        const rows = await transaction.execute(
          statement(
            "list-teams",
            { tenant: principal.tenant },
            teamSelect(
              sql`"team"."tenant" = ${principal.tenant}`,
              sql`ORDER BY "team"."updatedAt" DESC, "team"."id"`
            )
          )
        );
        return rows.map(asTeam);
      }),

    revokeGitHubCapability: (
      principal: RunnerPrincipal,
      input: { expectedVersion: number; id: string }
    ) =>
      database.transaction(async (transaction) => {
        assertVersion(input.expectedVersion);
        const [updated] = await transaction.execute(
          statement(
            "revoke-github-capability",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerGitHubCapability"
              SET "revokedAt" = COALESCE("revokedAt", now()),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
              RETURNING *`
          )
        );
        if (updated) {
          return { kind: "updated" as const, value: asCapability(updated) };
        }
        const [current] = await transaction.execute(
          statement(
            "get-github-capability-after-revoke",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT "id" FROM "RunnerGitHubCapability"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}`
          )
        );
        return current
          ? { kind: "stale_version" as const }
          : { kind: "not_found" as const };
      }),

    updateSkill: (principal: RunnerPrincipal, input: UpdateSkillStoreInput) =>
      database.transaction(async (transaction) => {
        const [current] = await transaction.execute(
          statement(
            "lock-skill-for-update",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerSkill"
              WHERE "id" = ${input.id} AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" as const };
        }
        if (column<number>(current, "version") !== input.expectedVersion) {
          return { kind: "stale_version" as const };
        }
        validateSkillInput(input);
        assertVersion(input.expectedVersion);
        const [updated] = await transaction.execute(
          statement(
            "update-skill",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerSkill"
              SET "name" = ${input.name},
                  "description" = ${input.description ?? ""},
                  "instructions" = ${input.instructions},
                  "requiredCapabilities" = CAST(${jsonParameter(input.requiredCapabilities ?? [])} AS jsonb),
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated" as const, value: asSkill(updated) }
          : { kind: "stale_version" as const };
      }),

    updateTeam: (principal: RunnerPrincipal, input: UpdateTeamStoreInput) =>
      database.transaction(async (transaction) => {
        assertVersion(input.expectedVersion);
        const [current] = await transaction.execute(
          statement(
            "lock-team-for-update",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerTeam"
              WHERE "id" = ${input.id} AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" as const };
        }
        if (column<number>(current, "version") !== input.expectedVersion) {
          return { kind: "stale_version" as const };
        }
        validateTeamInput(input);
        if (
          !(await validateTeamOwnership(
            transaction,
            principal.tenant,
            input.members
          ))
        ) {
          return { kind: "not_found" as const };
        }
        const [updated] = await transaction.execute(
          statement(
            "update-team",
            { ...input, members: undefined, tenant: principal.tenant },
            sql`UPDATE "RunnerTeam"
              SET "name" = ${input.name},
                  "description" = ${input.description ?? ""},
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
              RETURNING *`
          )
        );
        if (!updated) {
          return { kind: "stale_version" as const };
        }
        await transaction.execute(
          statement(
            "delete-team-member-skills",
            { teamId: input.id, tenant: principal.tenant },
            sql`DELETE FROM "RunnerTeamMemberSkill"
              WHERE "tenant" = ${principal.tenant}
                AND "memberId" IN (
                  SELECT "id" FROM "RunnerTeamMember"
                  WHERE "teamId" = ${input.id}
                    AND "tenant" = ${principal.tenant}
                )`
          )
        );
        await transaction.execute(
          statement(
            "delete-team-members",
            { teamId: input.id, tenant: principal.tenant },
            sql`DELETE FROM "RunnerTeamMember"
              WHERE "teamId" = ${input.id}
                AND "tenant" = ${principal.tenant}`
          )
        );
        const members = normalizedMembers(input.members);
        await insertTeamMembers(
          transaction,
          principal.tenant,
          input.id,
          members
        );
        return {
          kind: "updated" as const,
          value: teamFromParts(updated, members),
        };
      }),

    updateTeamStep: async (
      principal: RunnerPrincipal,
      input: UpdateTeamStepStoreInput
    ) => {
      assertVersion(input.expectedVersion);
      if (input.handoff !== null) {
        const result = teamHandoffSchema.safeParse(input.handoff);
        if (!result.success) {
          throw new Error(`Invalid team handoff: ${result.error.message}`);
        }
        if (jsonByteLength(result.data) > TEAM_LIMITS.maxHandoffLength) {
          throw new Error(
            "Invalid team handoff: serialized value is too large."
          );
        }
      }
      if (input.error !== null) {
        runErrorSchema.parse(input.error);
      }
      return await database.transaction(async (transaction) => {
        const [current] = await transaction.execute(
          statement(
            "lock-team-step-for-update",
            { id: input.id, tenant: principal.tenant },
            sql`SELECT * FROM "RunnerTeamStep"
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
              FOR UPDATE`
          )
        );
        if (!current) {
          return { kind: "not_found" as const };
        }
        if (column<number>(current, "version") !== input.expectedVersion) {
          return { kind: "stale_version" as const };
        }
        const currentStatus = column<TeamStepStatus>(current, "status");
        if (!validStepTransition(currentStatus, input.status)) {
          return { kind: "invalid_transition" as const };
        }
        const currentApprovalStatus = column<TeamApprovalStatus>(
          current,
          "approvalStatus"
        );
        if (currentApprovalStatus !== input.approvalStatus) {
          return { kind: "invalid_transition" as const };
        }
        if (
          (input.status === "waiting_approval" &&
            currentApprovalStatus !== "pending") ||
          (currentStatus === "waiting_approval" &&
            currentApprovalStatus === "pending" &&
            !["waiting_approval", "failed", "cancelled"].includes(input.status))
        ) {
          return { kind: "invalid_transition" as const };
        }
        const currentRunnerRunId = column<string | null>(
          current,
          "runnerRunId"
        );
        if (
          currentRunnerRunId !== null &&
          input.runnerRunId !== currentRunnerRunId
        ) {
          return { kind: "invalid_transition" as const };
        }
        const [updated] = await transaction.execute(
          statement(
            "update-team-step",
            { ...input, tenant: principal.tenant },
            sql`UPDATE "RunnerTeamStep"
              SET "status" = ${input.status},
                  "approvalStatus" = ${input.approvalStatus},
                  "runnerRunId" = ${input.runnerRunId},
                  "handoff" = CAST(${jsonParameter(input.handoff)} AS jsonb),
                  "error" = CAST(${jsonParameter(input.error)} AS jsonb),
                  "startedAt" = CASE
                    WHEN ${input.status} IN ('running', 'waiting_approval', 'completed', 'failed')
                      THEN COALESCE("startedAt", now())
                    ELSE "startedAt"
                  END,
                  "completedAt" = CASE
                    WHEN ${input.status} IN ('completed', 'failed', 'cancelled', 'skipped')
                      THEN COALESCE("completedAt", now())
                    ELSE NULL
                  END,
                  "updatedAt" = now(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${principal.tenant}
                AND "version" = ${input.expectedVersion}
                AND (
                  ${jsonParameter(input.handoff)}::jsonb IS NULL
                  OR (
                    SELECT COALESCE(sum(octet_length("other"."handoff"::text)), 0)
                    FROM "RunnerTeamStep" AS "other"
                    WHERE "other"."teamRunId" = "RunnerTeamStep"."teamRunId"
                      AND "other"."tenant" = ${principal.tenant}
                      AND "other"."id" <> ${input.id}
                  ) + octet_length(${jsonParameter(input.handoff)}::jsonb::text)
                    <= ${TEAM_LIMITS.maxTotalHandoffLength}
                )
              RETURNING *`
          )
        );
        return updated
          ? { kind: "updated" as const, value: asStep(updated) }
          : { kind: "handoff_limit" as const };
      });
    },

    upsertGitHubConnection: async (
      principal: RunnerPrincipal,
      input: {
        accountId: string;
        accountLogin: string;
        accountType: "Organization" | "User";
        id: string;
        installationId: string;
        repositoryId: string;
        repositoryName: string;
        repositoryNodeId: string;
        repositoryOwner: string;
      }
    ) => {
      validateConnectionInput(input);
      return await database.transaction(async (transaction) => {
        const [connection] = await transaction.execute(
          statement(
            "upsert-github-connection",
            { ...input, tenant: principal.tenant },
            sql`INSERT INTO "RunnerGitHubConnection" (
                "id", "tenant", "installationId", "accountId", "accountLogin",
                "accountType", "repositoryId", "repositoryNodeId",
                "repositoryOwner", "repositoryName"
              ) VALUES (
                ${input.id}, ${principal.tenant}, ${input.installationId}, ${input.accountId},
                ${input.accountLogin}, ${input.accountType}, ${input.repositoryId},
                ${input.repositoryNodeId}, ${input.repositoryOwner}, ${input.repositoryName}
              )
              ON CONFLICT ("tenant", "repositoryId") DO UPDATE
              SET "installationId" = EXCLUDED."installationId",
                  "accountId" = EXCLUDED."accountId",
                  "accountLogin" = EXCLUDED."accountLogin",
                  "accountType" = EXCLUDED."accountType",
                  "repositoryNodeId" = EXCLUDED."repositoryNodeId",
                  "repositoryOwner" = EXCLUDED."repositoryOwner",
                  "repositoryName" = EXCLUDED."repositoryName",
                  "updatedAt" = now(),
                  "version" = "RunnerGitHubConnection"."version" + 1
              RETURNING *`
          )
        );
        if (!connection) {
          throw new Error("GitHub connection upsert returned no row.");
        }
        return { connection: asConnection(connection) };
      });
    },
  };
}
