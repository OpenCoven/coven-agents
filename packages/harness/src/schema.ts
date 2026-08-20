import { z } from "zod";

/**
 * A harness is an already-authenticated coding CLI. Coven Agents drives a
 * harness instead of calling a model provider directly, so no runner ever holds
 * a provider API key. Credentials stay where the operator already put them: the
 * harness's own sign-in, or a harness-scoped token the harness itself reads.
 */
export const harnessIdSchema = z.enum(["copilot", "codex", "claude"]);

export const harnessStatusSchema = z.object({
  detail: z.string(),
  id: harnessIdSchema,
  installed: z.boolean(),
  label: z.string(),
  /** Streams structured events rather than only a final blob of text. */
  streams: z.boolean(),
  supported: z.boolean(),
  version: z.string().nullable(),
});

export const harnessesEnvelopeSchema = z.object({
  harnesses: z.array(harnessStatusSchema),
});

/**
 * One normalized frame of a live run. Every harness is translated into this
 * vocabulary so the UI never learns a vendor's private event names.
 */
export const runEventSchema = z.discriminatedUnion("kind", [
  z.object({
    at: z.string(),
    harness: harnessIdSchema,
    kind: z.literal("started"),
    runId: z.string(),
  }),
  z.object({ at: z.string(), kind: z.literal("reasoning"), text: z.string() }),
  z.object({ at: z.string(), kind: z.literal("delta"), text: z.string() }),
  z.object({
    at: z.string(),
    kind: z.literal("message"),
    model: z.string().nullable(),
    text: z.string(),
  }),
  z.object({
    at: z.string(),
    callId: z.string(),
    kind: z.literal("tool-start"),
    summary: z.string(),
    tool: z.string(),
  }),
  z.object({
    at: z.string(),
    callId: z.string(),
    kind: z.literal("tool-end"),
    success: z.boolean(),
    summary: z.string(),
  }),
  z.object({
    at: z.string(),
    kind: z.literal("file"),
    operation: z.string(),
    path: z.string(),
  }),
  z.object({
    at: z.string(),
    kind: z.literal("usage"),
    linesAdded: z.number().int().nullable(),
    linesRemoved: z.number().int().nullable(),
    premiumRequests: z.number().nullable(),
  }),
  z.object({
    at: z.string(),
    exitCode: z.number().int().nullable(),
    filesModified: z.array(z.string()),
    kind: z.literal("finished"),
    sessionId: z.string().nullable(),
    status: z.enum(["completed", "failed"]),
  }),
  z.object({ at: z.string(), kind: z.literal("error"), message: z.string() }),
]);

export type HarnessId = z.infer<typeof harnessIdSchema>;
export type HarnessStatus = z.infer<typeof harnessStatusSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
