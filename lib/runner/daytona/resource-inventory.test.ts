import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SandboxState } from "@daytona/sdk";
import type { RunnerStore } from "../store";
import type { RunnerAgentRecord, RunnerOperator } from "../types";
import { daytonaSandboxLabels, daytonaSandboxName } from "./names";
import {
  type DaytonaSandboxInventoryItem,
  type DaytonaSandboxInventoryService,
  inventoryDaytonaSandboxes,
} from "./resource-inventory";
import {
  DAYTONA_CODE_TOOLBOX_LANGUAGE_LABEL,
  DAYTONA_SANDBOX_LANGUAGE,
  type DaytonaSandboxConfiguration,
} from "./sandbox";

const operator: RunnerOperator = { kind: "runner-operator" };
const configuration: DaytonaSandboxConfiguration = {
  autoArchiveInterval: 10_080,
  autoDeleteInterval: -1,
  autoStopInterval: 15,
  resources: { cpu: 2, disk: 20, memory: 4 },
  snapshotName: "coven-agents-copilot-1",
  target: "us",
  ttlMinutes: 0,
};

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    daytonaSandboxId: "sandbox-a",
    description: "",
    id: "00000000-0000-4000-8000-000000000001",
    instructions: "instructions",
    lastRunAt: null,
    model: "auto",
    name: "Inventory agent",
    runtime: "copilot",
    sandboxGeneration: 1,
    sandboxLifecycle: "ready",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    status: "idle",
    tenant: "tenant-a",
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    version: 1,
    warmAttemptVersion: 0,
    warmStatus: "ready",
    warmUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    workspace: null,
    ...overrides,
  };
}

function sandbox(
  owner: RunnerAgentRecord,
  overrides: Partial<DaytonaSandboxInventoryItem> = {}
): DaytonaSandboxInventoryItem {
  return {
    autoArchiveInterval: configuration.autoArchiveInterval,
    autoDeleteInterval: configuration.autoDeleteInterval,
    autoPauseInterval: 0,
    autoStopInterval: configuration.autoStopInterval,
    cpu: configuration.resources.cpu,
    disk: configuration.resources.disk,
    id: owner.daytonaSandboxId ?? "unmapped-sandbox",
    labels: {
      ...daytonaSandboxLabels(owner.tenant, owner.id),
      [DAYTONA_CODE_TOOLBOX_LANGUAGE_LABEL]: DAYTONA_SANDBOX_LANGUAGE,
    },
    memory: configuration.resources.memory,
    name: daytonaSandboxName(owner.tenant, owner.id),
    public: false,
    snapshot: configuration.snapshotName,
    state: SandboxState.STARTED,
    target: configuration.target,
    ...overrides,
  };
}

function inventoryService(
  sandboxes: readonly DaytonaSandboxInventoryItem[],
  onQuery?: (
    query: Parameters<DaytonaSandboxInventoryService["list"]>[0]
  ) => void
): DaytonaSandboxInventoryService {
  return {
    get: (sandboxId) => {
      const resolvedSandbox = sandboxes.find((item) => item.id === sandboxId);
      return resolvedSandbox
        ? Promise.resolve(resolvedSandbox)
        : Promise.reject(new Error("Provider sandbox was not found."));
    },
    list: (query) => {
      onQuery?.(query);
      return (async function* () {
        await Promise.resolve();
        for (const item of sandboxes) {
          yield item;
        }
      })();
    },
  };
}

function inventoryStore(
  mappings: readonly RunnerAgentRecord[]
): Pick<RunnerStore, "scanDaytonaSandboxInventory"> {
  return {
    scanDaytonaSandboxInventory: async () => [...mappings],
  };
}

test("inventory queries only the app label and returns privacy-safe aggregate matches", async () => {
  const matched = agent();
  const provisioning = agent({
    daytonaSandboxId: null,
    id: "00000000-0000-4000-8000-000000000002",
    sandboxLifecycle: "provisioning_ambiguous",
  });
  const providerOnly = sandbox(provisioning, {
    id: "provider-only",
    labels: { app: "coven-agents" },
    name: "not-an-app-owned-name",
    state: SandboxState.ARCHIVED,
  });
  let query: Parameters<DaytonaSandboxInventoryService["list"]>[0] | undefined;

  const result = await inventoryDaytonaSandboxes({
    configuration,
    daytona: inventoryService(
      [
        sandbox(matched),
        sandbox(provisioning, { id: "ambiguous-pending" }),
        providerOnly,
      ],
      (value) => {
        query = value;
      }
    ),
    limit: 10,
    operator,
    store: inventoryStore([matched, provisioning]),
  });

  assert.deepEqual(query, { labels: { app: "coven-agents" }, limit: 10 });
  assert.deepEqual(result, {
    ambiguous: 1,
    appOwnedMappings: 2,
    databaseCapped: false,
    examined: 3,
    kind: "available",
    matched: 1,
    providerCapped: false,
    states: { active: 2, archived: 1, other: 0, stopped: 0 },
    status: "complete",
    unowned: 1,
    version: 1,
  });
  const serialized = JSON.stringify(result);
  for (const privateValue of [
    matched.id,
    matched.tenant,
    providerOnly.id,
    providerOnly.name,
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
  const storedSandboxId = matched.daytonaSandboxId;
  if (!storedSandboxId) {
    throw new Error("Fixture must include a stored sandbox identifier.");
  }
  assert.equal(serialized.includes(storedSandboxId), false);
});

test("duplicate labels, provider mappings, and resource policy drift remain ambiguous", async () => {
  const matched = agent();
  const duplicated = sandbox(matched, {
    id: "duplicate-observation",
    name: "different-provider-name",
    state: SandboxState.STOPPED,
  });
  const drifted = sandbox(matched, {
    disk: 21,
    state: SandboxState.ARCHIVED,
  });

  const result = await inventoryDaytonaSandboxes({
    configuration,
    daytona: inventoryService([drifted, duplicated]),
    limit: 10,
    operator,
    store: inventoryStore([matched]),
  });

  assert.deepEqual(result, {
    ambiguous: 2,
    appOwnedMappings: 1,
    databaseCapped: false,
    examined: 2,
    kind: "available",
    matched: 0,
    providerCapped: false,
    states: { active: 0, archived: 1, other: 0, stopped: 1 },
    status: "complete",
    unowned: 0,
    version: 1,
  });
});

test("inventory marks capped observations bounded rather than treating them as unowned", async () => {
  const mapping = agent({
    daytonaSandboxId: null,
    id: "00000000-0000-4000-8000-000000000003",
    sandboxLifecycle: "provisioning",
  });
  const providerOnly = sandbox(mapping, {
    id: "provider-only",
    labels: { app: "coven-agents" },
    name: "not-owned",
  });

  const result = await inventoryDaytonaSandboxes({
    configuration,
    daytona: inventoryService([providerOnly, sandbox(mapping)]),
    limit: 1,
    operator,
    store: inventoryStore([mapping]),
  });

  assert.deepEqual(result, {
    ambiguous: 1,
    appOwnedMappings: 1,
    databaseCapped: true,
    examined: 1,
    kind: "available",
    matched: 0,
    providerCapped: true,
    states: { active: 1, archived: 0, other: 0, stopped: 0 },
    status: "bounded",
    unowned: 0,
    version: 1,
  });
});

test("inventory reports store and provider failures without retaining provider details", async () => {
  let providerCalls = 0;
  const databaseUnavailable = await inventoryDaytonaSandboxes({
    configuration,
    daytona: inventoryService([], () => {
      providerCalls += 1;
    }),
    operator,
    store: {
      scanDaytonaSandboxInventory: () =>
        Promise.reject(new Error("database=private-detail")),
    },
  });
  assert.deepEqual(databaseUnavailable, {
    kind: "unavailable",
    source: "database",
    version: 1,
  });
  assert.equal(providerCalls, 0);

  const providerUnavailable = await inventoryDaytonaSandboxes({
    configuration,
    daytona: {
      get: () => Promise.reject(new Error("provider=private-detail")),
      list: () => {
        throw new Error("provider=private-detail");
      },
    },
    operator,
    store: inventoryStore([]),
  });
  assert.deepEqual(providerUnavailable, {
    kind: "unavailable",
    source: "provider",
    version: 1,
  });
  assert.equal(
    JSON.stringify(providerUnavailable).includes("private-detail"),
    false
  );

  const mapped = agent();
  const hydrationUnavailable = await inventoryDaytonaSandboxes({
    configuration,
    daytona: {
      get: () => Promise.reject(new Error("provider=private-detail")),
      list: () =>
        (async function* () {
          await Promise.resolve();
          yield sandbox(mapped);
        })(),
    },
    operator,
    store: inventoryStore([mapped]),
  });
  assert.deepEqual(hydrationUnavailable, {
    kind: "unavailable",
    source: "provider",
    version: 1,
  });
  assert.equal(
    JSON.stringify(hydrationUnavailable).includes("private-detail"),
    false
  );
});

test("inventory has no provider or store mutation path", () => {
  const source = readFileSync(
    new URL("./resource-inventory.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /\.(?:create|delete|reset)\(/u);
  assert.doesNotMatch(
    source,
    /(?:attach|delete|finish|mark|reset)DaytonaSandbox/u
  );
});
