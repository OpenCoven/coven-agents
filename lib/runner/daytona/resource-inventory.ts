import "server-only";

import { SandboxState } from "@daytona/sdk";
import {
  type RunnerResourceInventoryResult,
  runnerResourceInventoryLimit,
} from "../resource-lifecycle";
import type { RunnerStore } from "../store";
import type { RunnerOperator } from "../types";
import { daytonaSandboxLabels, daytonaSandboxName } from "./names";
import {
  DAYTONA_CODE_TOOLBOX_LANGUAGE_LABEL,
  DAYTONA_SANDBOX_LANGUAGE,
  type DaytonaSandboxConfiguration,
} from "./sandbox";

const COVEN_AGENTS_LABEL = Object.freeze({ app: "coven-agents" });
const INVENTORY_PROVIDER_CONCURRENCY = 4;

export type DaytonaSandboxInventoryService = Readonly<{
  get: (sandboxId: string) => Promise<DaytonaSandboxInventoryItem>;
  list: (
    query: Readonly<{
      labels: Readonly<{ app: "coven-agents" }>;
      limit: number;
    }>
  ) => AsyncIterable<DaytonaSandboxInventoryItem>;
}>;

export type DaytonaSandboxInventoryItem = Readonly<{
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  autoDestroyAt?: string;
  autoPauseInterval?: number;
  autoStopInterval?: number;
  cpu: number;
  disk: number;
  domainAllowList?: string;
  id: string;
  labels: Readonly<Record<string, string>>;
  linkedSandboxId?: string;
  memory: number;
  name: string;
  public: boolean;
  snapshot?: string;
  state?: SandboxState;
  target: string;
  volumes?: readonly unknown[];
  warmPoolId?: string;
}>;

export type DaytonaSandboxInventoryDependencies = Readonly<{
  configuration: DaytonaSandboxConfiguration;
  daytona: DaytonaSandboxInventoryService;
  limit?: number;
  operator: RunnerOperator;
  store: Pick<RunnerStore, "scanDaytonaSandboxInventory">;
}>;

type SandboxStateCounts = Extract<
  RunnerResourceInventoryResult,
  { kind: "available" }
>["states"];
type InventoryMapping = Awaited<
  ReturnType<RunnerStore["scanDaytonaSandboxInventory"]>
>[number];

function emptyStates(): SandboxStateCounts {
  return { active: 0, archived: 0, other: 0, stopped: 0 };
}

function recordState(
  states: SandboxStateCounts,
  sandbox: DaytonaSandboxInventoryItem
): SandboxStateCounts {
  switch (sandbox.state) {
    case SandboxState.ARCHIVED:
      return { ...states, archived: states.archived + 1 };
    case SandboxState.STARTED:
      return { ...states, active: states.active + 1 };
    case SandboxState.STOPPED:
      return { ...states, stopped: states.stopped + 1 };
    default:
      return { ...states, other: states.other + 1 };
  }
}

function sameLabels(
  labels: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>
): boolean {
  const labelEntries = Object.entries(labels);
  return (
    labelEntries.length === Object.keys(expected).length &&
    labelEntries.every(([key, value]) => expected[key] === value)
  );
}

function expectedLabels(
  agent: InventoryMapping
): Readonly<Record<string, string>> {
  return {
    ...daytonaSandboxLabels(agent.tenant, agent.id),
    [DAYTONA_CODE_TOOLBOX_LANGUAGE_LABEL]: DAYTONA_SANDBOX_LANGUAGE,
  };
}

function matchesConfiguredSandbox(
  sandbox: DaytonaSandboxInventoryItem,
  agent: InventoryMapping,
  configuration: DaytonaSandboxConfiguration
): boolean {
  return (
    sandbox.name === daytonaSandboxName(agent.tenant, agent.id) &&
    sameLabels(sandbox.labels, expectedLabels(agent)) &&
    sandbox.snapshot === configuration.snapshotName &&
    sandbox.target === configuration.target &&
    sandbox.cpu === configuration.resources.cpu &&
    sandbox.memory === configuration.resources.memory &&
    sandbox.disk === configuration.resources.disk &&
    sandbox.autoStopInterval === configuration.autoStopInterval &&
    sandbox.autoArchiveInterval === configuration.autoArchiveInterval &&
    sandbox.autoDeleteInterval === configuration.autoDeleteInterval &&
    sandbox.autoDestroyAt === undefined &&
    sandbox.autoPauseInterval === 0 &&
    sandbox.domainAllowList === configuration.domainAllowList &&
    sandbox.public === false &&
    (sandbox.volumes?.length ?? 0) === 0 &&
    sandbox.warmPoolId === undefined &&
    sandbox.linkedSandboxId === undefined
  );
}

function expectedLifecycleCandidate(
  sandbox: DaytonaSandboxInventoryItem,
  candidatesByName: ReadonlyMap<string, readonly InventoryMapping[]>
): boolean {
  return (candidatesByName.get(sandbox.name)?.length ?? 0) > 0;
}

async function mapBounded<T, Result>(
  values: readonly T[],
  operation: (value: T) => Promise<Result>
): Promise<Result[]> {
  const results: Result[] = [];
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: Each bounded worker serializes its exact-ID provider reads.
      results[index] = await operation(values[index] as T);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(INVENTORY_PROVIDER_CONCURRENCY, values.length) },
      () => worker()
    )
  );
  return results;
}

/**
 * Read-only bounded provider inventory. Labels and deterministic names are
 * observations only. A listed item is hydrated only after one stored provider
 * identifier matches exactly, and every uncertain observation remains
 * non-destructive.
 */
export async function inventoryDaytonaSandboxes(
  dependencies: DaytonaSandboxInventoryDependencies
): Promise<RunnerResourceInventoryResult> {
  const limit = runnerResourceInventoryLimit(dependencies.limit);
  let mappings: Awaited<ReturnType<RunnerStore["scanDaytonaSandboxInventory"]>>;
  try {
    mappings = await dependencies.store.scanDaytonaSandboxInventory(
      dependencies.operator,
      limit
    );
  } catch {
    return { kind: "unavailable", source: "database", version: 1 };
  }

  const sandboxes: DaytonaSandboxInventoryItem[] = [];
  try {
    for await (const sandbox of dependencies.daytona.list({
      labels: COVEN_AGENTS_LABEL,
      limit,
    })) {
      sandboxes.push(sandbox);
      if (sandboxes.length === limit) {
        break;
      }
    }
  } catch {
    return { kind: "unavailable", source: "provider", version: 1 };
  }

  const mappingsByProviderId = new Map<string, typeof mappings>();
  const candidatesByName = new Map<string, typeof mappings>();
  for (const mapping of mappings) {
    if (mapping.daytonaSandboxId) {
      const matching = mappingsByProviderId.get(mapping.daytonaSandboxId) ?? [];
      mappingsByProviderId.set(mapping.daytonaSandboxId, [
        ...matching,
        mapping,
      ]);
    }
    if (
      mapping.sandboxLifecycle === "provisioning" ||
      mapping.sandboxLifecycle === "provisioning_ambiguous"
    ) {
      const expectedName = daytonaSandboxName(mapping.tenant, mapping.id);
      const candidates = candidatesByName.get(expectedName) ?? [];
      candidatesByName.set(expectedName, [...candidates, mapping]);
    }
  }

  const labelCounts = new Map<string, number>();
  const providerIdCounts = new Map<string, number>();
  for (const sandbox of sandboxes) {
    const labeledAgent = sandbox.labels.agentId;
    if (labeledAgent) {
      labelCounts.set(labeledAgent, (labelCounts.get(labeledAgent) ?? 0) + 1);
    }
    providerIdCounts.set(
      sandbox.id,
      (providerIdCounts.get(sandbox.id) ?? 0) + 1
    );
  }

  const exactMappingCandidates = sandboxes.filter((sandbox) => {
    const mappingsForProviderId = mappingsByProviderId.get(sandbox.id) ?? [];
    return (
      mappingsForProviderId.length === 1 &&
      (labelCounts.get(sandbox.labels.agentId) ?? 0) === 1 &&
      (providerIdCounts.get(sandbox.id) ?? 0) === 1
    );
  });
  let hydrated: DaytonaSandboxInventoryItem[];
  try {
    hydrated = await mapBounded(exactMappingCandidates, (sandbox) =>
      dependencies.daytona.get(sandbox.id)
    );
  } catch {
    return { kind: "unavailable", source: "provider", version: 1 };
  }
  const hydratedByProviderId = new Map(
    exactMappingCandidates.map((sandbox, index) => [
      sandbox.id,
      hydrated[index],
    ])
  );

  let states = emptyStates();
  let ambiguous = 0;
  let matched = 0;
  let unowned = 0;
  const databaseCapped = mappings.length === limit;
  for (const sandbox of sandboxes) {
    states = recordState(states, sandbox);
    const mappingsForProviderId = mappingsByProviderId.get(sandbox.id) ?? [];
    const duplicateLabel = (labelCounts.get(sandbox.labels.agentId) ?? 0) > 1;
    const duplicateProviderId = (providerIdCounts.get(sandbox.id) ?? 0) > 1;
    if (mappingsForProviderId.length === 1 && !duplicateLabel) {
      const resolved = hydratedByProviderId.get(sandbox.id);
      if (
        !duplicateProviderId &&
        resolved &&
        matchesConfiguredSandbox(
          resolved,
          mappingsForProviderId[0],
          dependencies.configuration
        )
      ) {
        matched += 1;
        continue;
      }
    }
    if (
      mappingsForProviderId.length > 0 ||
      duplicateLabel ||
      duplicateProviderId ||
      expectedLifecycleCandidate(sandbox, candidatesByName) ||
      databaseCapped
    ) {
      ambiguous += 1;
      continue;
    }
    unowned += 1;
  }

  const providerCapped = sandboxes.length === limit;
  return {
    ambiguous,
    appOwnedMappings: mappings.length,
    databaseCapped,
    examined: sandboxes.length,
    kind: "available",
    matched,
    providerCapped,
    states,
    status: databaseCapped || providerCapped ? "bounded" : "complete",
    unowned,
    version: 1,
  };
}
