import assert from "node:assert/strict";
import test from "node:test";
import { daytonaSandboxLabels } from "./daytona/names";
import type { DaytonaSandboxInventoryItem } from "./daytona/resource-inventory";
import { daytonaPersistentResourceLifecycle } from "./daytona/resource-lifecycle";
import { hermeticSandboxId } from "./hermetic/executor";
import { hermeticPersistentResourceLifecycle } from "./hermetic/resource-lifecycle";
import type {
  RunnerPersistentResourceLifecycle,
  RunnerResourceRecoveryResult,
} from "./resource-lifecycle";
import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerPrincipal,
  RunnerRunRecord,
} from "./types";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "tenant_a",
  userId: "00000000-0000-4000-8000-000000000001",
};
const operator = { kind: "runner-operator" } as const;
const agentId = "00000000-0000-4000-8000-000000000002";
const runId = "00000000-0000-4000-8000-000000000003";
const attemptId = "00000000-0000-4000-8000-000000000004" as NonNullable<
  RunnerDispatchAuthority["attemptId"]
>;
const recovery: RunnerResourceRecoveryResult = {
  deferred: 0,
  failures: 0,
  recovered: 0,
};

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    daytonaSandboxId: null,
    description: "",
    familiarId: "auto",
    id: agentId,
    instructions: "instructions",
    lastRunAt: null,
    model: "auto",
    name: "Lifecycle agent",
    runtime: "copilot",
    sandboxGeneration: 0,
    sandboxLifecycle: "unprovisioned",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    status: "idle",
    tenant: principal.tenant,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    version: 0,
    warmAttemptVersion: 0,
    warmStatus: "not_started",
    warmUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    workspace: null,
    ...overrides,
  };
}

function run(): RunnerRunRecord {
  return {
    agentId,
    agentInstructions: "instructions",
    agentModel: "auto",
    agentRuntime: "copilot",
    agentWorkspace: null,
    authVersion: 1,
    cancellationRequestedAt: new Date("2026-09-01T00:00:00.000Z"),
    commandEvidence: [],
    completedAt: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    daytonaAttemptId: attemptId,
    daytonaCommandId: null,
    daytonaLogCursor: 0,
    daytonaSessionId: null,
    dispatchLeaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
    dispatchLeaseToken: "lifecycle-lease",
    dispatchState: "dispatching",
    error: null,
    executionPermission: "unrestricted",
    executionProvenance: null,
    fileEvidence: [],
    githubBrokerPolicy: null,
    id: runId,
    logCursor: 0,
    operationId: "00000000-0000-4000-8000-000000000005",
    output: "",
    queueSequence: 1,
    requestHash: "a".repeat(64),
    startedAt: null,
    status: "queued",
    task: "task",
    teamStepId: null,
    tenant: principal.tenant,
    version: 1,
  };
}

function resourceLifecycleContract(
  name: string,
  create: () => RunnerPersistentResourceLifecycle
): void {
  test(`${name} satisfies the persistent resource lifecycle contract`, async () => {
    const lifecycle = create();
    const warmed = await lifecycle.prewarm(principal, agent(), {
      deadline: Date.now() + 10_000,
    });
    assert.ok(
      warmed.kind === "ready" || warmed.kind === "in_progress",
      "prewarm must expose a durable ready or in-progress outcome"
    );

    const deleted = await lifecycle.decommission(principal, agentId);
    assert.equal(deleted.kind, "deleted");

    const inventory = await lifecycle.inventory();
    assert.equal(inventory.kind, "available");
    if (inventory.kind === "available") {
      assert.equal(inventory.version, 1);
      assert.equal(inventory.examined, 0);
    }

    const repair = await lifecycle.repair();
    assert.equal(repair.kind, "available");
    if (repair.kind === "available") {
      assert.equal(repair.version, 1);
      assert.equal(repair.examined, 0);
    }

    assert.deepEqual(
      await lifecycle.recover(() => new Date("2026-09-01T00:05:00.000Z")),
      recovery
    );

    const reset = await lifecycle.reset(run(), {
      attemptId,
      expectedVersion: 2,
      leaseToken: "lifecycle-lease",
      runId,
    } as RunnerDispatchAuthority);
    assert.ok(
      reset.kind === "reset" || reset.kind === "provider_not_found",
      "reset must confirm deletion or confirmed resource absence"
    );
  });
}

resourceLifecycleContract("Daytona-shaped fake", () => {
  const ready = agent({
    daytonaSandboxId: "daytona-sandbox",
    sandboxGeneration: 1,
    sandboxLifecycle: "ready",
    version: 2,
  });
  const warming = agent({ ...ready, version: 3, warmStatus: "provisioning" });
  const warmed = agent({ ...warming, version: 4, warmStatus: "ready" });
  const decommissioning = agent({
    ...warmed,
    sandboxLifecycle: "decommissioning",
    version: 5,
  });
  const resetting = agent({
    ...decommissioning,
    sandboxLifecycle: "resetting",
    version: 6,
  });
  const sandbox = {
    delete: () => Promise.resolve(),
    id: "daytona-sandbox",
    labels: {
      ...daytonaSandboxLabels(principal.tenant, agentId),
      configurationId: "test-configuration",
      sandboxGeneration: "1",
    },
    state: "started",
  };

  return daytonaPersistentResourceLifecycle({
    configuration: () => ({
      autoArchiveInterval: 10_080,
      autoDeleteInterval: -1,
      autoStopInterval: 15,
      configurationId: "test-configuration",
      resources: { cpu: 2, disk: 20, memory: 4 },
      snapshotName: "coven-agents-copilot-1",
      target: "us",
      ttlMinutes: 0,
    }),
    daytona: () => ({
      create: () => Promise.resolve(sandbox as never),
      get: () => Promise.resolve(sandbox as never),
    }),
    inventoryDaytona: () => ({
      get: () =>
        Promise.reject(new Error("Inventory fixture must not hydrate.")),
      async *list() {
        await Promise.resolve();
        const sandboxes: DaytonaSandboxInventoryItem[] = [];
        for (const inventorySandbox of sandboxes) {
          yield inventorySandbox;
        }
      },
    }),
    operator,
    probe: () => Promise.resolve(),
    repairDaytona: () => ({
      get: () => Promise.reject(new Error("Repair fixture must not hydrate.")),
      async *list() {
        await Promise.resolve();
        const sandboxes: DaytonaSandboxInventoryItem[] = [];
        for (const inventorySandbox of sandboxes) {
          yield inventorySandbox as never;
        }
      },
    }),
    store: {
      acquireReconciliationLease: async () => ({
        kind: "acquired",
        lease: {
          expiresAt: new Date("2026-09-01T00:05:00.000Z"),
          fence: 1,
          ownerToken: "resource-lifecycle-test",
        },
      }),
      attachDaytonaSandbox: async () => ({ kind: "updated", value: ready }),
      beginDaytonaSandboxDecommission: async () => ({
        kind: "decommissioning",
        value: decommissioning,
      }),
      beginDaytonaSandboxResetForCancellation: async () => ({
        kind: "resetting",
        value: resetting,
      }),
      beginDaytonaSandboxWarm: async () => ({
        kind: "started",
        value: warming,
      }),
      deleteDecommissionedAgent: async () => ({ kind: "deleted" }),
      finishDaytonaSandboxResetForRecovery: async () => ({
        kind: "updated",
        value: agent({
          ...resetting,
          daytonaSandboxId: null,
          sandboxLifecycle: "unprovisioned",
          version: 7,
        }),
      }),
      finishDaytonaSandboxWarm: async () => ({
        kind: "updated",
        value: warmed,
      }),
      releaseReconciliationLease: async () => ({ kind: "released" }),
      reserveDaytonaSandbox: async () => ({
        kind: "reserved",
        value: agent({
          sandboxGeneration: 1,
          sandboxLifecycle: "provisioning",
          version: 1,
        }),
      }),
      scanDaytonaSandboxInventory: async () => [],
      scanDaytonaSandboxRecoveries: async () => [],
      scanDaytonaSandboxRepairCandidates: async () => [],
      scanDaytonaWarmRecoveries: async () => [],
    } as never,
  });
});

resourceLifecycleContract("hermetic implementation", () => {
  const reserved = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  const attached = agent({
    daytonaSandboxId: hermeticSandboxId(principal.tenant, agentId),
    sandboxGeneration: 1,
    sandboxLifecycle: "ready",
    version: 2,
  });
  const warming = agent({
    ...attached,
    version: 3,
    warmStatus: "provisioning",
  });
  const warmed = agent({ ...warming, version: 4, warmStatus: "ready" });
  const decommissioning = agent({
    ...warmed,
    sandboxLifecycle: "decommissioning",
    version: 5,
  });

  return hermeticPersistentResourceLifecycle({
    attachDaytonaSandbox: async () => ({ kind: "updated", value: attached }),
    beginDaytonaSandboxDecommission: async () => ({
      kind: "decommissioning",
      value: decommissioning,
    }),
    beginDaytonaSandboxWarm: async () => ({
      kind: "started",
      value: warming,
    }),
    deleteDecommissionedAgent: async () => ({ kind: "deleted" }),
    finishDaytonaSandboxWarm: async () => ({
      kind: "updated",
      value: warmed,
    }),
    reserveDaytonaSandbox: async () => ({ kind: "reserved", value: reserved }),
  } as never);
});
