import { z } from "zod";

export const backendSchema = z.enum(["cloud", "local"]);
/**
 * `cloud` is retained only so agent records created before Coven Agents moved to
 * harness execution still parse. It selects the retired provider-key runtime and
 * is rejected for new agents; every runnable runtime is a harness.
 */
export const runtimeSchema = z.enum(["cloud", "codex", "claude", "copilot"]);
export const agentStatusSchema = z.enum(["idle", "running", "error"]);
export const agentIdSchema = z.string().uuid();

const agentShapeSchema = z.object({
  backend: backendSchema,
  description: z.string().trim().max(240).default(""),
  instructions: z.string().trim().min(1).max(12_000),
  model: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(64),
  runtime: runtimeSchema,
  workspace: z.string().trim().max(1024).optional(),
});

export const createAgentInputSchema = agentShapeSchema.superRefine(
  (value, context) => {
    // Both backends now execute a harness. The cloud backend runs it inside a
    // sandbox container and the local backend runs it on the operator's machine,
    // but neither holds a model provider API key.
    if (value.runtime === "cloud") {
      context.addIssue({
        code: "custom",
        message:
          "The provider-key `cloud` runtime is retired. Select a harness runtime such as `copilot`.",
        path: ["runtime"],
      });
    }
  }
);

/**
 * Deliberately built from the plain shape rather than from
 * `createAgentInputSchema`, so tightening a create-time rule cannot make already
 * stored definitions unreadable and strand an agent in durable state.
 */
export const agentDefinitionSchema = agentShapeSchema.extend({
  createdAt: z.string().datetime(),
  id: agentIdSchema,
  lastRunAt: z.string().datetime().nullable(),
  /**
   * Server-assigned, and deliberately absent from `createAgentInputSchema`: a
   * client that could name its own owner could name someone else's and read
   * into their sandbox. Nullable so definitions stored before ownership existed
   * still parse.
   */
  owner: z.string().trim().min(1).max(64).nullable().default(null),
  status: agentStatusSchema,
  updatedAt: z.string().datetime(),
});

export const runAgentInputSchema = z.object({
  task: z.string().trim().min(1).max(40_000),
});

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
  completedAt: z.string().datetime(),
  fileOperations: z.array(z.unknown()),
  id: z.string().uuid(),
  output: z.string(),
  startedAt: z.string().datetime(),
  status: z.enum(["completed", "failed"]),
});

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
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type RunAgentInput = z.infer<typeof runAgentInputSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
