import { z } from "zod";
import { contractDescriptor } from "../contract-descriptor";

export { contractDescriptor } from "../contract-descriptor";
export {
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "./evidence";
export {
  base64UrlDecode,
  base64UrlEncode,
  TENANT_ID_PATTERN,
} from "./identity";

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

/**
 * Stable Agent Runner v1 deployment-class discriminator. `cloud` means the
 * runner is remotely deployed; it is not an execution-provider identity or
 * provider-selection control.
 */
export const backendSchema = z.literal("cloud");
export const runtimeSchema = z.enum(["codex", "claude", "copilot"]);
export const agentStatusSchema = z.enum(["idle", "running", "error"]);
export const agentIdSchema = z.string().uuid();

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
export const skillIdSchema = z.string().uuid();
export const teamIdSchema = z.string().uuid();
export const teamRunIdSchema = z.string().uuid();
export const teamStepIdSchema = z.string().uuid();

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
  id: z.string().uuid(),
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
    operationId: z.string().uuid(),
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
    commandEvidence: z
      .array(commandEvidenceSchema)
      .max(AGENT_RUNNER_LIMITS.maxCommandResults),
    completedAt: datetimeSchema.nullable().default(null),
    createdAt: datetimeSchema,
    error: runErrorSchema.nullable().optional(),
    fileEvidence: z
      .array(fileEvidenceSchema)
      .max(AGENT_RUNNER_LIMITS.maxFileOperations),
    id: z.string().uuid(),
    operationId: z.string().uuid(),
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
  "project.item.add",
  "project.item.field.update",
]);
export const githubOperationStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);

export const createTeamRunInputSchema = z
  .object({
    operationId: z.string().uuid(),
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
    id: z.string().uuid(),
    kind: githubOperationKindSchema,
    providerRequestId: z.string().trim().max(256).nullable(),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    resultNodeId: z.string().trim().max(256).nullable(),
    resultUrl: z.url().max(2048).nullable(),
    status: githubOperationStatusSchema,
    stepId: teamStepIdSchema,
    target: boundedString(512),
  })
  .strict();

export const teamStepSchema = z
  .object({
    agentId: agentIdSchema,
    approvalStatus: teamApprovalStatusSchema,
    completedAt: datetimeSchema.nullable(),
    createdAt: datetimeSchema,
    error: runErrorSchema.nullable(),
    handoff: teamHandoffSchema.nullable(),
    id: teamStepIdSchema,
    position: z.number().int().nonnegative(),
    required: z.boolean(),
    responsibility: boundedString(AGENT_RUNNER_LIMITS.maxInstructionsLength),
    runnerRunId: z.string().uuid().nullable(),
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
    operationId: z.string().uuid(),
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
      operationId: z.string().uuid(),
      runId: z.string().uuid(),
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
  id: z.string().uuid(),
  output: z.string(),
  startedAt: datetimeSchema,
  status: z.enum(["completed", "failed"]),
});

export const demoTranscriptSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            event: runEventSchema,
            offsetMs: z.number().int().nonnegative(),
          })
          .strict()
      )
      .min(1)
      .superRefine((events, context) => {
        for (let index = 1; index < events.length; index += 1) {
          if (events[index].event.id <= events[index - 1].event.id) {
            context.addIssue({
              code: "custom",
              message: "Run event ids must increase monotonically.",
              path: [index, "event", "id"],
            });
          }
        }
      }),
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/),
    recordedAt: datetimeSchema,
    result: runResultSchema,
    task: z.string().min(1),
  })
  .strict();
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
export type CreateSkillInput = z.input<typeof createSkillInputSchema>;
export type CreateTeamInput = z.input<typeof createTeamInputSchema>;
export type CreateTeamRunInput = z.input<typeof createTeamRunInputSchema>;
export type ApproveTeamRunInput = z.input<typeof approveTeamRunInputSchema>;
export type ExpectedVersionInput = z.input<typeof expectedVersionInputSchema>;
export type GitHubOperationKind = z.infer<typeof githubOperationKindSchema>;
export type GitHubOperationReceipt = z.output<
  typeof githubOperationReceiptSchema
>;
export type GitHubOperationStatus = z.infer<typeof githubOperationStatusSchema>;
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
