// biome-ignore-all lint/suspicious/useAwait: Database transaction callbacks intentionally preserve async store interfaces.
import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type GitHubOperationKind,
  type GitHubToolOperation,
  type GitHubToolResult,
  githubToolOperationSchema,
  githubToolResultSchema,
  type RunError,
  runErrorSchema,
  type TeamCapability,
} from "@opencoven/agent-contracts";
import { type SQL, sql } from "drizzle-orm";
import type { RunnerOperator } from "@/lib/runner/types";
import type {
  GitHubConnectionSnapshot,
  TeamStoreDatabase,
  TeamStoreStatement,
} from "@/lib/teams/store";
import {
  githubOperationAuthority,
  githubOperationRepository,
} from "./operations";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TENANT = /^[A-Za-z0-9_]{1,64}$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const NODE_ID = /^[A-Za-z0-9_=-]{1,256}$/u;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]{1,100}$/u;
const TOKEN_HASH = /^[a-f0-9]{64}$/u;
const OPERATION_MARKER = /^<!-- coven-github:v1:[a-f0-9]{40} -->$/u;
const REQUEST_ID = /^[A-Za-z0-9:-]{1,128}$/u;
const PUBLIC_URL = /^https:\/\/github\.com\//u;
const GITHUB_CAPABILITIES = new Set<TeamCapability>([
  "github.issues.read",
  "github.issues.write",
  "github.pull_requests.read",
  "github.pull_requests.write",
  "github.projects.read",
  "github.projects.write",
]);
const MAX_REPOSITORIES = 16;
export const MAX_GITHUB_CAPABILITY_CALLS = 32;
export const MAX_GITHUB_CAPABILITY_LIFETIME_MS = 15 * 60_000;
export const MAX_GITHUB_OPERATION_LEASE_MS = 30_000;

export type GitHubBrokerRepository = Readonly<{
  accountId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  connectionId: string;
  installationId: string;
  repository: string;
  repositoryId: string;
  repositoryName: string;
  repositoryNodeId: string;
  repositoryOwner: string;
}>;

export type GitHubBrokerPolicy = Readonly<{
  actorUserId: string;
  allowedCapabilities: readonly TeamCapability[];
  approvedCapabilities: readonly TeamCapability[];
  authVersion: number;
  connectionGeneration: number;
  declaredCapabilities: readonly TeamCapability[];
  maxCallCount: number;
  repositories: readonly GitHubBrokerRepository[];
  teamRunId: string;
  teamStepId: string;
  version: 1;
}>;

type BuildGitHubBrokerPolicyInput = Readonly<{
  actorUserId: string;
  approvedCapabilities: readonly TeamCapability[];
  authVersion: number;
  connectionSnapshot: GitHubConnectionSnapshot;
  declaredCapabilities: readonly TeamCapability[];
  teamRunId: string;
  teamStepId: string;
}>;

function assertExactObject(
  value: object,
  expectedKeys: readonly string[],
  label: string
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} contains unexpected fields.`);
  }
}

function distinctSortedCapabilities(
  capabilities: readonly TeamCapability[]
): TeamCapability[] {
  return [...new Set(capabilities)].sort();
}

function assertIdentity(input: BuildGitHubBrokerPolicyInput): void {
  if (
    !UUID.test(input.teamRunId) ||
    !UUID.test(input.teamStepId) ||
    !UUID.test(input.actorUserId) ||
    !Number.isSafeInteger(input.authVersion) ||
    input.authVersion < 0
  ) {
    throw new Error("GitHub broker policy identity is invalid.");
  }
}

function brokerRepository(
  connection: GitHubConnectionSnapshot["connections"][number]
): GitHubBrokerRepository {
  if (
    !UUID.test(connection.id) ||
    !DECIMAL_ID.test(connection.accountId) ||
    !DECIMAL_ID.test(connection.installationId) ||
    !DECIMAL_ID.test(connection.repositoryId) ||
    !NODE_ID.test(connection.repositoryNodeId) ||
    !REPOSITORY_PART.test(connection.accountLogin) ||
    !REPOSITORY_PART.test(connection.repositoryOwner) ||
    !REPOSITORY_PART.test(connection.repositoryName) ||
    (connection.accountType !== "Organization" &&
      connection.accountType !== "User")
  ) {
    throw new Error("GitHub broker repository connection is invalid.");
  }
  return {
    accountId: connection.accountId,
    accountLogin: connection.accountLogin,
    accountType: connection.accountType,
    connectionId: connection.id,
    installationId: connection.installationId,
    repository: `${connection.repositoryOwner.toLowerCase()}/${connection.repositoryName.toLowerCase()}`,
    repositoryId: connection.repositoryId,
    repositoryName: connection.repositoryName,
    repositoryNodeId: connection.repositoryNodeId,
    repositoryOwner: connection.repositoryOwner,
  };
}

export function buildGitHubBrokerPolicy(
  input: BuildGitHubBrokerPolicyInput
): GitHubBrokerPolicy {
  assertExactObject(
    input,
    [
      "actorUserId",
      "approvedCapabilities",
      "authVersion",
      "connectionSnapshot",
      "declaredCapabilities",
      "teamRunId",
      "teamStepId",
    ],
    "GitHub broker policy input"
  );
  assertIdentity(input);
  if (
    !Number.isSafeInteger(input.connectionSnapshot.generation) ||
    input.connectionSnapshot.generation < 0
  ) {
    throw new Error("GitHub connection generation is invalid.");
  }
  if (
    input.connectionSnapshot.connections.length < 1 ||
    input.connectionSnapshot.connections.length > MAX_REPOSITORIES
  ) {
    throw new Error(
      "GitHub broker policy requires a bounded connection repository set."
    );
  }

  const declaredCapabilities = distinctSortedCapabilities(
    input.declaredCapabilities.filter((capability) =>
      GITHUB_CAPABILITIES.has(capability)
    )
  );
  if (declaredCapabilities.length === 0) {
    throw new Error(
      "GitHub broker policy requires a declared GitHub capability."
    );
  }
  const approvedCapabilities = distinctSortedCapabilities(
    input.approvedCapabilities.filter(
      (capability) =>
        capability.endsWith(".write") &&
        GITHUB_CAPABILITIES.has(capability) &&
        declaredCapabilities.includes(capability)
    )
  );
  const allowedCapabilities = declaredCapabilities.filter(
    (capability) =>
      capability.endsWith(".read") || approvedCapabilities.includes(capability)
  );
  if (allowedCapabilities.length === 0) {
    throw new Error("GitHub broker policy grants no executable capability.");
  }

  const repositories = input.connectionSnapshot.connections
    .map(brokerRepository)
    .sort((left, right) => left.repository.localeCompare(right.repository));
  if (
    new Set(repositories.map(({ repository }) => repository)).size !==
    repositories.length
  ) {
    throw new Error("GitHub broker repository allowlist contains duplicates.");
  }

  return {
    actorUserId: input.actorUserId,
    allowedCapabilities,
    approvedCapabilities,
    authVersion: input.authVersion,
    connectionGeneration: input.connectionSnapshot.generation,
    declaredCapabilities,
    maxCallCount: MAX_GITHUB_CAPABILITY_CALLS,
    repositories,
    teamRunId: input.teamRunId,
    teamStepId: input.teamStepId,
    version: 1,
  };
}

export function githubTaskCapability(
  policy: GitHubBrokerPolicy | null
): "none" | "read" | "write" {
  if (!policy) {
    return "none";
  }
  return policy.allowedCapabilities.some((capability) =>
    capability.endsWith(".write")
  )
    ? "write"
    : "read";
}

export type ReplaceGitHubCapabilityInput = Readonly<{
  attemptId: string;
  expiresAt: Date;
  id: string;
  policy: GitHubBrokerPolicy;
  runnerRunId: string;
  tenant: string;
  tokenHash: string;
  userId: string;
}>;

export type GitHubCapabilityIssuerDependencies = Readonly<{
  randomBytes?: (size: number) => Uint8Array;
  replaceCapability: (
    input: ReplaceGitHubCapabilityInput
  ) => Promise<Readonly<{ kind: "conflict" | "created" }>>;
}>;

export async function issueGitHubStepCapability(
  input: Readonly<{
    attemptId: string;
    capabilityId: string;
    expiresAt: Date;
    now: Date;
    policy: GitHubBrokerPolicy;
    runnerRunId: string;
    tenant: string;
    userId: string;
  }>,
  dependencies: GitHubCapabilityIssuerDependencies
): Promise<
  Readonly<{ capabilityId: string; expiresAt: Date; rawToken: string }>
> {
  if (
    !UUID.test(input.attemptId) ||
    !UUID.test(input.capabilityId) ||
    !UUID.test(input.runnerRunId) ||
    !UUID.test(input.userId) ||
    !TENANT.test(input.tenant) ||
    input.policy.teamStepId.length === 0 ||
    input.policy.actorUserId !== input.userId ||
    input.policy.authVersion < 0 ||
    Number.isNaN(input.now.valueOf()) ||
    Number.isNaN(input.expiresAt.valueOf()) ||
    input.expiresAt <= input.now ||
    input.expiresAt.getTime() - input.now.getTime() >
      MAX_GITHUB_CAPABILITY_LIFETIME_MS
  ) {
    throw new Error("GitHub step capability expiry or binding is invalid.");
  }

  const entropy = (dependencies.randomBytes ?? randomBytes)(32);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) {
    throw new Error("GitHub step capability entropy must be 256 bits.");
  }
  const ownedEntropy = Buffer.from(entropy);
  const rawToken = ownedEntropy.toString("base64url");
  ownedEntropy.fill(0);
  const tokenHash = createHash("sha256").update(rawToken, "utf8").digest("hex");
  if (!TOKEN_HASH.test(tokenHash)) {
    throw new Error("GitHub step capability hashing failed.");
  }

  const replaced = await dependencies.replaceCapability({
    attemptId: input.attemptId,
    expiresAt: input.expiresAt,
    id: input.capabilityId,
    policy: input.policy,
    runnerRunId: input.runnerRunId,
    tenant: input.tenant,
    tokenHash,
    userId: input.userId,
  });
  if (replaced.kind !== "created") {
    throw new Error("GitHub step capability issuance was fenced.");
  }
  return {
    capabilityId: input.capabilityId,
    expiresAt: input.expiresAt,
    rawToken,
  };
}

export type GitHubGatewayCapabilityRecord = Readonly<{
  allowedCapabilities: readonly TeamCapability[];
  approvedCapabilities: readonly TeamCapability[];
  attemptId: string;
  authVersion: number;
  connectionGeneration: number;
  createdAt: Date;
  declaredCapabilities: readonly TeamCapability[];
  expiresAt: Date;
  id: string;
  maxCallCount: number;
  repositoryAllowlist: readonly string[];
  revokedAt: Date | null;
  runnerRunId: string;
  teamRunId: string;
  teamStepId: string;
  tenant: string;
  tokenHash: string;
  usedCallCount: number;
  version: number;
}>;

export type GitHubGatewayOperationRecord = Readonly<{
  capabilityId: string;
  completedAt: Date | null;
  connectionGeneration: number;
  connectionId: string;
  createdAt: Date;
  error: RunError | null;
  executionLeaseExpiresAt: Date;
  id: string;
  kind: GitHubOperationKind;
  operationId: string;
  operationMarker: string | null;
  providerRequestId: string | null;
  repository: string;
  requestHash: string;
  requiredCapability: TeamCapability;
  result: GitHubToolResult | null;
  resultNodeId: string | null;
  resultUrl: string | null;
  startedAt: Date;
  status: "completed" | "failed" | "running";
  target: string;
  teamStepId: string;
  tenant: string;
  updatedAt: Date;
  version: number;
}>;

export type GitHubOperationExecutionContext = Readonly<{
  accountId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  capability: GitHubGatewayCapabilityRecord;
  connectionId: string;
  installationId: string;
  operation: GitHubGatewayOperationRecord;
  repositoryId: string;
  repositoryName: string;
  repositoryNodeId: string;
  repositoryOwner: string;
}>;

function statement(
  name: string,
  args: Readonly<Record<string, unknown>>,
  query: SQL
): TeamStoreStatement {
  return { args, name, query };
}

function column<T>(row: Record<string, unknown>, name: string): T {
  if (!(name in row)) {
    throw new Error(`GitHub gateway query omitted "${name}".`);
  }
  return row[name] as T;
}

function dateColumn(row: Record<string, unknown>, name: string): Date {
  const value = column<unknown>(row, name);
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.valueOf())) {
    throw new Error(`GitHub gateway query returned an invalid "${name}".`);
  }
  return date;
}

function nullableDateColumn(
  row: Record<string, unknown>,
  name: string
): Date | null {
  const value = column<unknown>(row, name);
  return value === null ? null : dateColumn(row, name);
}

function asCapability(
  row: Record<string, unknown>
): GitHubGatewayCapabilityRecord {
  return {
    allowedCapabilities: column(row, "allowedCapabilities"),
    approvedCapabilities: column(row, "approvedCapabilities"),
    attemptId: column(row, "attemptId"),
    authVersion: column(row, "authVersion"),
    connectionGeneration: Number(column(row, "connectionGeneration")),
    createdAt: dateColumn(row, "createdAt"),
    declaredCapabilities: column(row, "declaredCapabilities"),
    expiresAt: dateColumn(row, "expiresAt"),
    id: column(row, "id"),
    maxCallCount: column(row, "maxCallCount"),
    repositoryAllowlist: column(row, "repositoryAllowlist"),
    revokedAt: nullableDateColumn(row, "revokedAt"),
    runnerRunId: column(row, "runnerRunId"),
    teamRunId: column(row, "teamRunId"),
    teamStepId: column(row, "teamStepId"),
    tenant: column(row, "tenant"),
    tokenHash: column(row, "tokenHash"),
    usedCallCount: column(row, "usedCallCount"),
    version: column(row, "version"),
  };
}

function asOperation(
  row: Record<string, unknown>
): GitHubGatewayOperationRecord {
  const result = column<unknown>(row, "resultJson");
  return {
    capabilityId: column(row, "capabilityId"),
    completedAt: nullableDateColumn(row, "completedAt"),
    connectionGeneration: Number(column(row, "connectionGeneration")),
    connectionId: column(row, "connectionId"),
    createdAt: dateColumn(row, "createdAt"),
    error: column(row, "error"),
    executionLeaseExpiresAt: dateColumn(row, "executionLeaseExpiresAt"),
    id: column(row, "id"),
    kind: column(row, "kind"),
    operationId: column(row, "operationId"),
    operationMarker: column(row, "operationMarker"),
    providerRequestId: column(row, "providerRequestId"),
    repository: column(row, "repository"),
    requestHash: column(row, "requestHash"),
    requiredCapability: column(row, "requiredCapability"),
    result: result === null ? null : githubToolResultSchema.parse(result),
    resultNodeId: column(row, "resultNodeId"),
    resultUrl: column(row, "resultUrl"),
    startedAt: dateColumn(row, "startedAt"),
    status: column(row, "status"),
    target: column(row, "target"),
    teamStepId: column(row, "teamStepId"),
    tenant: column(row, "tenant"),
    updatedAt: dateColumn(row, "updatedAt"),
    version: column(row, "version"),
  };
}

function exactCapabilities(
  left: readonly TeamCapability[],
  right: readonly TeamCapability[]
): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function tokenHashesMatch(actual: string, expected: string): boolean {
  if (!(TOKEN_HASH.test(actual) && TOKEN_HASH.test(expected))) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex")
  );
}

function assertOperator(operator: RunnerOperator): void {
  if (operator.kind !== "runner-operator") {
    throw new Error("GitHub gateway requires runner operator authority.");
  }
}

function operationMatches(
  operation: GitHubGatewayOperationRecord,
  input: Readonly<{
    capabilityId: string;
    kind: GitHubOperationKind;
    operationMarker: string | null;
    repository: string;
    requestHash: string;
    requiredCapability: TeamCapability;
    target: string;
    teamStepId: string;
  }>
): boolean {
  return (
    operation.capabilityId === input.capabilityId &&
    operation.teamStepId === input.teamStepId &&
    operation.kind === input.kind &&
    operation.requestHash === input.requestHash &&
    operation.repository === input.repository &&
    operation.requiredCapability === input.requiredCapability &&
    operation.target === input.target &&
    operation.operationMarker === input.operationMarker
  );
}

function contextFromRows(
  row: Record<string, unknown>,
  operation: GitHubGatewayOperationRecord
): GitHubOperationExecutionContext {
  return {
    accountId: column(row, "accountId"),
    accountLogin: column(row, "accountLogin"),
    accountType: column(row, "accountType"),
    capability: asCapability(row),
    connectionId: column(row, "connectionId"),
    installationId: column(row, "installationId"),
    operation,
    repositoryId: column(row, "repositoryId"),
    repositoryName: column(row, "repositoryName"),
    repositoryNodeId: column(row, "repositoryNodeId"),
    repositoryOwner: column(row, "repositoryOwner"),
  };
}

function capabilityAuthorityIsLive(
  row: Record<string, unknown>,
  inputHash: string,
  requiredCapability: TeamCapability,
  classification: "read" | "write",
  repository: string
): boolean {
  const capability = asCapability(row);
  const databaseNow = dateColumn(row, "databaseNow");
  const runnerBrokerPolicy = column<GitHubBrokerPolicy | null>(
    row,
    "runnerBrokerPolicy"
  );
  const stepDeclaredCapabilities = column<readonly TeamCapability[]>(
    row,
    "stepDeclaredCapabilities"
  );
  const stepApprovedCapabilities = column<readonly TeamCapability[]>(
    row,
    "stepApprovedCapabilities"
  );
  return (
    tokenHashesMatch(capability.tokenHash, inputHash) &&
    capability.revokedAt === null &&
    capability.expiresAt > databaseNow &&
    capability.repositoryAllowlist.includes(repository) &&
    capability.allowedCapabilities.includes(requiredCapability) &&
    capability.declaredCapabilities.includes(requiredCapability) &&
    column(row, "runnerRunId") === capability.runnerRunId &&
    column(row, "runnerStatus") === "running" &&
    column(row, "runnerDispatchState") === "running" &&
    column(row, "runnerCancellationRequestedAt") === null &&
    column(row, "runnerAttemptId") === capability.attemptId &&
    column(row, "currentAuthVersion") === capability.authVersion &&
    column(row, "currentConnectionGeneration") ===
      capability.connectionGeneration &&
    runnerBrokerPolicy !== null &&
    JSON.stringify(runnerBrokerPolicy) ===
      JSON.stringify(column(row, "persistedBrokerPolicy")) &&
    runnerBrokerPolicy.connectionGeneration ===
      capability.connectionGeneration &&
    runnerBrokerPolicy.authVersion === capability.authVersion &&
    column(row, "actorUserId") === runnerBrokerPolicy.actorUserId &&
    runnerBrokerPolicy.teamStepId === capability.teamStepId &&
    runnerBrokerPolicy.teamRunId === capability.teamRunId &&
    exactCapabilities(
      capability.declaredCapabilities,
      runnerBrokerPolicy.declaredCapabilities
    ) &&
    exactCapabilities(
      capability.approvedCapabilities,
      runnerBrokerPolicy.approvedCapabilities
    ) &&
    exactCapabilities(
      capability.allowedCapabilities,
      runnerBrokerPolicy.allowedCapabilities
    ) &&
    capability.repositoryAllowlist.length ===
      runnerBrokerPolicy.repositories.length &&
    capability.repositoryAllowlist.every((repositoryName) =>
      runnerBrokerPolicy.repositories.some(
        ({ repository: policyRepository }) =>
          policyRepository === repositoryName
      )
    ) &&
    column(row, "stepStatus") === "running" &&
    column(row, "teamRunStatus") === "running" &&
    exactCapabilities(
      capability.declaredCapabilities,
      stepDeclaredCapabilities
    ) &&
    (classification === "read" ||
      (capability.approvedCapabilities.includes(requiredCapability) &&
        column(row, "stepApprovalStatus") === "approved" &&
        stepApprovedCapabilities.includes(requiredCapability)))
  );
}

export function createGitHubGatewayStore(database: TeamStoreDatabase) {
  return {
    authorizeMutation: async (
      operator: RunnerOperator,
      input: Readonly<{ expectedVersion: number; id: string }>
    ): Promise<Readonly<{ kind: "authorized" | "unauthorized" }>> => {
      assertOperator(operator);
      if (
        !UUID.test(input.id) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0
      ) {
        throw new Error("GitHub mutation authorization input is invalid.");
      }
      return database.transaction(async (transaction) => {
        const [authorized] = await transaction.execute(
          statement(
            "authorize-github-provider-mutation",
            input,
            sql`SELECT "operation"."id"
              FROM "RunnerGitHubOperation" AS "operation"
              JOIN "RunnerGitHubCapability" AS "capability"
                ON "capability"."id" = "operation"."capabilityId"
                AND "capability"."tenant" = "operation"."tenant"
                AND "capability"."teamStepId" = "operation"."teamStepId"
              JOIN "RunnerRun" AS "runnerRun"
                ON "runnerRun"."id" = "capability"."runnerRunId"
                AND "runnerRun"."tenant" = "capability"."tenant"
                AND "runnerRun"."teamStepId" = "capability"."teamStepId"
              JOIN "RunnerTeamStep" AS "step"
                ON "step"."id" = "capability"."teamStepId"
                AND "step"."tenant" = "capability"."tenant"
                AND "step"."runnerRunId" = "runnerRun"."id"
              JOIN "RunnerTeamRun" AS "teamRun"
                ON "teamRun"."id" = "capability"."teamRunId"
                AND "teamRun"."tenant" = "capability"."tenant"
                AND "teamRun"."id" = "step"."teamRunId"
              JOIN "User" AS "actor"
                ON "actor"."id" = "teamRun"."createdByUserId"
              JOIN "RunnerGitHubConnectionFence" AS "connectionFence"
                ON "connectionFence"."tenant" = "capability"."tenant"
              JOIN "RunnerGitHubConnection" AS "connection"
                ON "connection"."id" = "operation"."connectionId"
                AND "connection"."tenant" = "operation"."tenant"
              WHERE "operation"."id" = ${input.id}
                AND "operation"."version" = ${input.expectedVersion}
                AND "operation"."status" = 'running'
                AND "operation"."executionLeaseExpiresAt" > clock_timestamp()
                AND "operation"."connectionGeneration" =
                  "capability"."connectionGeneration"
                AND "capability"."revokedAt" IS NULL
                AND "capability"."expiresAt" > clock_timestamp()
                AND "capability"."allowedCapabilities" ?
                  "operation"."requiredCapability"
                AND "capability"."declaredCapabilities" ?
                  "operation"."requiredCapability"
                AND "capability"."repositoryAllowlist" ?
                  "operation"."repository"
                AND "runnerRun"."githubBrokerPolicy" IS NOT NULL
                AND "runnerRun"."githubBrokerPolicy"->'allowedCapabilities' ?
                  "operation"."requiredCapability"
                AND "runnerRun"."daytonaAttemptId" = "capability"."attemptId"
                AND "runnerRun"."authVersion" = "capability"."authVersion"
                AND "runnerRun"."cancellationRequestedAt" IS NULL
                AND "runnerRun"."status" = 'running'
                AND "runnerRun"."dispatchState" = 'running'
                AND "actor"."authVersion" = "capability"."authVersion"
                AND "connectionFence"."generation" =
                  "capability"."connectionGeneration"
                AND "step"."status" = 'running'
                AND "teamRun"."status" = 'running'
                AND (
                  "operation"."requiredCapability" LIKE '%.read'
                  OR (
                    "step"."approvalStatus" = 'approved'
                    AND "step"."approvedCapabilities" ?
                      "operation"."requiredCapability"
                    AND "capability"."approvedCapabilities" ?
                      "operation"."requiredCapability"
                  )
                )
              FOR SHARE OF "operation", "capability", "runnerRun", "step",
                "teamRun", "connectionFence", "connection", "actor"`
          )
        );
        return authorized
          ? { kind: "authorized" as const }
          : { kind: "unauthorized" as const };
      });
    },

    completeOperation: async (
      operator: RunnerOperator,
      input: Readonly<{
        expectedVersion: number;
        id: string;
        providerRequestId: string | null;
        result: GitHubToolResult;
        resultNodeId: string | null;
        resultUrl: string | null;
      }>
    ) => {
      assertOperator(operator);
      const result = githubToolResultSchema.parse(input.result);
      if (
        !UUID.test(input.id) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        (input.providerRequestId !== null &&
          !REQUEST_ID.test(input.providerRequestId)) ||
        (input.resultNodeId !== null && !NODE_ID.test(input.resultNodeId)) ||
        (input.resultUrl !== null && !PUBLIC_URL.test(input.resultUrl))
      ) {
        throw new Error("GitHub operation completion is invalid.");
      }
      return database.transaction(async (transaction) => {
        const [currentRow] = await transaction.execute(
          statement(
            "lock-github-operation-for-completion",
            { id: input.id },
            sql`SELECT *
              FROM "RunnerGitHubOperation"
              WHERE "id" = ${input.id}
              FOR UPDATE`
          )
        );
        if (!currentRow) {
          return { kind: "not_found" as const };
        }
        const current = asOperation(currentRow);
        if (
          current.version !== input.expectedVersion ||
          current.status !== "running" ||
          current.kind !== result.kind
        ) {
          return { kind: "stale" as const };
        }
        const [updated] = await transaction.execute(
          statement(
            "complete-github-operation",
            {
              ...input,
              result,
              tenant: current.tenant,
            },
            sql`UPDATE "RunnerGitHubOperation"
              SET "status" = 'completed',
                  "resultJson" = CAST(${JSON.stringify(result)} AS jsonb),
                  "providerRequestId" = ${input.providerRequestId},
                  "resultNodeId" = ${input.resultNodeId},
                  "resultUrl" = ${input.resultUrl},
                  "error" = NULL,
                  "completedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${current.tenant}
                AND "version" = ${input.expectedVersion}
                AND "status" = 'running'
              RETURNING *`
          )
        );
        return updated
          ? {
              kind: "completed" as const,
              operation: asOperation(updated),
            }
          : { kind: "stale" as const };
      });
    },

    failOperation: async (
      operator: RunnerOperator,
      input: Readonly<{
        error: RunError;
        expectedVersion: number;
        id: string;
        providerRequestId: string | null;
      }>
    ) => {
      assertOperator(operator);
      const error = runErrorSchema.parse(input.error);
      if (
        !UUID.test(input.id) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0 ||
        (input.providerRequestId !== null &&
          !REQUEST_ID.test(input.providerRequestId))
      ) {
        throw new Error("GitHub operation failure is invalid.");
      }
      return database.transaction(async (transaction) => {
        const [currentRow] = await transaction.execute(
          statement(
            "lock-github-operation-for-failure",
            { id: input.id },
            sql`SELECT *
              FROM "RunnerGitHubOperation"
              WHERE "id" = ${input.id}
              FOR UPDATE`
          )
        );
        if (!currentRow) {
          return { kind: "not_found" as const };
        }
        const current = asOperation(currentRow);
        if (
          current.version !== input.expectedVersion ||
          current.status !== "running"
        ) {
          return { kind: "stale" as const };
        }
        const [updated] = await transaction.execute(
          statement(
            "fail-github-operation",
            {
              error,
              expectedVersion: input.expectedVersion,
              id: input.id,
              providerRequestId: input.providerRequestId,
              tenant: current.tenant,
            },
            sql`UPDATE "RunnerGitHubOperation"
              SET "status" = 'failed',
                  "resultJson" = NULL,
                  "providerRequestId" = ${input.providerRequestId},
                  "resultNodeId" = NULL,
                  "resultUrl" = NULL,
                  "error" = CAST(${JSON.stringify(error)} AS jsonb),
                  "completedAt" = clock_timestamp(),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "id" = ${input.id}
                AND "tenant" = ${current.tenant}
                AND "version" = ${input.expectedVersion}
                AND "status" = 'running'
              RETURNING *`
          )
        );
        return updated
          ? { kind: "failed" as const, operation: asOperation(updated) }
          : { kind: "stale" as const };
      });
    },
    replaceCapability: async (
      operator: RunnerOperator,
      input: ReplaceGitHubCapabilityInput
    ): Promise<Readonly<{ kind: "conflict" | "created" }>> => {
      assertOperator(operator);
      if (
        !UUID.test(input.id) ||
        !UUID.test(input.attemptId) ||
        !UUID.test(input.runnerRunId) ||
        !UUID.test(input.userId) ||
        !TENANT.test(input.tenant) ||
        !TOKEN_HASH.test(input.tokenHash)
      ) {
        throw new Error("GitHub capability replacement binding is invalid.");
      }
      return database.transaction(async (transaction) => {
        const [run] = await transaction.execute(
          statement(
            "validate-github-capability-run",
            {
              attemptId: input.attemptId,
              expiresAt: input.expiresAt,
              policy: input.policy,
              runnerRunId: input.runnerRunId,
              tenant: input.tenant,
              userId: input.userId,
            },
            sql`SELECT "runnerRun"."id"
              FROM "RunnerRun" AS "runnerRun"
              JOIN "RunnerTeamStep" AS "step"
                ON "step"."id" = "runnerRun"."teamStepId"
                AND "step"."tenant" = "runnerRun"."tenant"
                AND "step"."runnerRunId" = "runnerRun"."id"
              JOIN "RunnerTeamRun" AS "teamRun"
                ON "teamRun"."id" = "step"."teamRunId"
                AND "teamRun"."tenant" = "step"."tenant"
              JOIN "RunnerGitHubConnectionFence" AS "connectionFence"
                ON "connectionFence"."tenant" = "runnerRun"."tenant"
              JOIN "User" AS "actor"
                ON "actor"."id" = "teamRun"."createdByUserId"
              WHERE "runnerRun"."id" = ${input.runnerRunId}
                AND "runnerRun"."tenant" = ${input.tenant}
                AND "runnerRun"."teamStepId" = ${input.policy.teamStepId}
                AND "runnerRun"."githubBrokerPolicy" =
                  CAST(${JSON.stringify(input.policy)} AS jsonb)
                AND "runnerRun"."daytonaAttemptId" = ${input.attemptId}
                AND "runnerRun"."dispatchState" = 'dispatching'
                AND "runnerRun"."status" = 'queued'
                AND "runnerRun"."cancellationRequestedAt" IS NULL
                AND "runnerRun"."authVersion" = ${input.policy.authVersion}
                AND "teamRun"."id" = ${input.policy.teamRunId}
                AND "teamRun"."createdByUserId" = ${input.userId}
                AND "teamRun"."authVersion" = ${input.policy.authVersion}
                AND "teamRun"."status" = 'running'
                AND "step"."status" = 'running'
                AND "step"."approvalStatus" IN ('not_required', 'approved')
                AND "connectionFence"."generation" =
                  ${input.policy.connectionGeneration}
                AND "actor"."authVersion" = ${input.policy.authVersion}
                AND ${input.expiresAt.toISOString()} > clock_timestamp()
                AND ${input.expiresAt.toISOString()} <=
                  clock_timestamp() + interval '15 minutes'
              FOR UPDATE OF "runnerRun", "step", "teamRun"
              FOR SHARE OF "connectionFence", "actor"`
          )
        );
        if (!run) {
          return { kind: "conflict" as const };
        }
        await transaction.execute(
          statement(
            "revoke-prior-github-capabilities",
            { runnerRunId: input.runnerRunId, tenant: input.tenant },
            sql`UPDATE "RunnerGitHubCapability"
              SET "revokedAt" = COALESCE("revokedAt", clock_timestamp()),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "runnerRunId" = ${input.runnerRunId}
                AND "tenant" = ${input.tenant}
                AND "revokedAt" IS NULL
              RETURNING "id"`
          )
        );
        const [inserted] = await transaction.execute(
          statement(
            "insert-github-capability",
            {
              attemptId: input.attemptId,
              expiresAt: input.expiresAt,
              id: input.id,
              policy: input.policy,
              runnerRunId: input.runnerRunId,
              tenant: input.tenant,
              tokenHash: input.tokenHash,
              userId: input.userId,
            },
            sql`INSERT INTO "RunnerGitHubCapability" (
                "id", "tenant", "teamStepId", "teamRunId", "runnerRunId",
                "attemptId", "authVersion", "connectionGeneration",
                "tokenHash", "expiresAt", "declaredCapabilities",
                "approvedCapabilities", "allowedCapabilities",
                "repositoryAllowlist", "maxCallCount"
              ) VALUES (
                ${input.id}, ${input.tenant}, ${input.policy.teamStepId},
                ${input.policy.teamRunId}, ${input.runnerRunId},
                ${input.attemptId}, ${input.policy.authVersion},
                ${input.policy.connectionGeneration}, ${input.tokenHash},
                ${input.expiresAt.toISOString()},
                CAST(${JSON.stringify(input.policy.declaredCapabilities)} AS jsonb),
                CAST(${JSON.stringify(input.policy.approvedCapabilities)} AS jsonb),
                CAST(${JSON.stringify(input.policy.allowedCapabilities)} AS jsonb),
                CAST(${JSON.stringify(input.policy.repositories.map(({ repository }) => repository))} AS jsonb),
                ${input.policy.maxCallCount}
              )
              ON CONFLICT DO NOTHING
              RETURNING *`
          )
        );
        return inserted
          ? { kind: "created" as const }
          : { kind: "conflict" as const };
      });
    },

    reserveOperation: async (
      operator: RunnerOperator,
      input: Readonly<{
        executionLeaseExpiresAt: Date;
        id: string;
        operation: GitHubToolOperation;
        operationId: string;
        operationMarker: string | null;
        requestHash: string;
        target: string;
        tokenHash: string;
      }>
    ): Promise<
      | Readonly<{ kind: "conflict" | "in_progress" | "unauthorized" }>
      | Readonly<{
          context: GitHubOperationExecutionContext;
          kind: "recover" | "reserved";
        }>
      | Readonly<{
          kind: "terminal";
          operation: GitHubGatewayOperationRecord;
        }>
    > => {
      assertOperator(operator);
      const operation = githubToolOperationSchema.parse(input.operation);
      const repository = githubOperationRepository(operation);
      const authority = githubOperationAuthority(operation.kind);
      if (
        !UUID.test(input.id) ||
        !UUID.test(input.operationId) ||
        !TOKEN_HASH.test(input.tokenHash) ||
        !TOKEN_HASH.test(input.requestHash) ||
        !input.target.trim() ||
        input.target.length > 512 ||
        Number.isNaN(input.executionLeaseExpiresAt.valueOf()) ||
        (authority.classification === "write"
          ? !input.operationMarker ||
            !OPERATION_MARKER.test(input.operationMarker)
          : input.operationMarker !== null)
      ) {
        throw new Error("GitHub operation reservation is invalid.");
      }

      return database.transaction(async (transaction) => {
        const [row] = await transaction.execute(
          statement(
            "lock-github-capability-authority",
            {
              repository,
              requiredCapability: authority.capability,
              tokenHash: input.tokenHash,
            },
            sql`SELECT
                "capability".*,
                clock_timestamp() AS "databaseNow",
                "runnerRun"."id" AS "runnerRunId",
                "runnerRun"."status" AS "runnerStatus",
                "runnerRun"."dispatchState" AS "runnerDispatchState",
                "runnerRun"."cancellationRequestedAt" AS "runnerCancellationRequestedAt",
                "runnerRun"."daytonaAttemptId" AS "runnerAttemptId",
                "runnerRun"."githubBrokerPolicy" AS "runnerBrokerPolicy",
                "runnerRun"."githubBrokerPolicy" AS "persistedBrokerPolicy",
                "actor"."authVersion" AS "currentAuthVersion",
                "actor"."id" AS "actorUserId",
                "connectionFence"."generation" AS "currentConnectionGeneration",
                "step"."status" AS "stepStatus",
                "step"."approvalStatus" AS "stepApprovalStatus",
                "step"."approvedCapabilities" AS "stepApprovedCapabilities",
                COALESCE((
                  SELECT jsonb_agg("capabilityName" ORDER BY "capabilityName")
                  FROM (
                    SELECT DISTINCT "declared"."value" AS "capabilityName"
                    FROM jsonb_array_elements("step"."skillSnapshots") AS "skill"("snapshot"),
                      jsonb_array_elements_text("skill"."snapshot"->'requiredCapabilities')
                        AS "declared"("value")
                    WHERE "declared"."value" LIKE 'github.%'
                  ) AS "declaredCapabilities"
                ), '[]'::jsonb) AS "stepDeclaredCapabilities",
                "teamRun"."status" AS "teamRunStatus",
                "connection"."id" AS "connectionId",
                "connection"."accountId",
                "connection"."accountLogin",
                "connection"."accountType",
                "connection"."installationId",
                "connection"."repositoryId",
                "connection"."repositoryName",
                "connection"."repositoryNodeId",
                "connection"."repositoryOwner"
              FROM "RunnerGitHubCapability" AS "capability"
              JOIN "RunnerRun" AS "runnerRun"
                ON "runnerRun"."id" = "capability"."runnerRunId"
                AND "runnerRun"."tenant" = "capability"."tenant"
                AND "runnerRun"."teamStepId" = "capability"."teamStepId"
              JOIN "RunnerTeamStep" AS "step"
                ON "step"."id" = "capability"."teamStepId"
                AND "step"."tenant" = "capability"."tenant"
                AND "step"."runnerRunId" = "runnerRun"."id"
              JOIN "RunnerTeamRun" AS "teamRun"
                ON "teamRun"."id" = "capability"."teamRunId"
                AND "teamRun"."tenant" = "capability"."tenant"
                AND "teamRun"."id" = "step"."teamRunId"
              JOIN "User" AS "actor"
                ON "actor"."id" = "teamRun"."createdByUserId"
              JOIN "RunnerGitHubConnectionFence" AS "connectionFence"
                ON "connectionFence"."tenant" = "capability"."tenant"
              JOIN "RunnerGitHubConnection" AS "connection"
                ON "connection"."tenant" = "capability"."tenant"
                AND lower("connection"."repositoryOwner") || '/' ||
                  lower("connection"."repositoryName") = ${repository}
              WHERE "capability"."tokenHash" = ${input.tokenHash}
              FOR UPDATE OF "capability"
              FOR SHARE OF "runnerRun", "step", "teamRun", "connectionFence", "connection", "actor"`
          )
        );
        if (
          !row ||
          !capabilityAuthorityIsLive(
            row,
            input.tokenHash,
            authority.capability,
            authority.classification,
            repository
          )
        ) {
          return { kind: "unauthorized" as const };
        }
        const capability = asCapability(row);
        const databaseNow = dateColumn(row, "databaseNow");
        if (
          input.executionLeaseExpiresAt <= databaseNow ||
          input.executionLeaseExpiresAt.getTime() - databaseNow.getTime() >
            MAX_GITHUB_OPERATION_LEASE_MS
        ) {
          throw new Error("GitHub operation execution lease is invalid.");
        }
        const [existingRow] = await transaction.execute(
          statement(
            "lock-existing-github-operation",
            {
              operationId: input.operationId,
              tenant: capability.tenant,
            },
            sql`SELECT *
              FROM "RunnerGitHubOperation"
              WHERE "tenant" = ${capability.tenant}
                AND "operationId" = ${input.operationId}
              FOR UPDATE`
          )
        );
        if (existingRow) {
          const existing = asOperation(existingRow);
          if (
            !operationMatches(existing, {
              capabilityId: capability.id,
              kind: operation.kind,
              operationMarker: input.operationMarker,
              repository,
              requestHash: input.requestHash,
              requiredCapability: authority.capability,
              target: input.target,
              teamStepId: capability.teamStepId,
            })
          ) {
            return { kind: "conflict" as const };
          }
          if (existing.status === "completed" || existing.status === "failed") {
            return { kind: "terminal" as const, operation: existing };
          }
          if (existing.executionLeaseExpiresAt > databaseNow) {
            return { kind: "in_progress" as const };
          }
          const [recoveryRow] = await transaction.execute(
            statement(
              "claim-github-operation-recovery",
              {
                executionLeaseExpiresAt: input.executionLeaseExpiresAt,
                expectedVersion: existing.version,
                id: existing.id,
                tenant: existing.tenant,
              },
              sql`UPDATE "RunnerGitHubOperation"
                SET "executionLeaseExpiresAt" =
                      ${input.executionLeaseExpiresAt.toISOString()},
                    "updatedAt" = clock_timestamp(),
                    "version" = "version" + 1
                WHERE "id" = ${existing.id}
                  AND "tenant" = ${existing.tenant}
                  AND "version" = ${existing.version}
                  AND "status" = 'running'
                  AND "executionLeaseExpiresAt" <= clock_timestamp()
                RETURNING *`
            )
          );
          if (!recoveryRow) {
            return { kind: "in_progress" as const };
          }
          return {
            context: contextFromRows(row, asOperation(recoveryRow)),
            kind: "recover" as const,
          };
        }
        if (capability.usedCallCount >= capability.maxCallCount) {
          return { kind: "unauthorized" as const };
        }

        const [insertedRow] = await transaction.execute(
          statement(
            "reserve-github-operation",
            {
              capabilityId: capability.id,
              connectionGeneration: capability.connectionGeneration,
              connectionId: column(row, "connectionId"),
              executionLeaseExpiresAt: input.executionLeaseExpiresAt,
              id: input.id,
              kind: operation.kind,
              operationId: input.operationId,
              operationMarker: input.operationMarker,
              repository,
              requestHash: input.requestHash,
              requiredCapability: authority.capability,
              target: input.target,
              teamStepId: capability.teamStepId,
              tenant: capability.tenant,
            },
            sql`WITH "operation" AS (
                INSERT INTO "RunnerGitHubOperation" (
                  "id", "tenant", "teamStepId", "capabilityId", "operationId",
                  "kind", "requestHash", "target", "repository",
                  "requiredCapability", "connectionId",
                  "connectionGeneration", "operationMarker", "status",
                  "startedAt", "executionLeaseExpiresAt"
                ) VALUES (
                  ${input.id}, ${capability.tenant}, ${capability.teamStepId},
                  ${capability.id}, ${input.operationId}, ${operation.kind},
                  ${input.requestHash}, ${input.target}, ${repository},
                  ${authority.capability}, ${column(row, "connectionId")},
                  ${capability.connectionGeneration}, ${input.operationMarker},
                  'running', clock_timestamp(),
                  ${input.executionLeaseExpiresAt.toISOString()}
                )
                ON CONFLICT DO NOTHING
                RETURNING *
              ),
              "consumed" AS (
                UPDATE "RunnerGitHubCapability"
                SET "usedCallCount" = "usedCallCount" + 1,
                    "updatedAt" = clock_timestamp(),
                    "version" = "version" + 1
                FROM "operation"
                WHERE "RunnerGitHubCapability"."id" =
                    "operation"."capabilityId"
                  AND "RunnerGitHubCapability"."tenant" =
                    "operation"."tenant"
                  AND "RunnerGitHubCapability"."usedCallCount" <
                    "RunnerGitHubCapability"."maxCallCount"
                RETURNING "RunnerGitHubCapability"."id"
              )
              SELECT "operation".*
              FROM "operation"
              JOIN "consumed"
                ON "consumed"."id" = "operation"."capabilityId"`
          )
        );
        if (!insertedRow) {
          return { kind: "conflict" as const };
        }
        return {
          context: contextFromRows(row, asOperation(insertedRow)),
          kind: "reserved" as const,
        };
      });
    },

    revokeCapability: async (
      operator: RunnerOperator,
      input: Readonly<{ attemptId: string; runnerRunId: string }>
    ): Promise<Readonly<{ kind: "not_found" | "revoked" }>> => {
      assertOperator(operator);
      if (!UUID.test(input.attemptId) || !UUID.test(input.runnerRunId)) {
        throw new Error("GitHub capability revocation binding is invalid.");
      }
      return database.transaction(async (transaction) => {
        const [revoked] = await transaction.execute(
          statement(
            "revoke-github-capability",
            input,
            sql`UPDATE "RunnerGitHubCapability"
              SET "revokedAt" = COALESCE("revokedAt", clock_timestamp()),
                  "updatedAt" = clock_timestamp(),
                  "version" = "version" + 1
              WHERE "runnerRunId" = ${input.runnerRunId}
                AND "attemptId" = ${input.attemptId}
                AND "revokedAt" IS NULL
              RETURNING "id"`
          )
        );
        return revoked
          ? { kind: "revoked" as const }
          : { kind: "not_found" as const };
      });
    },
  };
}
