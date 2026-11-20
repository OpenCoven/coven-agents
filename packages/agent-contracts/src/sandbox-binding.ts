import { z } from "zod";

/**
 * Optional sandbox expectation on a run start request.
 *
 * This is a client contract, not authority. The two values never select,
 * bind, adopt, or create a sandbox: the server compares them with what its
 * lifecycle owner already recorded for the agent and can only refuse. A run
 * that carries a binding is never dispatched to any other sandbox, and its
 * dispatch never creates, recreates, starts, resizes, or relabels one.
 */
export const RUN_SANDBOX_BINDING_CONTRACT_VERSION = 1;

export const runSandboxBindingSchema = z
  .object({
    expectedGeneration: z.number().int().min(0).max(2_147_483_647),
    expectedSandboxId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u),
  })
  .strict();
export type RunSandboxBinding = z.infer<typeof runSandboxBindingSchema>;

export const RUN_SANDBOX_BINDING_REFUSAL_CODE = "sandbox_binding_refused";

/**
 * Why a bound run was refused. The first five are decided from the durable
 * agent record; the rest need the one provider read made at dispatch.
 */
export const RUN_SANDBOX_BINDING_REFUSAL_REASONS = [
  "no_recorded_sandbox",
  "sandbox_id_mismatch",
  "generation_mismatch",
  "lifecycle_not_ready",
  "fence_outstanding",
  "provider_not_found",
  "returned_id_mismatch",
  "destroyed",
  "not_started",
  "ownership_mismatch",
  "configuration_drift",
  "credential_boundary_missing",
  "public_sandbox",
] as const;
export const runSandboxBindingRefusalReasonSchema = z.enum(
  RUN_SANDBOX_BINDING_REFUSAL_REASONS
);
export type RunSandboxBindingRefusalReason = z.infer<
  typeof runSandboxBindingRefusalReasonSchema
>;

/**
 * The error object of a refused bound run. It is the same shape as any other
 * run error, so it appears unchanged both in the start response's error
 * envelope and as the terminal error of a run refused at dispatch. `details`
 * carries the reason; a refusal is never retryable as-is.
 */
export const runSandboxBindingRefusalSchema = z
  .object({
    code: z.literal(RUN_SANDBOX_BINDING_REFUSAL_CODE),
    details: runSandboxBindingRefusalReasonSchema,
    message: z.string().min(1).max(1024),
    retryable: z.literal(false),
  })
  .strict();
export type RunSandboxBindingRefusal = z.infer<
  typeof runSandboxBindingRefusalSchema
>;
