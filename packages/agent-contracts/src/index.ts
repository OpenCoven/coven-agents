import { z } from "zod";

export const backendSchema = z.enum(["cloud", "local"]);
export const runtimeSchema = z.enum(["cloud", "codex", "claude", "copilot"]);
export const agentStatusSchema = z.enum(["idle", "running", "error"]);
export const agentIdSchema = z.string().uuid();

export const createAgentInputSchema = z
  .object({
    backend: backendSchema,
    description: z.string().trim().max(240).default(""),
    instructions: z.string().trim().min(1).max(12_000),
    model: z.string().trim().min(1).max(120),
    name: z.string().trim().min(1).max(64),
    runtime: runtimeSchema,
    workspace: z.string().trim().max(1024).optional(),
  })
  .superRefine((value, context) => {
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
  });

export const agentDefinitionSchema = createAgentInputSchema.and(
  z.object({
    createdAt: z.string().datetime(),
    id: agentIdSchema,
    lastRunAt: z.string().datetime().nullable(),
    status: agentStatusSchema,
    updatedAt: z.string().datetime(),
  })
);

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
