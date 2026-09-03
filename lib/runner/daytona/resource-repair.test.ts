import assert from "node:assert/strict";
import test from "node:test";
import { DaytonaNotFoundError, SandboxState } from "@daytona/sdk";
import type { RunnerAgentRecord } from "../types";
import { daytonaSandboxLabels, daytonaSandboxName } from "./names";
import {
  type DaytonaSandboxRepairDependencies,
  type DaytonaSandboxRepairItem,
  repairDaytonaSandboxResourceFloors,
} from "./resource-repair";
import {
  DAYTONA_CODE_TOOLBOX_LANGUAGE_LABEL,
  DAYTONA_SANDBOX_LANGUAGE,
  type DaytonaSandboxConfiguration,
} from "./sandbox";

const operator = { kind: "runner-operator" } as const;
const configuration: DaytonaSandboxConfiguration = {
  autoArchiveInterval: 10_080,
  autoDeleteInterval: -1,
  autoStopInterval: 15,
  resources: { cpu: 2, disk: 10, memory: 4 },
  snapshotName: "coven-agents-copilot-1",
  target: "us",
  ttlMinutes: 0,
};

function mapping(
  id: string,
  sandboxId: string,
  overrides: Partial<RunnerAgentRecord> = {}
): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    daytonaSandboxId: sandboxId,
    description: "",
    id,
    instructions: "instructions",
    lastRunAt: null,
    model: "auto",
    name: "Repair fixture",
    runtime: "copilot",
    sandboxGeneration: 1,
    sandboxLifecycle: "ready",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    status: "idle",
    tenant: "tenant_a",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    version: 1,
    warmAttemptVersion: 1,
    warmStatus: "ready",
    warmUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    workspace: null,
    ...overrides,
  };
}

function repairItem(
  agent: RunnerAgentRecord,
  overrides: Partial<DaytonaSandboxRepairItem> = {}
): DaytonaSandboxRepairItem {
  return {
    autoArchiveInterval: configuration.autoArchiveInterval,
    autoDeleteInterval: configuration.autoDeleteInterval,
    autoPauseInterval: 0,
    autoStopInterval: configuration.autoStopInterval,
    cpu: configuration.resources.cpu,
    disk: configuration.resources.disk,
    id: agent.daytonaSandboxId ?? "missing",
    labels: {
      ...daytonaSandboxLabels(agent.tenant, agent.id),
      [DAYTONA_CODE_TOOLBOX_LANGUAGE_LABEL]: DAYTONA_SANDBOX_LANGUAGE,
    },
    memory: configuration.resources.memory,
    name: daytonaSandboxName(agent.tenant, agent.id),
    public: false,
    resize: () => Promise.resolve(),
    snapshot: configuration.snapshotName,
    state: SandboxState.STOPPED,
    target: configuration.target,
    waitForResizeComplete: () => Promise.resolve(),
    ...overrides,
  };
}

function repairStore(
  scanDaytonaSandboxInventory: () => Promise<RunnerAgentRecord[]>,
  leaseHeld = false
): DaytonaSandboxRepairDependencies["store"] {
  let latest: RunnerAgentRecord[] = [];
  return {
    acquireReconciliationLease: () =>
      leaseHeld
        ? Promise.resolve({ kind: "held" })
        : Promise.resolve({
            kind: "acquired",
            lease: {
              expiresAt: new Date("2026-09-01T00:05:00.000Z"),
              fence: 1,
              ownerToken: "repair-test-owner",
            },
          }),
    beginDaytonaSandboxResize: (_operator, input) => {
      const current = latest.find(
        (agent) => agent.id === input.agentId && agent.tenant === input.tenant
      );
      if (
        !current ||
        current.version !== input.expectedVersion ||
        current.sandboxGeneration !== input.expectedGeneration ||
        current.daytonaSandboxId !== input.sandboxId ||
        current.sandboxLifecycle !== "ready"
      ) {
        return Promise.resolve({ kind: "stale_version" });
      }
      return Promise.resolve({
        kind: "resizing",
        value: {
          ...current,
          sandboxLifecycle: "resizing",
          version: current.version + 1,
        },
      });
    },
    deferDaytonaSandboxResize: (_operator, input) => {
      const current = latest.find((agent) => agent.id === input.agentId);
      assert.ok(current);
      return Promise.resolve({
        kind: "updated",
        value: {
          ...current,
          sandboxLifecycle: "resizing",
          version: input.expectedVersion + 1,
        },
      });
    },
    finishDaytonaSandboxResize: (_operator, input) => {
      const current = latest.find((agent) => agent.id === input.agentId);
      assert.ok(current);
      return Promise.resolve({
        kind: "updated",
        value: {
          ...current,
          sandboxLifecycle: "ready",
          version: input.expectedVersion + 1,
        },
      });
    },
    releaseReconciliationLease: () => Promise.resolve({ kind: "released" }),
    scanDaytonaSandboxRepairCandidates: async (_operator, limit) => {
      latest = await scanDaytonaSandboxInventory();
      const appOwnedMappings = latest.filter(
        (agent) => agent.daytonaSandboxId !== null
      ).length;
      const providerCounts = new Map<string, number>();
      for (const agent of latest) {
        if (agent.daytonaSandboxId) {
          providerCounts.set(
            agent.daytonaSandboxId,
            (providerCounts.get(agent.daytonaSandboxId) ?? 0) + 1
          );
        }
      }
      return latest
        .filter(
          (agent) =>
            agent.daytonaSandboxId !== null &&
            (agent.sandboxLifecycle === "ready" ||
              agent.sandboxLifecycle === "resizing")
        )
        .sort(
          (left, right) =>
            Number(right.sandboxLifecycle === "resizing") -
            Number(left.sandboxLifecycle === "resizing")
        )
        .slice(0, limit)
        .map((candidateMapping) => ({
          appOwnedMappings,
          mapping: candidateMapping,
          providerMappingCount:
            providerCounts.get(candidateMapping.daytonaSandboxId as string) ??
            0,
        }));
    },
  };
}

test("resource repair increases only exact stopped below-policy mappings and verifies policy", async () => {
  const repairAgent = mapping(
    "00000000-0000-4000-8000-000000000001",
    "sandbox-repair"
  );
  const unchangedAgent = mapping(
    "00000000-0000-4000-8000-000000000002",
    "sandbox-unchanged"
  );
  const items = new Map<string, DaytonaSandboxRepairItem>();
  const resizeCalls: unknown[] = [];
  const below = repairItem(repairAgent, {
    cpu: 1,
    disk: 10,
    memory: 2,
    resize: (resources, timeout) => {
      resizeCalls.push({ resources, timeout });
      items.set(
        repairAgent.daytonaSandboxId as string,
        repairItem(repairAgent)
      );
      return Promise.resolve();
    },
  });
  items.set(below.id, below);
  const unchanged = repairItem(unchangedAgent);
  items.set(unchanged.id, unchanged);
  const mappings = [repairAgent, unchangedAgent];

  const result = await repairDaytonaSandboxResourceFloors({
    configuration,
    daytona: {
      get: (sandboxId) => {
        const item = items.get(sandboxId);
        assert.ok(item);
        return Promise.resolve(item);
      },
    },
    operator,
    store: repairStore(() => Promise.resolve(mappings)),
  });

  assert.deepEqual(result, {
    appOwnedMappings: 2,
    batchCapped: false,
    databaseCapped: false,
    deferred: 0,
    eligible: 1,
    examined: 2,
    failures: 0,
    kind: "available",
    providerCapped: false,
    refused: 0,
    repaired: 1,
    status: "complete",
    unchanged: 1,
    version: 1,
  });
  assert.deepEqual(resizeCalls, [
    {
      resources: configuration.resources,
      timeout: 15,
    },
  ]);
});

test("resource repair refuses running, above-policy, non-resource drift, and unstable mappings", async () => {
  const runningAgent = mapping(
    "00000000-0000-4000-8000-000000000011",
    "sandbox-running",
    { status: "running" }
  );
  const aboveAgent = mapping(
    "00000000-0000-4000-8000-000000000012",
    "sandbox-above"
  );
  const otherDriftAgent = mapping(
    "00000000-0000-4000-8000-000000000013",
    "sandbox-other"
  );
  const unstableAgent = mapping(
    "00000000-0000-4000-8000-000000000014",
    "sandbox-unstable"
  );
  const items = [
    repairItem(runningAgent, {
      cpu: 1,
    }),
    repairItem(aboveAgent, { cpu: 4 }),
    repairItem(otherDriftAgent, {
      cpu: 1,
      snapshot: "unexpected-snapshot",
    }),
    repairItem(unstableAgent, { cpu: 1 }),
  ];
  let scans = 0;

  const result = await repairDaytonaSandboxResourceFloors({
    configuration,
    daytona: {
      get: (sandboxId) => {
        const item = items.find((candidate) => candidate.id === sandboxId);
        assert.ok(item);
        return Promise.resolve(item);
      },
    },
    operator,
    store: repairStore(() => {
      scans += 1;
      return Promise.resolve(
        scans === 1
          ? [runningAgent, aboveAgent, otherDriftAgent, unstableAgent]
          : [
              runningAgent,
              aboveAgent,
              otherDriftAgent,
              {
                ...unstableAgent,
                sandboxLifecycle: "decommissioning",
              } as RunnerAgentRecord,
            ]
      );
    }),
  });

  assert.equal(result.kind, "available");
  if (result.kind === "available") {
    assert.equal(result.eligible, 0);
    assert.equal(result.repaired, 0);
    assert.equal(result.refused, 3);
  }
});

test("resource repair returns a stable four-item batch when more mappings remain", async () => {
  const mappings = Array.from({ length: 5 }, (_, index) =>
    mapping(
      `00000000-0000-4000-8000-${String(index + 21).padStart(12, "0")}`,
      `sandbox-batch-${index}`
    )
  );

  const result = await repairDaytonaSandboxResourceFloors({
    configuration,
    daytona: {
      get: () => Promise.reject(new Error("must not hydrate")),
    },
    operator,
    store: repairStore(() => Promise.resolve(mappings), true),
  });

  assert.deepEqual(result, {
    appOwnedMappings: 5,
    batchCapped: true,
    databaseCapped: false,
    deferred: 4,
    eligible: 0,
    examined: 4,
    failures: 0,
    kind: "available",
    providerCapped: false,
    refused: 0,
    repaired: 0,
    status: "bounded",
    unchanged: 0,
    version: 1,
  });
});

test("resource repair re-verifies an accepted resize after the provider wait rejects", async () => {
  const repairAgent = mapping(
    "00000000-0000-4000-8000-000000000041",
    "sandbox-timeout"
  );
  const items = new Map<string, DaytonaSandboxRepairItem>();
  const below = repairItem(repairAgent, {
    cpu: 1,
    resize: () => {
      items.set(below.id, repairItem(repairAgent));
      return Promise.reject(new Error("provider wait timed out"));
    },
  });
  items.set(below.id, below);

  const result = await repairDaytonaSandboxResourceFloors({
    configuration,
    daytona: {
      get: (sandboxId) => {
        const item = items.get(sandboxId);
        assert.ok(item);
        return Promise.resolve(item);
      },
    },
    operator,
    store: repairStore(() => Promise.resolve([repairAgent])),
  });

  assert.equal(result.kind, "available");
  if (result.kind === "available") {
    assert.equal(result.eligible, 1);
    assert.equal(result.failures, 0);
    assert.equal(result.repaired, 1);
  }
});

test("resource repair releases its durable fence after a definite resize rejection", async () => {
  const repairAgent = mapping(
    "00000000-0000-4000-8000-000000000045",
    "sandbox-resize-rejected",
    { sandboxLifecycle: "resizing", version: 2 }
  );
  const below = repairItem(repairAgent, {
    cpu: 1,
    resize: () =>
      Promise.reject(
        new DaytonaNotFoundError("resize endpoint unavailable", 404)
      ),
  });
  const baseStore = repairStore(() => Promise.resolve([repairAgent]));
  let deferredFences = 0;
  let finishedFences = 0;
  let providerGets = 0;

  const result = await repairDaytonaSandboxResourceFloors({
    configuration,
    daytona: {
      get: () => {
        providerGets += 1;
        return Promise.resolve(below);
      },
    },
    operator,
    store: {
      ...baseStore,
      deferDaytonaSandboxResize: (...args) => {
        deferredFences += 1;
        return baseStore.deferDaytonaSandboxResize(...args);
      },
      finishDaytonaSandboxResize: (...args) => {
        finishedFences += 1;
        return baseStore.finishDaytonaSandboxResize(...args);
      },
    },
  });

  assert.equal(result.kind, "available");
  if (result.kind === "available") {
    assert.equal(result.deferred, 0);
    assert.equal(result.eligible, 1);
    assert.equal(result.failures, 1);
    assert.equal(result.repaired, 0);
  }
  assert.equal(providerGets, 1);
  assert.equal(deferredFences, 0);
  assert.equal(finishedFences, 1);
});

test("resource repair resumes a durable resizing fence after a crashed operator", async () => {
  const repairAgent = mapping(
    "00000000-0000-4000-8000-000000000051",
    "sandbox-recover-resize",
    { sandboxLifecycle: "resizing", version: 2 }
  );
  const items = new Map<string, DaytonaSandboxRepairItem>();
  const below = repairItem(repairAgent, {
    cpu: 1,
    resize: () => {
      items.set(below.id, repairItem(repairAgent));
      return Promise.resolve();
    },
  });
  items.set(below.id, below);

  const result = await repairDaytonaSandboxResourceFloors({
    configuration,
    daytona: {
      get: (sandboxId) => {
        const item = items.get(sandboxId);
        assert.ok(item);
        return Promise.resolve(item);
      },
    },
    operator,
    store: repairStore(() => Promise.resolve([repairAgent])),
  });

  assert.equal(result.kind, "available");
  if (result.kind === "available") {
    assert.equal(result.deferred, 0);
    assert.equal(result.eligible, 1);
    assert.equal(result.repaired, 1);
  }
});

test("resource repair retains its durable fence while provider resize completion is ambiguous", async () => {
  const repairAgent = mapping(
    "00000000-0000-4000-8000-000000000061",
    "sandbox-ambiguous-resize"
  );
  const items = new Map<string, DaytonaSandboxRepairItem>();
  const below = repairItem(repairAgent, {
    cpu: 1,
    resize: () => {
      items.set(
        below.id,
        repairItem(repairAgent, { state: SandboxState.RESIZING })
      );
      return Promise.reject(new Error("provider wait timed out"));
    },
  });
  items.set(below.id, below);
  const baseStore = repairStore(() => Promise.resolve([repairAgent]));
  let deferredFences = 0;
  let finishedFences = 0;

  const result = await repairDaytonaSandboxResourceFloors({
    configuration,
    daytona: {
      get: (sandboxId) => {
        const item = items.get(sandboxId);
        assert.ok(item);
        return Promise.resolve(item);
      },
    },
    operator,
    sleep: () => Promise.resolve(),
    store: {
      ...baseStore,
      deferDaytonaSandboxResize: (...args) => {
        deferredFences += 1;
        return baseStore.deferDaytonaSandboxResize(...args);
      },
      finishDaytonaSandboxResize: (...args) => {
        finishedFences += 1;
        return baseStore.finishDaytonaSandboxResize(...args);
      },
    },
  });

  assert.equal(result.kind, "available");
  if (result.kind === "available") {
    assert.equal(result.deferred, 1);
    assert.equal(result.repaired, 0);
  }
  assert.equal(deferredFences, 1);
  assert.equal(finishedFences, 0);
});
