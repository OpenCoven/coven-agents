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

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u);

/**
 * `agentId` echoes the agent record that was read, so a consumer can refuse
 * an answer about a different record. `sandboxId` is the recorded sandbox ID,
 * and is non-null only when the whole binding matched and the provider was
 * asked about that ID: it then equals the ID the caller supplied. A refusal
 * decided from the database never discloses the recorded ID.
 */
const recordSchema = z
  .object({
    agentId: identifier,
    fence: sandboxInspectionFenceSchema,
    generation: z.number().int().min(0),
    lifecycle: sandboxInspectionLifecycleSchema,
    sandboxId: identifier.nullable(),
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

/**
 * Provider-reported values. Identifiers, names, raw labels, and raw allow
 * lists are withheld: egress is reported as a comparison with the owner's
 * configured policy, and attachments and a TTL only as present or absent.
 */
const observedSchema = z
  .object({
    autoArchiveInterval: interval,
    autoDeleteInterval: interval,
    /** A destructive TTL deadline is set on the sandbox. */
    autoDestroyAtConfigured: z.boolean(),
    autoPauseInterval: interval,
    autoStopInterval: interval,
    cpu: resource,
    diskGib: resource,
    domainAllowListConfigured: z.boolean(),
    /**
     * The sandbox's domain allow list equals the owner's configured policy by
     * exact string equality, as in the drift inventory. Unlike the inventory,
     * absent or null on both sides is a match, and a provider null TTL, warm
     * pool or linked sandbox reads as not set rather than as drift.
     */
    domainAllowListMatchesPolicy: z.boolean(),
    gpu: resource.nullable(),
    identity: z
      .object({
        configuration: z.enum(["current", "prior", "mismatch"]),
        credentialBoundary: z.boolean(),
        generationLabel: z.boolean(),
        ownershipLabels: z.boolean(),
      })
      .strict(),
    linkedSandbox: z.boolean(),
    memoryGib: resource,
    /** The owner policy sets no network allow list, so any value is drift. */
    networkAllowListConfigured: z.boolean(),
    networkBlockAll: z.boolean().nullable(),
    public: z.boolean(),
    snapshot: z.string().min(1).max(256).nullable(),
    state: sandboxInspectionStateSchema,
    target: z.string().min(1).max(64),
    volumes: z.number().int().min(0).max(1024),
    warmPool: z.boolean(),
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
  z.discriminatedUnion("reason", [
    // Decided from the database alone, before the provider is asked: the
    // recorded sandbox ID is never disclosed.
    z
      .object({
        outcome: z.literal("ambiguous"),
        reason: z.enum([
          "generation_mismatch",
          "no_recorded_sandbox",
          "pending_lifecycle",
          "sandbox_id_mismatch",
        ]),
        record: recordSchema.extend({ sandboxId: z.null() }).strict(),
        version,
      })
      .strict(),
    // The provider was asked about the supplied ID and answered for another.
    z
      .object({
        outcome: z.literal("ambiguous"),
        reason: z.literal("returned_id_mismatch"),
        record: recordSchema,
        version,
      })
      .strict(),
  ]),
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
