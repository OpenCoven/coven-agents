import { z } from "zod";
import { contractDescriptor } from "../contract-descriptor.js";

export { contractDescriptor } from "../contract-descriptor.js";

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

export const backendSchema = z.enum(["cloud", "local"]);
export const runtimeSchema = z.enum(["cloud", "codex", "claude", "copilot"]);
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
    maxDescriptionLength: z.number().int().positive(),
    maxDetailsLength: z.number().int().positive(),
    maxEventOutputLength: z.number().int().positive(),
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

export const agentOwnerSchema = z.discriminatedUnion("kind", [
  standaloneAgentOwnerSchema,
  caveFamiliarAgentOwnerSchema,
]);
export const ownerSchema = agentOwnerSchema;

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
  owner: agentOwnerSchema.default({ kind: "standalone" }),
  runtime: runtimeSchema,
  workspace: z
    .string()
    .trim()
    .max(AGENT_RUNNER_LIMITS.maxWorkspaceLength)
    .optional(),
};

const validateAgentBackendRuntime = (
  value: { backend: Backend; runtime: Runtime },
  context: z.RefinementCtx
) => {
  if (value.backend === "cloud" && value.runtime !== "cloud") {
    context.addIssue({
      code: "custom",
      message: "Cloud agents must use the cloud runtime.",
      path: ["runtime"],
    });
  }
  if (value.backend === "local" && value.runtime === "cloud") {
    context.addIssue({
      code: "custom",
      message: "Local agents must select a local CLI runtime.",
      path: ["runtime"],
    });
  }
};

export const createAgentInputSchema = z
  .object(agentDefinitionInputShape)
  .strict()
  .superRefine(validateAgentBackendRuntime);

export const agentDefinitionSchema = z
  .object({
    ...agentDefinitionInputShape,
    createdAt: datetimeSchema,
    id: agentIdSchema,
    lastRunAt: datetimeSchema.nullable(),
    status: agentStatusSchema,
    updatedAt: datetimeSchema,
  })
  .strict()
  .superRefine(validateAgentBackendRuntime);

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
    commandEvidence: z.array(commandEvidenceSchema),
    completedAt: datetimeSchema.nullable().default(null),
    createdAt: datetimeSchema,
    error: runErrorSchema.nullable().optional(),
    fileEvidence: z.array(fileEvidenceSchema),
    id: z.string().uuid(),
    operationId: z.string().uuid(),
    output: z.string().max(AGENT_RUNNER_LIMITS.maxEventOutputLength),
    startedAt: datetimeSchema.nullable().default(null),
    status: runStatusSchema,
    task: z.string().trim().min(1).max(AGENT_RUNNER_LIMITS.maxTaskLength),
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
  commandResults: z.array(z.unknown()),
  completedAt: datetimeSchema,
  fileOperations: z.array(z.unknown()),
  id: z.string().uuid(),
  output: z.string(),
  startedAt: datetimeSchema,
  status: z.enum(["completed", "failed"]),
});

export const agentRunnerHealthSchema = z
  .object({
    apiVersion: agentRunnerApiVersionSchema,
    capabilities: agentRunnerCapabilitiesSchema,
    minimumClientVersion: boundedString(32),
    mode: z.enum(["local", "cloud"]),
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
