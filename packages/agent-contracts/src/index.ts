import { z } from "zod";
import { contractDescriptor } from "../contract-descriptor.js";

export { contractDescriptor } from "../contract-descriptor.js";
export {
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "./evidence.js";

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
 * the ownership check in the worker into a no-op across accounts.
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

/**
 * Both backends now execute a harness. The cloud backend runs it inside a
 * sandbox container and the local backend runs it on the operator's machine,
 * but neither holds a model provider API key.
 *
 * This branch originally required the inverse — `backend: "cloud"` had to pair
 * with `runtime: "cloud"` — because it predates the move to keyless harness
 * execution. That rule is replaced here rather than carried over; keeping it
 * would have reintroduced the retired provider-key runtime.
 */
const validateAgentBackendRuntime = (
  value: { backend: Backend; runtime: Runtime },
  context: z.RefinementCtx
) => {
  if (value.runtime === "cloud") {
    context.addIssue({
      code: "custom",
      message:
        "The provider-key `cloud` runtime is retired. Select a harness runtime such as `copilot`.",
      path: ["runtime"],
    });
  }
};

/**
 * `owner` is omitted deliberately. Ownership is a claim the server makes about
 * the caller, never one the caller makes about itself, and `.strict()` means a
 * submitted `owner` is rejected outright rather than silently dropped.
 *
 * Today the worker would win anyway, because it spreads its own owner after the
 * parsed input. That ordering is not something to rely on: reversing the spread
 * would hand agent ownership to whoever asked for it, with nothing failing.
 */
export const createAgentInputSchema = z
  .object(agentDefinitionInputShape)
  .omit({ owner: true })
  .strict()
  .superRefine(validateAgentBackendRuntime);

/**
 * Deliberately omits `validateAgentBackendRuntime`, so tightening a create-time
 * rule cannot make already stored definitions unreadable and strand an agent in
 * durable state. Agents created before the provider-key runtime was retired
 * still parse; they simply cannot be recreated.
 */
export const agentDefinitionSchema = z
  .object({
    ...agentDefinitionInputShape,
    createdAt: datetimeSchema,
    id: agentIdSchema,
    lastRunAt: datetimeSchema.nullable(),
    status: agentStatusSchema,
    updatedAt: datetimeSchema,
  })
  .strict();

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

/**
 * Projects a run snapshot onto the older `RunResult` shape.
 *
 * Two callers need this and they must agree: the cloud worker, which still
 * answers `RunResult` on its synchronous route, and the browser client, which
 * polls a snapshot to completion and hands the caller a result. Defining it
 * twice would let the two drift over something as small as how a cancelled run
 * is reported.
 *
 * `RunResult` has no cancelled state, so a cancelled run reports as failed —
 * which is what a caller waiting on an outcome needs to know.
 */
export function runSnapshotToResult(
  snapshot: z.infer<typeof runSnapshotSchema>
): z.infer<typeof runResultSchema> {
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
