import "server-only";

import { randomBytes } from "node:crypto";
import { SandboxState } from "@daytona/sdk";
import type { RunnerResourceRepairResult } from "../resource-lifecycle";
import type { RunnerStore } from "../store";
import type { RunnerAgentRecord, RunnerOperator } from "../types";
import {
  type DaytonaSandboxInventoryItem,
  daytonaSandboxConfigurationDrift,
} from "./resource-inventory";
import type { DaytonaSandboxConfiguration } from "./sandbox";

const REPAIR_BATCH_SIZE = 4;
const REPAIR_CANDIDATE_LIMIT = REPAIR_BATCH_SIZE + 1;
const REPAIR_LEASE_TTL_SECONDS = 300;
const RESIZE_VERIFICATION_ATTEMPTS = 3;
const RESIZE_VERIFICATION_INTERVAL_MS = 1000;
const RESIZE_REQUEST_TIMEOUT_SECONDS = 15;
const RESIZE_TIMEOUT_SECONDS = 60;
const PROVIDER_CALL_RESERVE_MS = 20_000;
const RESIZE_COMPLETION_RESERVE_MS = 60_000;
const REPAIRABLE_FIELDS = new Set(["cpu", "disk", "memory"]);

export type DaytonaSandboxRepairItem = DaytonaSandboxInventoryItem &
  Readonly<{
    resize: (
      resources: Readonly<{ cpu: number; disk: number; memory: number }>,
      timeout?: number
    ) => Promise<void>;
    waitForResizeComplete: (timeout?: number) => Promise<void>;
  }>;

export type DaytonaSandboxRepairService = Readonly<{
  get: (sandboxId: string) => Promise<DaytonaSandboxRepairItem>;
}>;

export type DaytonaSandboxRepairDependencies = Readonly<{
  configuration: DaytonaSandboxConfiguration;
  daytona: DaytonaSandboxRepairService;
  deadline?: number;
  now?: () => number;
  operator: RunnerOperator;
  sleep?: (milliseconds: number) => Promise<void>;
  store: Pick<
    RunnerStore,
    | "acquireReconciliationLease"
    | "beginDaytonaSandboxResize"
    | "deferDaytonaSandboxResize"
    | "finishDaytonaSandboxResize"
    | "releaseReconciliationLease"
    | "scanDaytonaSandboxRepairCandidates"
  >;
}>;

type RepairCandidate = Awaited<
  ReturnType<RunnerStore["scanDaytonaSandboxRepairCandidates"]>
>[number];
type InventoryMapping = RepairCandidate["mapping"];
type RepairObservation = Readonly<{
  eligible: boolean;
  outcome: "deferred" | "failure" | "refused" | "repaired" | "unchanged";
}>;

function sameMapping(
  first: RunnerAgentRecord,
  second: RunnerAgentRecord
): boolean {
  return (
    first.id === second.id &&
    first.tenant === second.tenant &&
    first.daytonaSandboxId === second.daytonaSandboxId &&
    first.sandboxLifecycle === second.sandboxLifecycle &&
    first.version === second.version
  );
}

function repairableResourceDrift(
  sandbox: DaytonaSandboxRepairItem,
  mapping: InventoryMapping,
  configuration: DaytonaSandboxConfiguration
): boolean {
  if (
    sandbox.state !== SandboxState.STOPPED ||
    sandbox.id !== mapping.daytonaSandboxId
  ) {
    return false;
  }
  const drift = daytonaSandboxConfigurationDrift(
    sandbox,
    mapping,
    configuration
  );
  return (
    drift.length > 0 &&
    drift.every(
      (entry) =>
        entry.relation === "below" && REPAIRABLE_FIELDS.has(entry.field)
    )
  );
}

function availableResult(
  candidates: readonly RepairCandidate[],
  batchCapped: boolean,
  counts: Readonly<{
    deferred: number;
    eligible: number;
    failures: number;
    refused: number;
    repaired: number;
    unchanged: number;
  }>
): RunnerResourceRepairResult {
  return {
    appOwnedMappings: candidates[0]?.appOwnedMappings ?? 0,
    batchCapped,
    databaseCapped: false,
    deferred: counts.deferred,
    eligible: counts.eligible,
    examined: candidates.length,
    failures: counts.failures,
    kind: "available",
    providerCapped: false,
    refused: counts.refused,
    repaired: counts.repaired,
    status: batchCapped ? "bounded" : "complete",
    unchanged: counts.unchanged,
    version: 1,
  };
}

function deadlineReached(
  dependencies: DaytonaSandboxRepairDependencies,
  reserveMs = 0
): boolean {
  return (
    dependencies.deadline !== undefined &&
    (dependencies.now ?? Date.now)() + reserveMs >= dependencies.deadline
  );
}

function providerTimeoutSeconds(
  dependencies: DaytonaSandboxRepairDependencies,
  reserveMs: number
): number | null {
  if (dependencies.deadline === undefined) {
    return RESIZE_TIMEOUT_SECONDS;
  }
  const remainingMs =
    dependencies.deadline - (dependencies.now ?? Date.now)() - reserveMs;
  if (remainingMs <= 0) {
    return null;
  }
  return Math.max(
    1,
    Math.min(RESIZE_TIMEOUT_SECONDS, Math.floor(remainingMs / 1000))
  );
}

async function verifyConfiguredSandbox(
  dependencies: DaytonaSandboxRepairDependencies,
  sandboxId: string,
  mapping: InventoryMapping
): Promise<boolean> {
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, milliseconds);
      }));
  for (let attempt = 0; attempt < RESIZE_VERIFICATION_ATTEMPTS; attempt += 1) {
    if (deadlineReached(dependencies, PROVIDER_CALL_RESERVE_MS)) {
      return false;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Verification deliberately polls one exact provider resource.
      const sandbox = await dependencies.daytona.get(sandboxId);
      if (
        sandbox.id === mapping.daytonaSandboxId &&
        sandbox.state === SandboxState.STOPPED &&
        daytonaSandboxConfigurationDrift(
          sandbox,
          mapping,
          dependencies.configuration
        ).length === 0
      ) {
        return true;
      }
    } catch {
      // A resize can complete after its provider wait times out.
    }
    if (
      attempt + 1 < RESIZE_VERIFICATION_ATTEMPTS &&
      !deadlineReached(dependencies, PROVIDER_CALL_RESERVE_MS)
    ) {
      await sleep(RESIZE_VERIFICATION_INTERVAL_MS);
    }
  }
  return false;
}

function resizeFenceInput(mapping: InventoryMapping) {
  return {
    agentId: mapping.id,
    expectedGeneration: mapping.sandboxGeneration,
    expectedVersion: mapping.version,
    sandboxId: mapping.daytonaSandboxId as string,
    tenant: mapping.tenant,
  };
}

async function deferResizeFence(
  dependencies: DaytonaSandboxRepairDependencies,
  mapping: InventoryMapping
): Promise<void> {
  try {
    await dependencies.store.deferDaytonaSandboxResize(
      dependencies.operator,
      resizeFenceInput(mapping)
    );
  } catch {
    // Retaining the existing resizing fence remains fail-closed.
  }
}

async function finishResizeFence(
  dependencies: DaytonaSandboxRepairDependencies,
  mapping: InventoryMapping
): Promise<boolean> {
  try {
    const result = await dependencies.store.finishDaytonaSandboxResize(
      dependencies.operator,
      resizeFenceInput(mapping)
    );
    return result.kind === "updated";
  } catch {
    return false;
  }
}

async function repairOneSandbox(
  dependencies: DaytonaSandboxRepairDependencies,
  mapping: InventoryMapping
): Promise<RepairObservation> {
  if (deadlineReached(dependencies, RESIZE_COMPLETION_RESERVE_MS)) {
    if (mapping.sandboxLifecycle === "resizing") {
      await deferResizeFence(dependencies, mapping);
    }
    return { eligible: false, outcome: "deferred" };
  }

  let fenced = mapping;
  const recovering = mapping.sandboxLifecycle === "resizing";
  if (!recovering) {
    try {
      const result = await dependencies.store.beginDaytonaSandboxResize(
        dependencies.operator,
        resizeFenceInput(mapping)
      );
      if (result.kind !== "resizing") {
        return { eligible: false, outcome: "deferred" };
      }
      fenced = result.value;
    } catch {
      return { eligible: false, outcome: "failure" };
    }
  }

  let sandbox: DaytonaSandboxRepairItem;
  try {
    sandbox = await dependencies.daytona.get(fenced.daytonaSandboxId as string);
  } catch {
    if (!recovering && (await finishResizeFence(dependencies, fenced))) {
      return { eligible: false, outcome: "failure" };
    }
    if (recovering) {
      await deferResizeFence(dependencies, fenced);
    }
    return { eligible: false, outcome: "deferred" };
  }
  if (sandbox.id !== fenced.daytonaSandboxId) {
    if (recovering) {
      await deferResizeFence(dependencies, fenced);
      return { eligible: false, outcome: "deferred" };
    }
    return {
      eligible: false,
      outcome: (await finishResizeFence(dependencies, fenced))
        ? "refused"
        : "deferred",
    };
  }

  let settledPriorResize = false;
  if (sandbox.state === SandboxState.RESIZING) {
    const timeout = providerTimeoutSeconds(
      dependencies,
      RESIZE_COMPLETION_RESERVE_MS
    );
    if (timeout === null) {
      await deferResizeFence(dependencies, fenced);
      return { eligible: false, outcome: "deferred" };
    }
    try {
      await sandbox.waitForResizeComplete(timeout);
      sandbox = await dependencies.daytona.get(sandbox.id);
      settledPriorResize = true;
    } catch {
      await deferResizeFence(dependencies, fenced);
      return { eligible: false, outcome: "deferred" };
    }
  }

  const drift = daytonaSandboxConfigurationDrift(
    sandbox,
    fenced,
    dependencies.configuration
  );
  if (drift.length === 0) {
    if (sandbox.state !== SandboxState.STOPPED) {
      await deferResizeFence(dependencies, fenced);
      return { eligible: false, outcome: "deferred" };
    }
    return {
      eligible: false,
      outcome: (await finishResizeFence(dependencies, fenced))
        ? "unchanged"
        : "deferred",
    };
  }
  if (!repairableResourceDrift(sandbox, fenced, dependencies.configuration)) {
    if (recovering && sandbox.state !== SandboxState.STOPPED) {
      await deferResizeFence(dependencies, fenced);
      return { eligible: false, outcome: "deferred" };
    }
    return {
      eligible: false,
      outcome: (await finishResizeFence(dependencies, fenced))
        ? "refused"
        : "deferred",
    };
  }
  if (settledPriorResize) {
    await deferResizeFence(dependencies, fenced);
    return { eligible: false, outcome: "deferred" };
  }

  if (deadlineReached(dependencies, RESIZE_COMPLETION_RESERVE_MS)) {
    if (recovering) {
      await deferResizeFence(dependencies, fenced);
    } else {
      await finishResizeFence(dependencies, fenced);
    }
    return { eligible: false, outcome: "deferred" };
  }
  try {
    await sandbox.resize(
      dependencies.configuration.resources,
      RESIZE_REQUEST_TIMEOUT_SECONDS
    );
  } catch {
    // Provider timeouts can occur after accepting the resize.
  }
  const verified = await verifyConfiguredSandbox(
    dependencies,
    sandbox.id,
    fenced
  );
  if (!verified) {
    await deferResizeFence(dependencies, fenced);
    return { eligible: true, outcome: "deferred" };
  }
  if (!(await finishResizeFence(dependencies, fenced))) {
    return { eligible: true, outcome: "deferred" };
  }
  return {
    eligible: true,
    outcome: verified ? "repaired" : "deferred",
  };
}

function candidateKey(mapping: InventoryMapping): string {
  return `${mapping.tenant}\0${mapping.id}`;
}

/**
 * Bounded, idempotent repair for exact stored mappings. This only raises the
 * configured CPU, memory, and disk floors on stopped sandboxes; it never
 * deletes resources or derives authority from provider labels and names.
 */
export async function repairDaytonaSandboxResourceFloors(
  dependencies: DaytonaSandboxRepairDependencies
): Promise<RunnerResourceRepairResult> {
  let initialCandidates: RepairCandidate[];
  try {
    initialCandidates =
      await dependencies.store.scanDaytonaSandboxRepairCandidates(
        dependencies.operator,
        REPAIR_CANDIDATE_LIMIT
      );
  } catch {
    return { kind: "unavailable", source: "database", version: 1 };
  }

  let lease: Awaited<ReturnType<RunnerStore["acquireReconciliationLease"]>>;
  try {
    lease = await dependencies.store.acquireReconciliationLease(
      dependencies.operator,
      {
        ownerToken: randomBytes(32).toString("base64url"),
        ttlSeconds: REPAIR_LEASE_TTL_SECONDS,
      }
    );
  } catch {
    return { kind: "unavailable", source: "database", version: 1 };
  }
  if (lease.kind === "held") {
    const batch = initialCandidates.slice(0, REPAIR_BATCH_SIZE);
    return availableResult(
      batch,
      initialCandidates.length > REPAIR_BATCH_SIZE,
      {
        deferred: batch.length,
        eligible: 0,
        failures: 0,
        refused: 0,
        repaired: 0,
        unchanged: 0,
      }
    );
  }

  try {
    let currentCandidates: RepairCandidate[];
    try {
      currentCandidates =
        await dependencies.store.scanDaytonaSandboxRepairCandidates(
          dependencies.operator,
          REPAIR_CANDIDATE_LIMIT
        );
    } catch {
      return { kind: "unavailable", source: "database", version: 1 };
    }

    const batchCapped = currentCandidates.length > REPAIR_BATCH_SIZE;
    const batch = currentCandidates.slice(0, REPAIR_BATCH_SIZE);
    const initialByKey = new Map(
      initialCandidates.map((candidate) => [
        candidateKey(candidate.mapping),
        candidate,
      ])
    );
    const observations = await Promise.all(
      batch.map((candidate): RepairObservation | Promise<RepairObservation> => {
        const initial = initialByKey.get(candidateKey(candidate.mapping));
        if (!initial) {
          return { eligible: false, outcome: "refused" };
        }
        if (
          initial.providerMappingCount !== 1 ||
          candidate.providerMappingCount !== 1 ||
          !sameMapping(initial.mapping, candidate.mapping) ||
          (candidate.mapping.sandboxLifecycle !== "ready" &&
            candidate.mapping.sandboxLifecycle !== "resizing") ||
          candidate.mapping.status !== "idle" ||
          candidate.mapping.warmStatus === "provisioning"
        ) {
          return { eligible: false, outcome: "refused" };
        }
        return repairOneSandbox(dependencies, candidate.mapping);
      })
    );

    return availableResult(batch, batchCapped, {
      deferred: observations.filter(
        (observation) => observation.outcome === "deferred"
      ).length,
      eligible: observations.filter((observation) => observation.eligible)
        .length,
      failures: observations.filter(
        (observation) => observation.outcome === "failure"
      ).length,
      refused: observations.filter(
        (observation) => observation.outcome === "refused"
      ).length,
      repaired: observations.filter(
        (observation) => observation.outcome === "repaired"
      ).length,
      unchanged: observations.filter(
        (observation) => observation.outcome === "unchanged"
      ).length,
    });
  } finally {
    try {
      await dependencies.store.releaseReconciliationLease(
        dependencies.operator,
        lease.lease
      );
    } catch {
      // The fenced lease expires without clearing a newer owner.
    }
  }
}
