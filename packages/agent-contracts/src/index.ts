import { z } from "zod";
import { contractDescriptor } from "../contract-descriptor";
import { runSandboxBindingSchema } from "./sandbox-binding";

export { contractDescriptor } from "../contract-descriptor";
export type { EvidenceRedactionInput } from "./evidence";
export {
  ExactEvidenceRedactions,
  exactEvidenceRedactions,
  MAX_EXACT_EVIDENCE_REDACTION_LENGTH,
  MAX_EXACT_EVIDENCE_REDACTION_VALUES,
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "./evidence";
export {
  base64UrlDecode,
  base64UrlEncode,
  TENANT_ID_PATTERN,
} from "./identity";
export type {
  RunSandboxBinding,
  RunSandboxBindingRefusal,
  RunSandboxBindingRefusalReason,
} from "./sandbox-binding";
export {
  RUN_SANDBOX_BINDING_CONTRACT_VERSION,
  RUN_SANDBOX_BINDING_REFUSAL_CODE,
  RUN_SANDBOX_BINDING_REFUSAL_REASONS,
  runSandboxBindingRefusalReasonSchema,
  runSandboxBindingRefusalSchema,
  runSandboxBindingSchema,
} from "./sandbox-binding";
export type {
  SandboxInspectionObserved,
  SandboxInspectionPolicy,
  SandboxInspectionRecord,
  SandboxInspectionRequest,
  SandboxInspectionResult,
} from "./sandbox-inspection";
export {
  SANDBOX_INSPECTION_CONTRACT_VERSION,
  sandboxInspectionFenceSchema,
  sandboxInspectionLifecycleSchema,
  sandboxInspectionRequestSchema,
  sandboxInspectionResultSchema,
  sandboxInspectionStateSchema,
} from "./sandbox-inspection";

if (contractDescriptor.apiVersions.length !== 1) {
  throw new Error("Agent Runner must publish exactly one API version.");
}
const [apiVersion] = contractDescriptor.apiVersions;
export const AGENT_RUNNER_API_VERSION = apiVersion;

export const AGENT_RUNNER_CAPABILITIES = contractDescriptor.capabilities;
export const AGENT_RUNNER_EVENT_TYPES = contractDescriptor.eventTypes;
export const AGENT_RUNNER_LIMITS = contractDescriptor.limits;
export const AGENT_RUNNER_ROUTES = contractDescriptor.routes;
export const AGENT_RUNNER_STATUSES = contractDescriptor.statuses;

export const compareAgentTimestamps = (left: string, right: string) =>
  Date.parse(left) - Date.parse(right);

export const agentRunnerApiVersionSchema = z.literal(AGENT_RUNNER_API_VERSION);
const boundedString = (max: number) => z.string().trim().min(1).max(max);
const datetimeSchema = z.string().datetime();
export const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const canonicalUuidSchema = z
  .string()
  .regex(CANONICAL_UUID_PATTERN, "UUID must use canonical lowercase form.");
export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_PATTERN.test(value);
}

const familiarIdValueSchema = z.enum([
  "auto",
  "builder",
  "critic",
  "custom",
  "scout",
  "scribe",
  "tester",
]);
export const familiarIdSchema = familiarIdValueSchema.default("auto");

export const TEAM_LIMITS = Object.freeze({
  maxDescriptionLength: AGENT_RUNNER_LIMITS.maxDescriptionLength,
  maxHandoffLength: 16_384,
  maxMembers: 8,
  maxMissionLength: AGENT_RUNNER_LIMITS.maxTaskLength,
  maxNameLength: 64,
  maxSkillInstructionsLength: 4000,
  maxSkillsPerMember: 8,
  maxTeamRunsPerPage: 10,
  maxTotalHandoffLength: 49_152,
});

export const GITHUB_TOOL_LIMITS = Object.freeze({
  bodyBytes: 60_000,
  branchBytes: 200,
  commitFileBytes: 60_000,
  commitMessageBytes: 512,
  commitPathBytes: 512,
  maxAssignees: 10,
  maxCommitFiles: 32,
  maxLabels: 10,
  maxSearchResults: 30,
  queryBytes: 256,
  resultBodyBytes: 8192,
  resultTitleBytes: 512,
  textFieldBytes: 8192,
  titleBytes: 256,
});
export const GITHUB_TOOL_SERVER_DEADLINE_MS = 60_000;

export const DEMO_TRANSCRIPT_LIMITS = Object.freeze({
  maxEvents: 256,
  maxRawBytes: 256 * 1024,
  maxReplayDurationMs: 2 * 60 * 1000,
});

/**
 * Stable Agent Runner v1 deployment-class discriminator. `cloud` means the
 * runner is remotely deployed; it is not an execution-provider identity or
 * provider-selection control.
 */
export const backendSchema = z.literal("cloud");
export const runtimeSchema = z.enum(["codex", "claude", "copilot"]);
export const agentStatusSchema = z.enum(["idle", "running", "error"]);
export const agentIdSchema = canonicalUuidSchema;

export const agentRunnerCapabilitySchema = z.enum(AGENT_RUNNER_CAPABILITIES);
export const agentRunnerCapabilitiesSchema = z
  .array(agentRunnerCapabilitySchema)
  .length(AGENT_RUNNER_CAPABILITIES.length)
  .superRefine((capabilities, context) => {
    const expected = new Set(AGENT_RUNNER_CAPABILITIES);
    const actual = new Set(capabilities);
    if (
      actual.size !== expected.size ||
      [...expected].some((capability) => !actual.has(capability))
    ) {
      context.addIssue({
        code: "custom",
        message: "Capabilities must match Agent Runner v1.",
      });
    }
  });
export const agentRunnerLimitsSchema = z
  .object({
    maxCommandLength: z.number().int().positive(),
    maxCommandResults: z.number().int().positive(),
    maxDescriptionLength: z.number().int().positive(),
    maxDetailsLength: z.number().int().positive(),
    maxEventOutputLength: z.number().int().positive(),
    maxFileOperations: z.number().int().positive(),
    maxInstructionsLength: z.number().int().positive(),
    maxMessageLength: z.number().int().positive(),
    maxModelLength: z.number().int().positive(),
    maxOwnerIdLength: z.number().int().positive(),
    maxPathLength: z.number().int().positive(),
    maxRequestIdLength: z.number().int().positive(),
    maxSourceRevisionLength: z.number().int().positive(),
    maxTaskLength: z.number().int().positive(),
    maxWorkspaceLength: z.number().int().positive(),
  })
  .strict();
export const agentRunnerRouteSchema = z
  .object({
    method: z.enum(["DELETE", "GET", "POST", "PUT"]),
    path: z.string().trim().min(1),
  })
  .strict();
export const agentRunnerRoutesSchema = z
  .array(agentRunnerRouteSchema)
  .length(10);
export type AgentRunnerCapability = z.infer<typeof agentRunnerCapabilitySchema>;

const standaloneAgentOwnerSchema = z
  .object({
    kind: z.literal("standalone"),
  })
  .strict();

const caveFamiliarAgentOwnerSchema = z
  .object({
    caveInstanceId: boundedString(AGENT_RUNNER_LIMITS.maxOwnerIdLength),
    familiarId: boundedString(AGENT_RUNNER_LIMITS.maxOwnerIdLength),
    kind: z.literal("cave-familiar"),
    sourceRevision: boundedString(AGENT_RUNNER_LIMITS.maxSourceRevisionLength),
  })
  .strict();

/**
 * An agent created through the API belongs to the caller's tenant. This is a
 * distinct kind rather than a reuse of `cave-familiar` because the two are not
 * the same claim: a cave familiar is identified by the cave instance that runs
 * it, while a tenant is the account that called the API.
 *
 * Without this member the union could not express ownership at all for
 * API-created agents. They would fall back to `standalone`, which carries no
 * identifier, and every one of them would resolve to the same tenant — turning
 * the runner ownership check into a no-op across accounts.
 */
const tenantAgentOwnerSchema = z
  .object({
    kind: z.literal("tenant"),
    tenantId: boundedString(AGENT_RUNNER_LIMITS.maxOwnerIdLength),
  })
  .strict();

export const agentOwnerSchema = z.discriminatedUnion("kind", [
  standaloneAgentOwnerSchema,
  caveFamiliarAgentOwnerSchema,
  tenantAgentOwnerSchema,
]);
export const ownerSchema = agentOwnerSchema;

export const teamCapabilitySchema = z.enum([
  "workspace.read",
  "workspace.write",
  "github.contents.write",
  "github.issues.read",
  "github.issues.write",
  "github.pull_requests.read",
  "github.pull_requests.write",
  "github.projects.read",
  "github.projects.write",
]);
export const teamRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "completed_with_warnings",
  "failed",
  "cancelled",
]);
export const teamStepStatusSchema = z.enum([
  "pending",
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "skipped",
]);
export const skillIdSchema = canonicalUuidSchema;
export const teamIdSchema = canonicalUuidSchema;
export const teamRunIdSchema = canonicalUuidSchema;
export const teamStepIdSchema = canonicalUuidSchema;

const distinctValues = <T>(
  values: readonly T[],
  context: z.core.$RefinementCtx,
  message: string
) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message });
  }
};

export const createSkillInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .max(TEAM_LIMITS.maxDescriptionLength)
      .default(""),
    instructions: boundedString(TEAM_LIMITS.maxSkillInstructionsLength),
    name: boundedString(TEAM_LIMITS.maxNameLength),
    requiredCapabilities: z
      .array(teamCapabilitySchema)
      .max(TEAM_LIMITS.maxSkillsPerMember)
      .default([])
      .superRefine((capabilities, context) =>
        distinctValues(capabilities, context, "Capabilities must be unique.")
      ),
  })
  .strict();

export const updateSkillInputSchema = createSkillInputSchema
  .extend({
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export const skillDefinitionSchema = createSkillInputSchema.extend({
  createdAt: datetimeSchema,
  id: skillIdSchema,
  owner: agentOwnerSchema,
  updatedAt: datetimeSchema,
  version: z.number().int().nonnegative(),
});

export const skillResourceSchema = createSkillInputSchema
  .extend({
    createdAt: datetimeSchema,
    id: skillIdSchema,
    updatedAt: datetimeSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const createTeamMemberInputSchema = z
  .object({
    agentId: agentIdSchema,
    required: z.boolean().default(true),
    responsibility: boundedString(AGENT_RUNNER_LIMITS.maxInstructionsLength),
    skillIds: z
      .array(skillIdSchema)
      .max(TEAM_LIMITS.maxSkillsPerMember)
      .default([])
      .superRefine((skillIds, context) =>
        distinctValues(skillIds, context, "Skill ids must be unique.")
      ),
  })
  .strict();

export const createTeamInputSchema = z
  .object({
    description: z
      .string()
      .trim()
      .max(TEAM_LIMITS.maxDescriptionLength)
      .default(""),
    members: z
      .array(createTeamMemberInputSchema)
      .min(2)
      .max(TEAM_LIMITS.maxMembers)
      .superRefine((members, context) =>
        distinctValues(
          members.map(({ agentId }) => agentId),
          context,
          "Team agent ids must be unique."
        )
      ),
    name: boundedString(TEAM_LIMITS.maxNameLength),
  })
  .strict();

export const updateTeamInputSchema = createTeamInputSchema
  .extend({
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export const teamMemberSchema = createTeamMemberInputSchema.extend({
  id: canonicalUuidSchema,
  position: z.number().int().nonnegative(),
});

export const teamDefinitionSchema = z
  .object({
    createdAt: datetimeSchema,
    description: z.string().max(TEAM_LIMITS.maxDescriptionLength).default(""),
    id: teamIdSchema,
    members: z.array(teamMemberSchema).min(2).max(TEAM_LIMITS.maxMembers),
    name: boundedString(TEAM_LIMITS.maxNameLength),
    owner: agentOwnerSchema,
    updatedAt: datetimeSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const teamResourceSchema = z
  .object({
    createdAt: datetimeSchema,
    description: z.string().max(TEAM_LIMITS.maxDescriptionLength).default(""),
    id: teamIdSchema,
    members: z.array(teamMemberSchema).min(2).max(TEAM_LIMITS.maxMembers),
    name: boundedString(TEAM_LIMITS.maxNameLength),
    updatedAt: datetimeSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const expectedVersionInputSchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

function workspaceStaysInsideSandbox(value: string): boolean {
  if (!value) {
    return true;
  }
  const base = value.startsWith("/") ? value : `/workspace/${value}`;
  const parts: string[] = [];
  for (const segment of base.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  const resolved = `/${parts.join("/")}`;
  return resolved === "/workspace" || resolved.startsWith("/workspace/");
}

const agentDefinitionInputShape = {
  backend: backendSchema,
  description: z
    .string()
    .trim()
    .max(AGENT_RUNNER_LIMITS.maxDescriptionLength)
    .default(""),
  familiarId: familiarIdSchema,
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(AGENT_RUNNER_LIMITS.maxInstructionsLength),
  model: z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.maxModelLength),
  name: z.string().trim().min(1).max(64),
  runtime: runtimeSchema,
  workspace: z
    .string()
    .trim()
    .max(AGENT_RUNNER_LIMITS.maxWorkspaceLength)
    .refine(
      workspaceStaysInsideSandbox,
      "Workspace must stay inside /workspace."
    )
    .optional(),
};

/**
 * `owner` is omitted deliberately. Ownership is a claim the server makes about
 * the caller, never one the caller makes about itself, and `.strict()` means a
 * submitted `owner` is rejected outright rather than silently dropped.
 *
 * The server stamps its own owner after parsing. That ordering is not something
 * to rely on: accepting caller ownership would hand the agent to whoever asked
 * for it, with nothing failing.
 */
export const createAgentInputSchema = z
  .object(agentDefinitionInputShape)
  .strict();
export const updateAgentInputSchema = z
  .object({
    ...agentDefinitionInputShape,
    familiarId: familiarIdValueSchema.optional(),
  })
  .strict();

/**
 * The sandbox's readiness for this agent's next run.
 *
 * `provisioning` means a warm-up is booting the container; `ready` means the
 * probe answered and the next run skips the cold start; `failed` is advisory
 * — a run started against a failed warm simply pays the cold start it would
 * have paid anyway.
 */
export const warmStateSchema = z
  .object({
    status: z.enum(["not_started", "provisioning", "ready", "failed"]),
    updatedAt: datetimeSchema,
  })
  .strict();
export type WarmState = z.infer<typeof warmStateSchema>;

const agentDefinitionBaseShape = {
  ...agentDefinitionInputShape,
  createdAt: datetimeSchema,
  id: agentIdSchema,
  lastRunAt: datetimeSchema.nullable(),
  owner: agentOwnerSchema,
  status: agentStatusSchema,
  updatedAt: datetimeSchema,
  warm: warmStateSchema,
};

export const agentDefinitionSchema = z
  .object({
    ...agentDefinitionBaseShape,
  })
  .strict();

export const currentAgentDefinitionSchema = agentDefinitionSchema;

/**
 * Durable definitions predate both ownership and warm tracking. The storage
 * parser alone supplies those missing fields.
 */
export const storedAgentDefinitionSchema = z
  .object({
    ...agentDefinitionBaseShape,
    owner: agentOwnerSchema.optional().default({ kind: "standalone" as const }),
    warm: warmStateSchema.optional(),
  })
  .strict()
  .transform((definition) => ({
    ...definition,
    warm: definition.warm ?? {
      status: "not_started" as const,
      updatedAt: definition.updatedAt,
    },
  }));

export const runAgentInputSchema = z.object({
  task: z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.maxTaskLength),
});

export const startRunInputSchema = z
  .object({
    operationId: canonicalUuidSchema,
    /**
     * Optional expectation, never a selector: the run is refused unless the
     * agent's already-recorded sandbox matches. See `./sandbox-binding`.
     */
    sandboxBinding: runSandboxBindingSchema.optional(),
    task: z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.maxTaskLength),
  })
  .strict();
export const runStartInputSchema = startRunInputSchema;

export const runStatusSchema = z.enum(AGENT_RUNNER_STATUSES);
export const agentRunnerStatusesSchema = z.array(runStatusSchema);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const commandEvidenceSchema = z
  .object({
    command: boundedString(AGENT_RUNNER_LIMITS.maxCommandLength),
    completedAt: datetimeSchema.optional(),
    exitCode: z.number().int().nullable(),
    startedAt: datetimeSchema.optional(),
    stderr: z.string().max(AGENT_RUNNER_LIMITS.maxEventOutputLength),
    stdout: z.string().max(AGENT_RUNNER_LIMITS.maxEventOutputLength),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startedAt &&
      value.completedAt &&
      compareAgentTimestamps(value.completedAt, value.startedAt) < 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Command completion cannot precede command start.",
        path: ["completedAt"],
      });
    }
  });

export const fileEvidenceSchema = z
  .object({
    byteLength: z.number().int().nonnegative().optional(),
    occurredAt: datetimeSchema.optional(),
    operation: z.enum(["create", "modify", "delete"]),
    path: boundedString(AGENT_RUNNER_LIMITS.maxPathLength),
  })
  .strict();

export const runErrorSchema = z
  .object({
    code: boundedString(64),
    details: boundedString(AGENT_RUNNER_LIMITS.maxDetailsLength).optional(),
    message: boundedString(AGENT_RUNNER_LIMITS.maxMessageLength),
    retryable: z.boolean(),
  })
  .strict();

export const runSnapshotSchema = z
  .object({
    agentId: agentIdSchema,
    apiVersion: agentRunnerApiVersionSchema,
    attemptRef: z.uuid().optional(),
    commandEvidence: z
      .array(commandEvidenceSchema)
      .max(AGENT_RUNNER_LIMITS.maxCommandResults),
    completedAt: datetimeSchema.nullable().default(null),
    createdAt: datetimeSchema,
    error: runErrorSchema.nullable().optional(),
    executedSandbox: z
      .object({
        bindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
        generation: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    fileEvidence: z
      .array(fileEvidenceSchema)
      .max(AGENT_RUNNER_LIMITS.maxFileOperations),
    id: canonicalUuidSchema,
    operationId: canonicalUuidSchema,
    output: z.string().max(AGENT_RUNNER_LIMITS.maxEventOutputLength),
    startedAt: datetimeSchema.nullable().default(null),
    status: runStatusSchema,
    task: z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.maxTaskLength),
  })
  .strict();

export const teamApprovalStatusSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "rejected",
]);
export const githubOperationKindSchema = z.enum([
  "issue.get",
  "issue.search",
  "issue.create",
  "issue.comment",
  "pull.get",
  "pull.create",
  "pull.comment",
  "pull.review",
  "repository.commit",
  "project.item.add",
  "project.item.field.update",
]);
export const githubOperationStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);

const githubRepositoryPartSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/u);
const githubDecimalSchema = z.string().regex(/^[1-9][0-9]{0,19}$/u);
export const GITHUB_NODE_ID_MIN_LENGTH = 1;
export const GITHUB_NODE_ID_MAX_LENGTH = 256;
export const GITHUB_NODE_ID_CHARACTERS = "[A-Za-z0-9_=-]";
export const GITHUB_NODE_ID_PATTERN = new RegExp(
  `^${GITHUB_NODE_ID_CHARACTERS}{${GITHUB_NODE_ID_MIN_LENGTH},${GITHUB_NODE_ID_MAX_LENGTH}}$`,
  "u"
);
const githubNodeIdSchema = z
  .string()
  .min(GITHUB_NODE_ID_MIN_LENGTH)
  .max(GITHUB_NODE_ID_MAX_LENGTH)
  .regex(GITHUB_NODE_ID_PATTERN);
const githubTextSchema = (maxBytes: number, maxLength = maxBytes) =>
  z
    .string()
    .min(1)
    .max(maxLength)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `Text must not exceed ${maxBytes} UTF-8 bytes.`
    );
const githubOptionalTextSchema = (maxBytes: number, maxLength = maxBytes) =>
  z
    .string()
    .max(maxLength)
    .refine(
      (value) => new TextEncoder().encode(value).byteLength <= maxBytes,
      `Text must not exceed ${maxBytes} UTF-8 bytes.`
    );
const githubBranchSchema = githubTextSchema(
  GITHUB_TOOL_LIMITS.branchBytes
).refine(
  (value) =>
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock") &&
    !value.startsWith("refs/"),
  "Branch must be a canonical repository-relative ref."
);
const githubLabelSchema = githubTextSchema(100, 100);
const githubLoginSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u);
const githubRepositoryOperationShape = {
  owner: githubRepositoryPartSchema,
  repo: githubRepositoryPartSchema,
};
const githubCommitPathSchema = githubTextSchema(
  GITHUB_TOOL_LIMITS.commitPathBytes
).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.includes("\\") &&
    !value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === ".."),
  "Commit path must be a canonical repository-relative file path."
);
const githubCommitFileSchema = z.discriminatedUnion("operation", [
  z
    .object({
      content: githubOptionalTextSchema(GITHUB_TOOL_LIMITS.commitFileBytes),
      operation: z.literal("upsert"),
      path: githubCommitPathSchema,
    })
    .strict(),
  z
    .object({
      operation: z.literal("delete"),
      path: githubCommitPathSchema,
    })
    .strict(),
]);
const repositoryCommitOperationSchema = z
  .object({
    base: githubBranchSchema,
    branch: githubBranchSchema,
    files: z
      .array(githubCommitFileSchema)
      .min(1)
      .max(GITHUB_TOOL_LIMITS.maxCommitFiles)
      .superRefine((files, context) =>
        distinctValues(
          files.map(({ path }) => path),
          context,
          "Commit file paths must be unique."
        )
      ),
    kind: z.literal("repository.commit"),
    message: githubTextSchema(GITHUB_TOOL_LIMITS.commitMessageBytes),
    ...githubRepositoryOperationShape,
  })
  .strict()
  .refine((value) => value.base !== value.branch, {
    message: "Commit branch must differ from its base branch.",
    path: ["branch"],
  });
const issueGetOperationSchema = z
  .object({
    issueNumber: githubDecimalSchema,
    kind: z.literal("issue.get"),
    ...githubRepositoryOperationShape,
  })
  .strict();
const issueSearchOperationSchema = z
  .object({
    kind: z.literal("issue.search"),
    limit: z.number().int().min(1).max(GITHUB_TOOL_LIMITS.maxSearchResults),
    ...githubRepositoryOperationShape,
    query: githubTextSchema(GITHUB_TOOL_LIMITS.queryBytes),
    state: z.enum(["all", "closed", "open"]),
  })
  .strict();
const issueCreateOperationSchema = z
  .object({
    assignees: z
      .array(githubLoginSchema)
      .max(GITHUB_TOOL_LIMITS.maxAssignees)
      .superRefine((values, context) =>
        distinctValues(values, context, "Assignees must be unique.")
      ),
    body: githubOptionalTextSchema(GITHUB_TOOL_LIMITS.bodyBytes),
    kind: z.literal("issue.create"),
    labels: z
      .array(githubLabelSchema)
      .max(GITHUB_TOOL_LIMITS.maxLabels)
      .superRefine((values, context) =>
        distinctValues(values, context, "Labels must be unique.")
      ),
    ...githubRepositoryOperationShape,
    title: githubTextSchema(GITHUB_TOOL_LIMITS.titleBytes),
  })
  .strict();
const issueCommentOperationSchema = z
  .object({
    body: githubTextSchema(GITHUB_TOOL_LIMITS.bodyBytes),
    issueNumber: githubDecimalSchema,
    kind: z.literal("issue.comment"),
    ...githubRepositoryOperationShape,
  })
  .strict();
const pullGetOperationSchema = z
  .object({
    kind: z.literal("pull.get"),
    ...githubRepositoryOperationShape,
    pullNumber: githubDecimalSchema,
  })
  .strict();
const pullCreateOperationSchema = z
  .object({
    base: githubBranchSchema,
    body: githubOptionalTextSchema(GITHUB_TOOL_LIMITS.bodyBytes),
    draft: z.boolean(),
    head: githubBranchSchema,
    kind: z.literal("pull.create"),
    ...githubRepositoryOperationShape,
    title: githubTextSchema(GITHUB_TOOL_LIMITS.titleBytes),
  })
  .strict()
  .refine((value) => value.base !== value.head, {
    message: "Pull request base and head must differ.",
    path: ["head"],
  });
const pullCommentOperationSchema = z
  .object({
    body: githubTextSchema(GITHUB_TOOL_LIMITS.bodyBytes),
    kind: z.literal("pull.comment"),
    ...githubRepositoryOperationShape,
    pullNumber: githubDecimalSchema,
  })
  .strict();
const pullReviewOperationSchema = z
  .object({
    body: githubOptionalTextSchema(GITHUB_TOOL_LIMITS.bodyBytes),
    event: z.enum(["approve", "comment", "request_changes"]),
    kind: z.literal("pull.review"),
    ...githubRepositoryOperationShape,
    pullNumber: githubDecimalSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.event !== "request_changes" || value.body.trim().length > 0,
    {
      message: "Requested changes require a review body.",
      path: ["body"],
    }
  );
const projectItemAddOperationSchema = z
  .object({
    contentId: githubNodeIdSchema,
    contentType: z.enum(["issue", "pull"]),
    kind: z.literal("project.item.add"),
    ...githubRepositoryOperationShape,
    projectId: githubNodeIdSchema,
  })
  .strict();
const githubProjectFieldValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clear") }).strict(),
  z
    .object({
      date: z
        .string()
        .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u)
        .refine(
          (value) =>
            new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) ===
            value,
          "Date must be a real calendar date."
        ),
      kind: z.literal("date"),
    })
    .strict(),
  z
    .object({
      iterationId: githubNodeIdSchema,
      kind: z.literal("iteration"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("number"),
      number: z
        .number()
        .finite()
        .min(-1_000_000_000_000)
        .max(1_000_000_000_000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("single_select"),
      optionId: githubNodeIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("text"),
      text: githubOptionalTextSchema(GITHUB_TOOL_LIMITS.textFieldBytes),
    })
    .strict(),
]);
const projectItemFieldUpdateOperationSchema = z
  .object({
    contentId: githubNodeIdSchema,
    contentType: z.enum(["issue", "pull"]),
    fieldId: githubNodeIdSchema,
    itemId: githubNodeIdSchema,
    kind: z.literal("project.item.field.update"),
    ...githubRepositoryOperationShape,
    projectId: githubNodeIdSchema,
    value: githubProjectFieldValueSchema,
  })
  .strict();

export const githubToolOperationSchema = z.discriminatedUnion("kind", [
  issueGetOperationSchema,
  issueSearchOperationSchema,
  issueCreateOperationSchema,
  issueCommentOperationSchema,
  pullGetOperationSchema,
  pullCreateOperationSchema,
  pullCommentOperationSchema,
  pullReviewOperationSchema,
  repositoryCommitOperationSchema,
  projectItemAddOperationSchema,
  projectItemFieldUpdateOperationSchema,
]);

export const githubToolRequestSchema = z
  .object({
    operation: githubToolOperationSchema,
    operationId: canonicalUuidSchema,
  })
  .strict();

const githubResultRepositorySchema = z
  .string()
  .min(3)
  .max(201)
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const githubResultUrlSchema = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" &&
        parsed.hostname === "github.com" &&
        !parsed.username &&
        !parsed.password
      );
    } catch {
      return false;
    }
  }, "Result URL must be a public github.com URL.");
const githubResultBodySchema = githubOptionalTextSchema(
  GITHUB_TOOL_LIMITS.resultBodyBytes
);
const githubIssueSummarySchema = z
  .object({
    nodeId: githubNodeIdSchema,
    number: githubDecimalSchema,
    state: z.enum(["closed", "open"]),
    title: githubTextSchema(GITHUB_TOOL_LIMITS.resultTitleBytes),
    url: githubResultUrlSchema,
  })
  .strict();
const githubIssueResultSchema = githubIssueSummarySchema.extend({
  body: githubResultBodySchema,
});
const githubPullResultSchema = githubIssueResultSchema.extend({
  base: githubBranchSchema,
  draft: z.boolean(),
  head: githubBranchSchema,
  merged: z.boolean(),
});
const githubCommentResultSchema = z
  .object({
    nodeId: githubNodeIdSchema,
    url: githubResultUrlSchema,
  })
  .strict();
const githubReviewResultSchema = githubCommentResultSchema.extend({
  state: z.enum(["approved", "commented", "changes_requested"]),
});
const githubCommitShaSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const githubCommitResultSchema = z
  .object({
    sha: githubCommitShaSchema,
    url: githubResultUrlSchema,
  })
  .strict();

export const githubToolResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      issue: githubIssueResultSchema,
      kind: z.literal("issue.get"),
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      items: z
        .array(githubIssueSummarySchema)
        .max(GITHUB_TOOL_LIMITS.maxSearchResults),
      kind: z.literal("issue.search"),
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      issue: githubIssueResultSchema,
      kind: z.literal("issue.create"),
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      comment: githubCommentResultSchema,
      kind: z.literal("issue.comment"),
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull.get"),
      pull: githubPullResultSchema,
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull.create"),
      pull: githubPullResultSchema,
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      comment: githubCommentResultSchema,
      kind: z.literal("pull.comment"),
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pull.review"),
      repository: githubResultRepositorySchema,
      review: githubReviewResultSchema,
    })
    .strict(),
  z
    .object({
      branch: githubBranchSchema,
      commit: githubCommitResultSchema,
      kind: z.literal("repository.commit"),
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      itemId: githubNodeIdSchema,
      kind: z.literal("project.item.add"),
      projectId: githubNodeIdSchema,
      repository: githubResultRepositorySchema,
    })
    .strict(),
  z
    .object({
      fieldId: githubNodeIdSchema,
      itemId: githubNodeIdSchema,
      kind: z.literal("project.item.field.update"),
      projectId: githubNodeIdSchema,
      repository: githubResultRepositorySchema,
    })
    .strict(),
]);

export const draftTeamMissionInputSchema = z
  .object({
    /** Optional steer from the person. Empty means "read the team and decide". */
    hint: z.string().max(TEAM_LIMITS.maxMissionLength).default(""),
  })
  .strict();

export const teamMissionEnvelopeSchema = z
  .object({ mission: boundedString(TEAM_LIMITS.maxMissionLength) })
  .strict();

export const createTeamRunInputSchema = z
  .object({
    operationId: canonicalUuidSchema,
    task: boundedString(TEAM_LIMITS.maxMissionLength),
  })
  .strict();

const approveTeamRunDecisionInputSchema = z
  .object({
    capabilities: z
      .array(
        teamCapabilitySchema.refine(
          (capability) => capability.startsWith("github."),
          "Only declared GitHub capabilities may be approved."
        )
      )
      .min(1)
      .max(TEAM_LIMITS.maxSkillsPerMember)
      .superRefine((capabilities, context) => {
        distinctValues(capabilities, context, "Capabilities must be unique.");
        if (!capabilities.some((capability) => capability.endsWith(".write"))) {
          context.addIssue({
            code: "custom",
            message:
              "Approval must include a declared GitHub write capability.",
          });
        }
      }),
    decision: z.literal("approve"),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

const rejectTeamRunDecisionInputSchema = z
  .object({
    capabilities: z.array(teamCapabilitySchema).length(0).default([]),
    decision: z.literal("reject"),
    expectedVersion: z.number().int().nonnegative(),
  })
  .strict();

export const approveTeamRunInputSchema = z.discriminatedUnion("decision", [
  approveTeamRunDecisionInputSchema,
  rejectTeamRunDecisionInputSchema,
]);

export const teamHandoffSchema = z
  .object({
    commandEvidence: z
      .array(commandEvidenceSchema)
      .max(AGENT_RUNNER_LIMITS.maxCommandResults),
    fileEvidence: z
      .array(fileEvidenceSchema)
      .max(AGENT_RUNNER_LIMITS.maxFileOperations),
    output: z.string().max(TEAM_LIMITS.maxHandoffLength),
  })
  .strict();

export const githubOperationReceiptSchema = z
  .object({
    completedAt: datetimeSchema.nullable(),
    id: canonicalUuidSchema,
    kind: githubOperationKindSchema,
    providerRequestId: z.string().trim().max(256).nullable(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    resultNodeId: z.string().trim().max(GITHUB_NODE_ID_MAX_LENGTH).nullable(),
    resultUrl: z.url().max(2048).nullable(),
    status: githubOperationStatusSchema,
    stepId: teamStepIdSchema,
    target: boundedString(512),
  })
  .strict();

export const teamStepSchema = z
  .object({
    agentId: agentIdSchema,
    approvalCapabilities: z
      .array(
        teamCapabilitySchema.refine(
          (capability) =>
            capability.startsWith("github.") && capability.endsWith(".write"),
          "Only declared GitHub write capabilities may be approved."
        )
      )
      .max(TEAM_LIMITS.maxSkillsPerMember)
      .superRefine((capabilities, context) =>
        distinctValues(capabilities, context, "Capabilities must be unique.")
      )
      .default([]),
    approvalStatus: teamApprovalStatusSchema,
    completedAt: datetimeSchema.nullable(),
    createdAt: datetimeSchema,
    error: runErrorSchema.nullable(),
    handoff: teamHandoffSchema.nullable(),
    id: teamStepIdSchema,
    position: z.number().int().nonnegative(),
    required: z.boolean(),
    responsibility: boundedString(AGENT_RUNNER_LIMITS.maxInstructionsLength),
    runnerRunId: canonicalUuidSchema.nullable(),
    skillIds: z
      .array(skillIdSchema)
      .max(TEAM_LIMITS.maxSkillsPerMember)
      .superRefine((skillIds, context) =>
        distinctValues(skillIds, context, "Skill ids must be unique.")
      ),
    startedAt: datetimeSchema.nullable(),
    status: teamStepStatusSchema,
    updatedAt: datetimeSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const teamRunSchema = z
  .object({
    completedAt: datetimeSchema.nullable(),
    createdAt: datetimeSchema,
    currentPosition: z.number().int().nonnegative(),
    error: runErrorSchema.nullable(),
    id: teamRunIdSchema,
    mission: boundedString(TEAM_LIMITS.maxMissionLength),
    operationId: canonicalUuidSchema,
    startedAt: datetimeSchema.nullable(),
    status: teamRunStatusSchema,
    steps: z
      .array(teamStepSchema)
      .min(1)
      .max(TEAM_LIMITS.maxMembers)
      .superRefine((steps, context) => {
        distinctValues(
          steps.map(({ id }) => id),
          context,
          "Team step ids must be unique."
        );
        distinctValues(
          steps.map(({ position }) => position),
          context,
          "Team step positions must be unique."
        );
        if (steps.some(({ position }, index) => position !== index)) {
          context.addIssue({
            code: "custom",
            message: "Team step positions must be contiguous and ordered.",
          });
        }
      }),
    teamId: teamIdSchema,
    updatedAt: datetimeSchema,
    version: z.number().int().nonnegative(),
  })
  .strict();

export const runEventIdSchema = z.number().int().nonnegative();
export const runEventTypeSchema = z.enum(AGENT_RUNNER_EVENT_TYPES);
export const agentRunnerEventTypesSchema = z
  .array(runEventTypeSchema)
  .length(AGENT_RUNNER_EVENT_TYPES.length);

const runEventBaseSchema = {
  at: datetimeSchema.optional(),
  id: runEventIdSchema,
};

export const runEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...runEventBaseSchema,
      operationId: canonicalUuidSchema,
      runId: canonicalUuidSchema,
      type: z.literal("accepted"),
    })
    .strict(),
  z
    .object({
      ...runEventBaseSchema,
      status: runStatusSchema,
      type: z.literal("status"),
    })
    .strict(),
  z
    .object({
      ...runEventBaseSchema,
      output: z.string().max(AGENT_RUNNER_LIMITS.maxEventOutputLength),
      type: z.literal("output"),
    })
    .strict(),
  z
    .object({
      ...runEventBaseSchema,
      evidence: commandEvidenceSchema,
      type: z.literal("command"),
    })
    .strict(),
  z
    .object({
      ...runEventBaseSchema,
      evidence: fileEvidenceSchema,
      type: z.literal("file"),
    })
    .strict(),
  z
    .object({
      ...runEventBaseSchema,
      run: runSnapshotSchema,
      type: z.literal("completed"),
    })
    .strict(),
  z
    .object({
      ...runEventBaseSchema,
      error: runErrorSchema,
      type: z.literal("failed"),
    })
    .strict(),
]);

export const runEventsSchema = z
  .array(runEventSchema)
  .superRefine((events, context) => {
    for (let index = 1; index < events.length; index += 1) {
      if (events[index].id <= events[index - 1].id) {
        context.addIssue({
          code: "custom",
          message: "Run event ids must increase monotonically.",
          path: [index, "id"],
        });
      }
    }
  });

export const runSnapshotEnvelopeSchema = z
  .object({
    apiVersion: agentRunnerApiVersionSchema,
    run: runSnapshotSchema,
  })
  .strict();
/**
 * A short-lived, signed view of a running sandbox's desktop, or the reason
 * one is not available. The URL is unredacted by nature and expires; clients
 * refresh it rather than persist it.
 */
export const runLiveViewEnvelopeSchema = z
  .object({
    apiVersion: agentRunnerApiVersionSchema,
    view: z.discriminatedUnion("kind", [
      z
        .object({
          expiresAt: datetimeSchema,
          kind: z.literal("ready"),
          url: z.string().url().max(4096),
        })
        .strict(),
      z
        .object({
          kind: z.literal("unavailable"),
          reason: z.enum([
            "desktop_unavailable",
            "not_configured",
            "not_running",
            "provider_unavailable",
            "sandbox_missing",
          ]),
        })
        .strict(),
    ]),
  })
  .strict();
export const startRunEnvelopeSchema = runSnapshotEnvelopeSchema;
export const getRunEnvelopeSchema = runSnapshotEnvelopeSchema;
export const stopRunEnvelopeSchema = runSnapshotEnvelopeSchema;
export const runStartEnvelopeSchema = startRunEnvelopeSchema;
export const runGetEnvelopeSchema = getRunEnvelopeSchema;
export const runStopEnvelopeSchema = stopRunEnvelopeSchema;
export const runEventsEnvelopeSchema = z
  .object({
    apiVersion: agentRunnerApiVersionSchema,
    events: runEventsSchema,
  })
  .strict();

export const runListEnvelopeSchema = z
  .object({
    apiVersion: agentRunnerApiVersionSchema,
    runs: z.array(runSnapshotSchema),
  })
  .strict();

export const runErrorEnvelopeSchema = z
  .object({
    apiVersion: agentRunnerApiVersionSchema,
    error: runErrorSchema,
    requestId: boundedString(AGENT_RUNNER_LIMITS.maxRequestIdLength),
  })
  .strict();
export const agentRunnerErrorEnvelopeSchema = runErrorEnvelopeSchema;
export const errorEnvelopeSchema = runErrorEnvelopeSchema;

export const commandResultSchema = z.object({
  command: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  stderr: z.string().optional(),
  stdout: z.string().optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
});

export const fileOperationSchema = z.object({
  operation: z.string().optional(),
  path: z.string().optional(),
  timestamp: z.union([z.number(), z.string()]).optional(),
});

export const runResultSchema = z.object({
  agentId: agentIdSchema,
  commandResults: z
    .array(commandResultSchema)
    .max(AGENT_RUNNER_LIMITS.maxCommandResults),
  completedAt: datetimeSchema,
  fileOperations: z
    .array(fileOperationSchema)
    .max(AGENT_RUNNER_LIMITS.maxFileOperations),
  id: canonicalUuidSchema,
  output: z.string(),
  startedAt: datetimeSchema,
  status: z.enum(["completed", "failed"]),
});

export const demoProvenanceSchema = z
  .object({
    fixture: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    kind: z.literal("synthetic-demo"),
  })
  .strict();

const demoArtifactPathSchema = boundedString(
  AGENT_RUNNER_LIMITS.maxPathLength
).refine(
  (value) =>
    !/^(?:[a-z][a-z0-9+.-]*:|[\\/])/iu.test(value) &&
    !value.split(/[\\/]/u).includes(".."),
  "Demo artifact paths must stay relative to the synthetic workspace."
);

const demoCommandResultSchema = z
  .object({
    command: z.string().max(AGENT_RUNNER_LIMITS.maxCommandLength).optional(),
    exitCode: z.number().int().nullable().optional(),
    provenance: demoProvenanceSchema,
    stderr: z.string().max(AGENT_RUNNER_LIMITS.maxEventOutputLength).optional(),
    stdout: z.string().max(AGENT_RUNNER_LIMITS.maxEventOutputLength).optional(),
    timestamp: z.union([z.number(), z.string()]).optional(),
  })
  .strict();

const demoFileOperationSchema = z
  .object({
    operation: boundedString(64),
    path: demoArtifactPathSchema,
    provenance: demoProvenanceSchema,
    timestamp: z.union([z.number(), z.string()]).optional(),
  })
  .strict();

const demoRunResultSchema = runResultSchema
  .extend({
    commandResults: z
      .array(demoCommandResultSchema)
      .max(AGENT_RUNNER_LIMITS.maxCommandResults),
    fileOperations: z
      .array(demoFileOperationSchema)
      .max(AGENT_RUNNER_LIMITS.maxFileOperations),
    output: z.string().max(AGENT_RUNNER_LIMITS.maxEventOutputLength),
  })
  .strict();

export const demoTranscriptSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            event: runEventSchema,
            offsetMs: z
              .number()
              .int()
              .nonnegative()
              .max(DEMO_TRANSCRIPT_LIMITS.maxReplayDurationMs),
            provenance: demoProvenanceSchema,
          })
          .strict()
      )
      .min(1)
      .max(DEMO_TRANSCRIPT_LIMITS.maxEvents)
      .superRefine((events, context) => {
        for (let index = 1; index < events.length; index += 1) {
          if (events[index].event.id <= events[index - 1].event.id) {
            context.addIssue({
              code: "custom",
              message: "Run event ids must increase monotonically.",
              path: [index, "event", "id"],
            });
          }
          if (events[index].offsetMs < events[index - 1].offsetMs) {
            context.addIssue({
              code: "custom",
              message: "Run event offsets must increase monotonically.",
              path: [index, "offsetMs"],
            });
          }
        }
      }),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    provenance: demoProvenanceSchema,
    recordedAt: datetimeSchema,
    result: demoRunResultSchema,
    task: z.string().min(1).max(AGENT_RUNNER_LIMITS.maxTaskLength),
  })
  .strict()
  .superRefine((transcript, context) => {
    if (transcript.provenance.fixture !== transcript.name) {
      context.addIssue({
        code: "custom",
        message: "Transcript provenance must match the fixture name.",
        path: ["provenance", "fixture"],
      });
    }
    for (const [index, entry] of transcript.events.entries()) {
      if (entry.provenance.fixture !== transcript.name) {
        context.addIssue({
          code: "custom",
          message: "Event provenance must match the fixture name.",
          path: ["events", index, "provenance", "fixture"],
        });
      }
    }
    for (const [index, result] of transcript.result.commandResults.entries()) {
      if (result.provenance.fixture !== transcript.name) {
        context.addIssue({
          code: "custom",
          message: "Command provenance must match the fixture name.",
          path: ["result", "commandResults", index, "provenance", "fixture"],
        });
      }
    }
    for (const [
      index,
      operation,
    ] of transcript.result.fileOperations.entries()) {
      if (operation.provenance.fixture !== transcript.name) {
        context.addIssue({
          code: "custom",
          message: "File provenance must match the fixture name.",
          path: ["result", "fileOperations", index, "provenance", "fixture"],
        });
      }
    }
  });
export type DemoTranscript = z.infer<typeof demoTranscriptSchema>;

export const agentRunnerHealthSchema = z
  .object({
    apiVersion: agentRunnerApiVersionSchema,
    capabilities: agentRunnerCapabilitiesSchema,
    minimumClientVersion: boundedString(32),
    mode: backendSchema,
  })
  .strict();
export const healthResponseSchema = agentRunnerHealthSchema;
export const agentRunnerHealthResponseSchema = agentRunnerHealthSchema;
export const startRunRequestSchema = startRunInputSchema;
export const runStartRequestSchema = startRunInputSchema;

export const agentsEnvelopeSchema = z.object({
  agents: z.array(agentDefinitionSchema),
});

export const agentEnvelopeSchema = z.object({
  agent: agentDefinitionSchema,
});

export const skillsEnvelopeSchema = z
  .object({
    skills: z.array(skillResourceSchema),
  })
  .strict();

export const skillEnvelopeSchema = z
  .object({
    skill: skillResourceSchema,
  })
  .strict();

export const teamsEnvelopeSchema = z
  .object({
    teams: z.array(teamResourceSchema),
  })
  .strict();

export const teamEnvelopeSchema = z
  .object({
    team: teamResourceSchema,
  })
  .strict();

export const teamRunsEnvelopeSchema = z
  .object({
    nextCursor: teamRunIdSchema.nullable(),
    teamRuns: z.array(teamRunSchema).max(TEAM_LIMITS.maxTeamRunsPerPage),
  })
  .strict();

export const teamRunEnvelopeSchema = z
  .object({
    teamRun: teamRunSchema,
  })
  .strict();

/**
 * Projects a run snapshot onto the older `RunResult` shape.
 *
 * The browser client polls a snapshot to completion and hands the caller a
 * result. Keeping the projection beside the contract prevents drift over
 * details such as how a cancelled run is reported.
 *
 * `RunResult` has no cancelled state, so a cancelled run reports as failed —
 * which is what a caller waiting on an outcome needs to know.
 */
export function runSnapshotToResult(
  snapshot: z.infer<typeof runSnapshotSchema>
): z.infer<typeof runResultSchema> {
  if (snapshot.status === "queued" || snapshot.status === "running") {
    /**
     * `RunResult` has no in-flight state, so projecting one would report a run
     * that is still going as failed. Callers must wait for a terminal snapshot
     * rather than have this quietly invent an outcome.
     */
    throw new Error(
      `Cannot project a ${snapshot.status} run onto a result; wait for it to finish.`
    );
  }
  return {
    agentId: snapshot.agentId,
    commandResults: snapshot.commandEvidence
      .map((evidence) => ({
        command: evidence.command,
        exitCode: evidence.exitCode,
        stderr: evidence.stderr,
        stdout: evidence.stdout,
      }))
      .slice(0, AGENT_RUNNER_LIMITS.maxCommandResults),
    completedAt: snapshot.completedAt ?? snapshot.createdAt,
    fileOperations: snapshot.fileEvidence
      .map((evidence) => ({
        operation: evidence.operation,
        path: evidence.path,
      }))
      .slice(0, AGENT_RUNNER_LIMITS.maxFileOperations),
    id: snapshot.id,
    output: snapshot.output,
    startedAt: snapshot.startedAt ?? snapshot.createdAt,
    status: snapshot.status === "completed" ? "completed" : "failed",
  };
}

export const runEnvelopeSchema = z.object({
  run: runResultSchema,
});

export const okEnvelopeSchema = z.object({
  ok: z.literal(true),
});

export const apiErrorSchema = z.object({
  code: z.string(),
  error: z.string(),
});

export type Backend = z.infer<typeof backendSchema>;
export type Runtime = z.infer<typeof runtimeSchema>;
export type FamiliarId = z.infer<typeof familiarIdSchema>;
export type CreateAgentInput = z.input<typeof createAgentInputSchema>;
export type AgentDefinition = z.output<typeof agentDefinitionSchema>;
export type AgentOwner = z.infer<typeof agentOwnerSchema>;
export type RunAgentInput = z.infer<typeof runAgentInputSchema>;
export type StartRunInput = z.infer<typeof startRunInputSchema>;
export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
export type FileEvidence = z.infer<typeof fileEvidenceSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type AgentRunnerHealth = z.infer<typeof agentRunnerHealthSchema>;
export type AgentRunnerMode = AgentRunnerHealth["mode"];
export type AgentRunnerLimits = z.infer<typeof agentRunnerLimitsSchema>;
export type AgentRunnerRoute = z.infer<typeof agentRunnerRouteSchema>;
export type RunError = z.infer<typeof runErrorSchema>;
export type RunErrorEnvelope = z.infer<typeof runErrorEnvelopeSchema>;
export type RunEventType = z.infer<typeof runEventTypeSchema>;
export type RunEventsEnvelope = z.infer<typeof runEventsEnvelopeSchema>;
export type RunSnapshotEnvelope = z.infer<typeof runSnapshotEnvelopeSchema>;
export type RunLiveViewEnvelope = z.infer<typeof runLiveViewEnvelopeSchema>;
export type RunLiveView = RunLiveViewEnvelope["view"];
export type CreateSkillInput = z.input<typeof createSkillInputSchema>;
export type CreateTeamInput = z.input<typeof createTeamInputSchema>;
export type CreateTeamRunInput = z.input<typeof createTeamRunInputSchema>;
export type DraftTeamMissionInput = z.input<typeof draftTeamMissionInputSchema>;
export type ApproveTeamRunInput = z.input<typeof approveTeamRunInputSchema>;
export type ExpectedVersionInput = z.input<typeof expectedVersionInputSchema>;
export type GitHubOperationKind = z.infer<typeof githubOperationKindSchema>;
export type GitHubOperationReceipt = z.output<
  typeof githubOperationReceiptSchema
>;
export type GitHubOperationStatus = z.infer<typeof githubOperationStatusSchema>;
export type GitHubProjectFieldValue = z.infer<
  typeof githubProjectFieldValueSchema
>;
export type GitHubToolOperation = z.infer<typeof githubToolOperationSchema>;
export type GitHubToolRequest = z.infer<typeof githubToolRequestSchema>;
export type GitHubToolResult = z.infer<typeof githubToolResultSchema>;
export type SkillDefinition = z.output<typeof skillDefinitionSchema>;
export type SkillResource = z.output<typeof skillResourceSchema>;
export type TeamApprovalStatus = z.infer<typeof teamApprovalStatusSchema>;
export type TeamCapability = z.infer<typeof teamCapabilitySchema>;
export type TeamDefinition = z.output<typeof teamDefinitionSchema>;
export type TeamResource = z.output<typeof teamResourceSchema>;
export type TeamHandoff = z.output<typeof teamHandoffSchema>;
export type TeamMember = z.output<typeof teamMemberSchema>;
export type TeamRun = z.output<typeof teamRunSchema>;
export type TeamRunEnvelope = z.output<typeof teamRunEnvelopeSchema>;
export type TeamRunStatus = z.infer<typeof teamRunStatusSchema>;
export type TeamRunsEnvelope = z.output<typeof teamRunsEnvelopeSchema>;
export type TeamStep = z.output<typeof teamStepSchema>;
export type TeamStepStatus = z.infer<typeof teamStepStatusSchema>;
export type UpdateSkillInput = z.input<typeof updateSkillInputSchema>;
export type UpdateTeamInput = z.input<typeof updateTeamInputSchema>;
