import { z } from "zod";

/**
 * Read-only inspection of the one sandbox already recorded for an agent.
 *
 * This is a client contract, not authority: a result describes what the
 * lifecycle owner recorded and what the provider reported at one instant. It
 * never binds, adopts, starts, or repairs a sandbox, and holding one grants
 * nothing. It is versioned separately from the v1 runner contract.
 */
export const SANDBOX_INSPECTION_CONTRACT_VERSION = 1;

export const sandboxInspectionRequestSchema = z
  .object({
    expectedGeneration: z.number().int().min(0).max(2_147_483_647),
    expectedSandboxId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u),
  })
  .strict();
export type SandboxInspectionRequest = z.infer<
  typeof sandboxInspectionRequestSchema
>;

export const sandboxInspectionLifecycleSchema = z.enum([
  "unprovisioned",
  "provisioning",
  "provisioning_ambiguous",
  "ready",
  "resizing",
  "resetting",
  "decommissioning",
  "decommission_failed",
]);

/**
 * `cleanup_required` is a terminal attempt whose provider references were
 * never released; `attempt_outstanding` is a dispatching or running attempt.
 * Either one means another task must not be started.
 */
export const sandboxInspectionFenceSchema = z.enum([
  "none",
  "attempt_outstanding",
  "cleanup_required",
]);

const recordSchema = z
  .object({
    fence: sandboxInspectionFenceSchema,
    generation: z.number().int().min(0),
    lifecycle: sandboxInspectionLifecycleSchema,
  })
  .strict();

export const sandboxInspectionStateSchema = z.enum([
  "started",
  "stopped",
  "archived",
  "transitioning",
  "error",
  "destroyed",
  "unknown",
]);

const interval = z.number().int().min(-1).max(10_000_000).nullable();
const resource = z.number().int().min(0).max(4096);

/** Provider-reported values. Identifiers, names, and raw labels are withheld. */
const observedSchema = z
  .object({
    autoArchiveInterval: interval,
    autoDeleteInterval: interval,
    autoStopInterval: interval,
    cpu: resource,
    diskGib: resource,
    domainAllowListConfigured: z.boolean(),
    identity: z
      .object({
        configuration: z.enum(["current", "prior", "mismatch"]),
        credentialBoundary: z.boolean(),
        generationLabel: z.boolean(),
        ownershipLabels: z.boolean(),
      })
      .strict(),
    memoryGib: resource,
    networkBlockAll: z.boolean().nullable(),
    public: z.boolean(),
    snapshot: z.string().min(1).max(256).nullable(),
    state: sandboxInspectionStateSchema,
    target: z.string().min(1).max(64),
    volumes: z.number().int().min(0).max(1024),
  })
  .strict();

const pin = z.string().min(1).max(256);

/**
 * Server-selected source policy. None of this was measured on the sandbox:
 * the harness versions are the ones the pinned snapshot is built from.
 */
const policySchema = z
  .object({
    adapterVersion: pin,
    capabilityContractVersion: pin,
    credentialBoundaryVersion: pin,
    harnesses: z
      .array(z.object({ id: pin, package: pin, version: pin }).strict())
      .max(16),
    resources: z
      .object({ cpu: resource, diskGib: resource, memoryGib: resource })
      .strict(),
    sdkVersion: pin,
    snapshotName: pin,
    target: z.string().min(1).max(64),
  })
  .strict();

const version = z.literal(SANDBOX_INSPECTION_CONTRACT_VERSION);

export const sandboxInspectionResultSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      observed: observedSchema,
      outcome: z.literal("observed"),
      policy: policySchema,
      record: recordSchema,
      version,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("not_found"),
      policy: policySchema,
      record: recordSchema,
      version,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("ambiguous"),
      reason: z.enum([
        "generation_mismatch",
        "no_recorded_sandbox",
        "pending_lifecycle",
        "returned_id_mismatch",
        "sandbox_id_mismatch",
      ]),
      record: recordSchema,
      version,
    })
    .strict(),
  // Deliberately indistinguishable for a missing agent and another tenant's.
  z.object({ outcome: z.literal("unauthorized"), version }).strict(),
  z
    .object({
      outcome: z.literal("unavailable"),
      source: z.enum(["database", "provider"]),
      version,
    })
    .strict(),
]);
export type SandboxInspectionResult = z.infer<
  typeof sandboxInspectionResultSchema
>;
export type SandboxInspectionObserved = z.infer<typeof observedSchema>;
export type SandboxInspectionPolicy = z.infer<typeof policySchema>;
export type SandboxInspectionRecord = z.infer<typeof recordSchema>;
