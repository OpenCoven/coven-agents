import "server-only";

import {
  SANDBOX_INSPECTION_CONTRACT_VERSION,
  type SandboxInspectionObserved,
  type SandboxInspectionPolicy,
  type SandboxInspectionRecord,
  type SandboxInspectionRequest,
  type SandboxInspectionResult,
  sandboxInspectionResultSchema,
} from "@opencoven/agent-contracts";
import { SUPPORTED_HARNESS_SPECS } from "@opencoven/harness";
import { HOSTED_EXECUTION_CAPABILITY_CONTRACT_VERSION } from "../execution-provenance";
import type { RunnerAgentRecord, RunnerPrincipal } from "../types";
import { daytonaSandboxLabels } from "./names";
import type { DaytonaSandboxInventoryItem } from "./resource-inventory";
import {
  classifyDaytonaProviderError,
  DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
  type DaytonaSandboxConfiguration,
  daytonaSandboxConfigurationIdentity,
} from "./sandbox";

/** Must equal the pinned `@daytona/sdk` dependency; a test enforces it. */
export const DAYTONA_SDK_VERSION = "0.230.0";
/** Kept local so inspection does not load the dispatch executor module. */
export const DAYTONA_INSPECTION_ADAPTER_VERSION = "daytona-adapter-v1";

export type DaytonaSandboxInspectionItem = DaytonaSandboxInventoryItem &
  Readonly<{
    gpu?: number;
    networkAllowList?: string;
    networkBlockAll?: boolean;
  }>;

/**
 * The whole provider surface inspection may touch: one read by exact ID. The
 * type deliberately has no list, create, start, stop, delete, or label
 * member, so a mutation cannot be reached from this module.
 */
export type DaytonaSandboxInspectionService = Readonly<{
  get: (sandboxId: string) => Promise<DaytonaSandboxInspectionItem>;
}>;

export type SandboxInspectionFence = SandboxInspectionRecord["fence"];
export type SandboxInspectionFenceRead = Readonly<{
  agent: RunnerAgentRecord;
  fence: SandboxInspectionFence;
}>;

export type DaytonaSandboxInspectionDependencies = Readonly<{
  configuration: () => DaytonaSandboxConfiguration;
  daytona: () => DaytonaSandboxInspectionService;
  store: Readonly<{
    getAgentSandboxFence: (
      principal: RunnerPrincipal,
      agentId: string
    ) => Promise<SandboxInspectionFenceRead | null>;
  }>;
}>;

const version = SANDBOX_INSPECTION_CONTRACT_VERSION;
const UNAUTHORIZED: SandboxInspectionResult = {
  outcome: "unauthorized",
  version,
};

function unavailable(source: "database" | "provider"): SandboxInspectionResult {
  return { outcome: "unavailable", source, version };
}

function observedState(
  state: DaytonaSandboxInspectionItem["state"]
): SandboxInspectionObserved["state"] {
  switch (state) {
    case "started":
    case "stopped":
    case "archived":
    case "error":
    case "destroyed":
      return state;
    case "build_failed":
      return "error";
    case undefined:
    case "unknown":
      return "unknown";
    default:
      // Every remaining provider state is an in-flight transition.
      return typeof state === "string" && /^[a-z_]+$/u.test(state)
        ? "transitioning"
        : "unknown";
  }
}

/** Optional provider metadata that is present with the wrong type. */
class MalformedProviderMetadata extends Error {}

/**
 * Reads one optional provider value. Only `undefined` and `null` are absent;
 * a value of any other wrong type, a function included, throws, so it can
 * never be reported as "not set".
 */
function optional<T>(
  value: unknown,
  accepts: (candidate: unknown) => candidate is T
): T | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!accepts(value)) {
    throw new MalformedProviderMetadata();
  }
  return value;
}

const isNumber = (value: unknown): value is number => typeof value === "number";
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const isList = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);

function policy(
  configuration: DaytonaSandboxConfiguration
): SandboxInspectionPolicy {
  return {
    adapterVersion: DAYTONA_INSPECTION_ADAPTER_VERSION,
    capabilityContractVersion: HOSTED_EXECUTION_CAPABILITY_CONTRACT_VERSION,
    credentialBoundaryVersion: DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
    harnesses: SUPPORTED_HARNESS_SPECS.map((spec) => ({
      id: spec.id,
      package: spec.installPackage,
      version: spec.installVersion,
    })),
    resources: {
      cpu: configuration.resources.cpu,
      diskGib: configuration.resources.disk,
      memoryGib: configuration.resources.memory,
    },
    sdkVersion: DAYTONA_SDK_VERSION,
    snapshotName: configuration.snapshotName,
    target: configuration.target,
  };
}

function observed(
  sandbox: DaytonaSandboxInspectionItem,
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration
): SandboxInspectionObserved {
  const labels =
    typeof sandbox.labels === "object" && sandbox.labels !== null
      ? sandbox.labels
      : {};
  const domainAllowList = optional(sandbox.domainAllowList, isString);
  const snapshot = optional(sandbox.snapshot, isString);
  return {
    autoArchiveInterval: optional(sandbox.autoArchiveInterval, isNumber),
    autoDeleteInterval: optional(sandbox.autoDeleteInterval, isNumber),
    autoDestroyAtConfigured: optional(sandbox.autoDestroyAt, isString) !== null,
    autoPauseInterval: optional(sandbox.autoPauseInterval, isNumber),
    autoStopInterval: optional(sandbox.autoStopInterval, isNumber),
    cpu: sandbox.cpu,
    diskGib: sandbox.disk,
    domainAllowListConfigured:
      domainAllowList !== null && domainAllowList.trim().length > 0,
    // Exact string equality with the configured policy, as in the drift
    // inventory, except that a provider null with no configured list counts
    // as a match here, where the inventory reports drift.
    domainAllowListMatchesPolicy:
      domainAllowList === (configuration.domainAllowList ?? null),
    gpu: optional(sandbox.gpu, isNumber),
    identity: {
      configuration: daytonaSandboxConfigurationIdentity(
        { labels: { ...labels } },
        configuration
      ),
      credentialBoundary:
        labels.credentialBoundaryVersion ===
        DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
      generationLabel:
        labels.sandboxGeneration === String(agent.sandboxGeneration),
      ownershipLabels: Object.entries(
        daytonaSandboxLabels(agent.tenant, agent.id)
      ).every(([name, value]) => labels[name] === value),
    },
    linkedSandbox: optional(sandbox.linkedSandboxId, isString) !== null,
    memoryGib: sandbox.memory,
    // The owner policy sets no network allow list, so any non-empty value,
    // whitespace included, is drift.
    networkAllowListConfigured:
      (optional(sandbox.networkAllowList, isString)?.length ?? 0) > 0,
    networkBlockAll: optional(sandbox.networkBlockAll, isBoolean),
    public: sandbox.public,
    snapshot: snapshot !== null && snapshot.length > 0 ? snapshot : null,
    state: observedState(sandbox.state),
    target: sandbox.target,
    volumes: optional(sandbox.volumes, isList)?.length ?? 0,
    warmPool: optional(sandbox.warmPoolId, isString) !== null,
  };
}

/**
 * Inspects the one sandbox already recorded for the caller's agent.
 *
 * Ownership comes from the tenant-scoped row, never from the supplied ID: the
 * expected ID and generation only have to agree with that row. At most one
 * provider read is made, by the recorded ID, and only after every database
 * check has passed. Nothing is created, started, relabelled, or adopted, and
 * no credential is touched. Provider and database errors are reduced to a
 * fixed outcome so no raw detail leaves this boundary.
 */
export async function inspectDaytonaSandbox(
  principal: RunnerPrincipal,
  agentId: string,
  expected: SandboxInspectionRequest,
  dependencies: DaytonaSandboxInspectionDependencies
): Promise<SandboxInspectionResult> {
  let read: SandboxInspectionFenceRead | null;
  try {
    read = await dependencies.store.getAgentSandboxFence(principal, agentId);
  } catch {
    return unavailable("database");
  }
  if (
    !read ||
    read.agent.tenant !== principal.tenant ||
    read.agent.id !== agentId
  ) {
    return UNAUTHORIZED;
  }
  const { agent } = read;
  // Until the whole binding has matched, the recorded sandbox ID is withheld.
  const refused: SandboxInspectionRecord & { sandboxId: null } = {
    agentId: agent.id,
    fence: read.fence,
    generation: agent.sandboxGeneration,
    lifecycle: agent.sandboxLifecycle,
    sandboxId: null,
  };
  const ambiguous = (
    reason: Exclude<
      Extract<SandboxInspectionResult, { outcome: "ambiguous" }>["reason"],
      "returned_id_mismatch"
    >
  ): SandboxInspectionResult => ({
    outcome: "ambiguous",
    reason,
    record: refused,
    version,
  });

  const recordedSandboxId = agent.daytonaSandboxId;
  if (!recordedSandboxId) {
    return ambiguous("no_recorded_sandbox");
  }
  if (recordedSandboxId !== expected.expectedSandboxId) {
    return ambiguous("sandbox_id_mismatch");
  }
  if (agent.sandboxGeneration !== expected.expectedGeneration) {
    return ambiguous("generation_mismatch");
  }
  if (agent.sandboxLifecycle !== "ready") {
    return ambiguous("pending_lifecycle");
  }

  // The binding matched, so this is the ID the caller already supplied.
  const matched: SandboxInspectionRecord = {
    ...refused,
    sandboxId: recordedSandboxId,
  };

  let configuration: DaytonaSandboxConfiguration;
  let provider: DaytonaSandboxInspectionService;
  try {
    configuration = dependencies.configuration();
    provider = dependencies.daytona();
  } catch {
    return unavailable("provider");
  }

  let sandbox: DaytonaSandboxInspectionItem;
  try {
    sandbox = await provider.get(recordedSandboxId);
  } catch (error) {
    return classifyDaytonaProviderError(error) === "not_found"
      ? {
          outcome: "not_found",
          policy: policy(configuration),
          record: matched,
          version,
        }
      : unavailable("provider");
  }
  if (sandbox.id !== recordedSandboxId) {
    return {
      outcome: "ambiguous",
      reason: "returned_id_mismatch",
      record: matched,
      version,
    };
  }

  let observation: SandboxInspectionObserved;
  try {
    observation = observed(sandbox, agent, configuration);
  } catch (error) {
    if (error instanceof MalformedProviderMetadata) {
      return unavailable("provider");
    }
    throw error;
  }
  const result = sandboxInspectionResultSchema.safeParse({
    observed: observation,
    outcome: "observed",
    policy: policy(configuration),
    record: matched,
    version,
  });
  // Missing or malformed provider metadata is never reported as observed.
  return result.success ? result.data : unavailable("provider");
}
