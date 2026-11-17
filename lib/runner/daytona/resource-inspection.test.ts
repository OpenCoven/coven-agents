import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DaytonaNotFoundError,
  DaytonaServiceUnavailableError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
import { sandboxInspectionResultSchema } from "@opencoven/agent-contracts";
import type { RunnerAgentRecord, RunnerPrincipal } from "../types";
import { daytonaSandboxLabels, daytonaSandboxName } from "./names";
import {
  DAYTONA_INSPECTION_ADAPTER_VERSION,
  DAYTONA_SDK_VERSION,
  type DaytonaSandboxInspectionItem,
  type DaytonaSandboxInspectionService,
  inspectDaytonaSandbox,
  type SandboxInspectionFenceRead,
} from "./resource-inspection";
import {
  DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
  type DaytonaSandboxConfiguration,
} from "./sandbox";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "tenant-a",
  userId: "user-a",
};
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const configuration: DaytonaSandboxConfiguration = {
  autoArchiveInterval: 10_080,
  autoDeleteInterval: -1,
  autoStopInterval: 15,
  configurationId: "configuration-current",
  priorConfigurationIds: ["configuration-prior"],
  resources: { cpu: 2, disk: 10, memory: 4 },
  snapshotName: "coven-agents-copilot-2",
  target: "us",
  ttlMinutes: 0,
};

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    daytonaSandboxId: "sandbox-a",
    description: "",
    familiarId: "auto",
    id: AGENT_ID,
    instructions: "instructions",
    lastRunAt: null,
    model: "auto",
    name: "Inspection agent",
    runtime: "copilot",
    sandboxGeneration: 3,
    sandboxLifecycle: "ready",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    status: "idle",
    tenant: principal.tenant,
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    version: 1,
    warmAttemptVersion: 0,
    warmStatus: "ready",
    warmUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    workspace: null,
    ...overrides,
  };
}

function providerSandbox(
  owner: RunnerAgentRecord,
  overrides: Partial<DaytonaSandboxInspectionItem> = {}
): DaytonaSandboxInspectionItem {
  return {
    autoArchiveInterval: configuration.autoArchiveInterval,
    autoDeleteInterval: configuration.autoDeleteInterval,
    autoStopInterval: configuration.autoStopInterval,
    cpu: 2,
    disk: 10,
    id: owner.daytonaSandboxId ?? "unmapped",
    labels: {
      ...daytonaSandboxLabels(owner.tenant, owner.id),
      configurationId: "configuration-current",
      credentialBoundaryVersion: DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
      sandboxGeneration: String(owner.sandboxGeneration),
    },
    memory: 4,
    name: daytonaSandboxName(owner.tenant, owner.id),
    networkBlockAll: false,
    public: false,
    snapshot: configuration.snapshotName,
    state: SandboxState.STARTED,
    target: "us",
    ...overrides,
  };
}

type ProviderCall = Readonly<{ args: readonly unknown[]; method: string }>;

/**
 * Stands in for the whole provider client and for every handle it returns.
 * Any property that is read as a function is recorded, so a create, start,
 * stop, delete, label, or interval call cannot happen unobserved. Only `get`
 * is answered; everything else throws after being recorded.
 */
function recordingProvider(
  answer: (sandboxId: string) => Promise<DaytonaSandboxInspectionItem>
) {
  const calls: ProviderCall[] = [];
  const recorder = (target: object): object =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (typeof property === "symbol" || property === "then") {
          return Reflect.get(inner, property, receiver);
        }
        if (Object.hasOwn(inner, property)) {
          return Reflect.get(inner, property, receiver);
        }
        return (...args: unknown[]) => {
          calls.push({ args, method: property });
          throw new Error(`Unexpected provider call: ${property}`);
        };
      },
    });
  const client = recorder({
    get: async (sandboxId: string) => {
      calls.push({ args: [sandboxId], method: "get" });
      return recorder(await answer(sandboxId));
    },
  }) as DaytonaSandboxInspectionService;
  return { calls, client };
}

function fenceStore(
  result: SandboxInspectionFenceRead | null | Error,
  seen: { agentId: string; tenant: string }[] = []
) {
  let credentialReads = 0;
  const store = new Proxy(
    {
      getAgentSandboxFence: (
        caller: RunnerPrincipal,
        agentId: string
      ): Promise<SandboxInspectionFenceRead | null> => {
        seen.push({ agentId, tenant: caller.tenant });
        return result instanceof Error
          ? Promise.reject(result)
          : Promise.resolve(result);
      },
    },
    {
      get(target, property, receiver) {
        if (typeof property === "symbol" || Object.hasOwn(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        credentialReads += 1;
        throw new Error(`Unexpected store call: ${String(property)}`);
      },
    }
  );
  return { otherStoreCalls: () => credentialReads, seen, store };
}

const expected = { expectedGeneration: 3, expectedSandboxId: "sandbox-a" };

async function inspect(
  options: Readonly<{
    answer?: (sandboxId: string) => Promise<DaytonaSandboxInspectionItem>;
    configure?: () => DaytonaSandboxConfiguration;
    expected?: typeof expected;
    read?: SandboxInspectionFenceRead | null | Error;
  }> = {}
) {
  const owner = agent();
  const provider = recordingProvider(
    options.answer ?? (() => Promise.resolve(providerSandbox(owner)))
  );
  const reads =
    options.read === undefined
      ? fenceStore({ agent: owner, fence: "none" })
      : fenceStore(options.read);
  const result = await inspectDaytonaSandbox(
    principal,
    AGENT_ID,
    options.expected ?? expected,
    {
      configuration: options.configure ?? (() => configuration),
      daytona: () => provider.client,
      store: reads.store,
    }
  );
  // Every result must satisfy the published contract exactly.
  assert.deepEqual(sandboxInspectionResultSchema.parse(result), result);
  assert.equal(reads.otherStoreCalls(), 0);
  return { calls: provider.calls, reads, result };
}

function onlyOneGet(calls: readonly ProviderCall[], sandboxId = "sandbox-a") {
  assert.deepEqual(calls, [{ args: [sandboxId], method: "get" }]);
}

test("a matching binding is observed with exactly one provider get", async () => {
  const { calls, reads, result } = await inspect();
  onlyOneGet(calls);
  assert.deepEqual(reads.seen, [{ agentId: AGENT_ID, tenant: "tenant-a" }]);
  assert.equal(result.outcome, "observed");
  assert.deepEqual(result, {
    observed: {
      autoArchiveInterval: 10_080,
      autoDeleteInterval: -1,
      autoStopInterval: 15,
      cpu: 2,
      diskGib: 10,
      domainAllowListConfigured: false,
      identity: {
        configuration: "current",
        credentialBoundary: true,
        generationLabel: true,
        ownershipLabels: true,
      },
      memoryGib: 4,
      networkBlockAll: false,
      public: false,
      snapshot: "coven-agents-copilot-2",
      state: "started",
      target: "us",
      volumes: 0,
    },
    outcome: "observed",
    policy: result.outcome === "observed" ? result.policy : null,
    record: { fence: "none", generation: 3, lifecycle: "ready" },
    version: 1,
  });
});

test("policy pins are reported as source policy, not observation", async () => {
  const { result } = await inspect();
  assert.equal(result.outcome, "observed");
  if (result.outcome !== "observed") {
    return;
  }
  assert.equal(result.policy.snapshotName, "coven-agents-copilot-2");
  assert.equal(result.policy.adapterVersion, "daytona-adapter-v1");
  assert.equal(result.policy.capabilityContractVersion, "hosted-v1");
  assert.equal(
    result.policy.credentialBoundaryVersion,
    DAYTONA_CREDENTIAL_BOUNDARY_VERSION
  );
  assert.deepEqual(result.policy.resources, {
    cpu: 2,
    diskGib: 10,
    memoryGib: 4,
  });
  const copilot = result.policy.harnesses.find((item) => item.id === "copilot");
  assert.equal(copilot?.package, "@github/copilot");
  assert.match(copilot?.version ?? "", /^\d+\.\d+\.\d+/u);
});

test("the reported SDK version is the pinned dependency", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
  ) as { dependencies: Record<string, string> };
  assert.equal(DAYTONA_SDK_VERSION, manifest.dependencies["@daytona/sdk"]);
});

test("the inspection adapter version is the dispatch adapter version", async () => {
  const executor = await import("./executor");
  assert.equal(
    DAYTONA_INSPECTION_ADAPTER_VERSION,
    executor.DAYTONA_EXECUTOR_ADAPTER_VERSION
  );
});

test("a stopped sandbox is reported stopped and is not started", async () => {
  const owner = agent();
  const { calls, result } = await inspect({
    answer: () =>
      Promise.resolve(providerSandbox(owner, { state: SandboxState.STOPPED })),
  });
  onlyOneGet(calls);
  assert.equal(result.outcome, "observed");
  assert.equal(
    result.outcome === "observed" ? result.observed.state : null,
    "stopped"
  );
});

test("drift, legacy labels, and unsafe exposure are reported, never repaired", async () => {
  const owner = agent();
  const { calls, result } = await inspect({
    answer: () =>
      Promise.resolve(
        providerSandbox(owner, {
          autoStopInterval: 0,
          domainAllowList: "example.test",
          labels: { app: "coven-agents" },
          networkBlockAll: undefined,
          public: true,
          snapshot: undefined,
          state: SandboxState.ARCHIVING,
          volumes: [{}, {}],
        })
      ),
  });
  onlyOneGet(calls);
  assert.equal(result.outcome, "observed");
  if (result.outcome !== "observed") {
    return;
  }
  assert.deepEqual(result.observed.identity, {
    configuration: "mismatch",
    credentialBoundary: false,
    generationLabel: false,
    ownershipLabels: false,
  });
  assert.equal(result.observed.public, true);
  assert.equal(result.observed.networkBlockAll, null);
  assert.equal(result.observed.domainAllowListConfigured, true);
  assert.equal(result.observed.snapshot, null);
  assert.equal(result.observed.state, "transitioning");
  assert.equal(result.observed.volumes, 2);
  assert.equal(result.observed.autoStopInterval, 0);
});

test("a prior configuration identity is recognised without relabelling", async () => {
  const owner = agent();
  const base = providerSandbox(owner);
  const { calls, result } = await inspect({
    answer: () =>
      Promise.resolve({
        ...base,
        labels: { ...base.labels, configurationId: "configuration-prior" },
      }),
  });
  onlyOneGet(calls);
  assert.equal(
    result.outcome === "observed"
      ? result.observed.identity.configuration
      : null,
    "prior"
  );
});

test("an outstanding attempt or cleanup fence is surfaced", async () => {
  for (const fence of ["attempt_outstanding", "cleanup_required"] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    const { calls, result } = await inspect({
      read: { agent: agent(), fence },
    });
    onlyOneGet(calls);
    assert.equal(result.outcome, "observed");
    assert.equal(
      result.outcome === "observed" ? result.record.fence : null,
      fence
    );
  }
});

test("a missing agent and another tenant's agent are the same refusal with no provider call", async () => {
  const { calls, result } = await inspect({ read: null });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { outcome: "unauthorized", version: 1 });
});

test("a row for a different tenant or agent is never trusted", async () => {
  for (const row of [
    agent({ tenant: "tenant-b" }),
    agent({ id: "00000000-0000-4000-8000-000000000002" }),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    const { calls, result } = await inspect({
      read: { agent: row, fence: "none" },
    });
    assert.deepEqual(calls, []);
    assert.deepEqual(result, { outcome: "unauthorized", version: 1 });
  }
});

test("a binding mismatch refuses before any provider call and does not disclose the recorded ID", async () => {
  const cases = [
    {
      expected: { expectedGeneration: 3, expectedSandboxId: "sandbox-other" },
      reason: "sandbox_id_mismatch",
      row: agent(),
    },
    {
      expected: { expectedGeneration: 2, expectedSandboxId: "sandbox-a" },
      reason: "generation_mismatch",
      row: agent(),
    },
    {
      expected,
      reason: "no_recorded_sandbox",
      row: agent({ daytonaSandboxId: null }),
    },
  ] as const;
  for (const item of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    const { calls, result } = await inspect({
      expected: item.expected,
      read: { agent: item.row, fence: "none" },
    });
    assert.deepEqual(calls, []);
    assert.equal(result.outcome, "ambiguous");
    assert.equal(
      result.outcome === "ambiguous" ? result.reason : null,
      item.reason
    );
    assert.equal(JSON.stringify(result).includes("sandbox-a"), false);
  }
});

test("a pending lifecycle is ambiguous and is not probed", async () => {
  for (const sandboxLifecycle of [
    "unprovisioned",
    "provisioning",
    "provisioning_ambiguous",
    "resizing",
    "resetting",
    "decommissioning",
    "decommission_failed",
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    const { calls, result } = await inspect({
      read: { agent: agent({ sandboxLifecycle }), fence: "none" },
    });
    assert.deepEqual(calls, []);
    assert.equal(result.outcome, "ambiguous");
    assert.equal(
      result.outcome === "ambiguous" ? result.reason : null,
      "pending_lifecycle"
    );
  }
});

test("a provider not-found is reported and never triggers create or a name lookup", async () => {
  const { calls, result } = await inspect({
    answer: () => Promise.reject(new DaytonaNotFoundError("gone", 404)),
  });
  onlyOneGet(calls);
  assert.equal(result.outcome, "not_found");
  assert.equal(JSON.stringify(result).includes("gone"), false);
});

test("a provider failure is unavailable and carries no provider detail", async () => {
  const { calls, result } = await inspect({
    answer: () =>
      Promise.reject(
        new DaytonaServiceUnavailableError(
          "https://provider.example secret-token",
          503
        )
      ),
  });
  onlyOneGet(calls);
  assert.deepEqual(result, {
    outcome: "unavailable",
    source: "provider",
    version: 1,
  });
});

test("a returned ID that differs from the recorded ID is ambiguous, not adopted", async () => {
  const owner = agent();
  const { calls, result } = await inspect({
    answer: () =>
      Promise.resolve(providerSandbox(owner, { id: "sandbox-substituted" })),
  });
  onlyOneGet(calls);
  assert.equal(result.outcome, "ambiguous");
  assert.equal(
    result.outcome === "ambiguous" ? result.reason : null,
    "returned_id_mismatch"
  );
  assert.equal(JSON.stringify(result).includes("sandbox-substituted"), false);
});

test("malformed provider metadata fails closed as unavailable", async () => {
  const owner = agent();
  const { calls, result } = await inspect({
    answer: () =>
      Promise.resolve(
        providerSandbox(owner, { cpu: Number.NaN, memory: -1 } as never)
      ),
  });
  onlyOneGet(calls);
  assert.deepEqual(result, {
    outcome: "unavailable",
    source: "provider",
    version: 1,
  });
});

test("a database failure is unavailable with no provider call", async () => {
  const { calls, result } = await inspect({ read: new Error("db down") });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, {
    outcome: "unavailable",
    source: "database",
    version: 1,
  });
});

test("missing provider configuration is unavailable with no provider call", async () => {
  const { calls, result } = await inspect({
    configure: () => {
      throw new Error("DAYTONA_SNAPSHOT is required.");
    },
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, {
    outcome: "unavailable",
    source: "provider",
    version: 1,
  });
});

test("every provider field the reader uses is declared by the pinned SDK", () => {
  // Checked by typecheck: an SDK release that renames or drops one of these
  // fails the build instead of silently reading as not reported.
  const fields = [
    "autoArchiveInterval",
    "autoDeleteInterval",
    "autoStopInterval",
    "cpu",
    "disk",
    "domainAllowList",
    "id",
    "labels",
    "memory",
    "networkBlockAll",
    "public",
    "snapshot",
    "state",
    "target",
    "volumes",
  ] as const satisfies readonly (keyof Sandbox)[];
  assert.equal(new Set(fields).size, fields.length);
});

test("the inspection module reaches no mutating provider or credential API", () => {
  const source = readFileSync(
    new URL("./resource-inspection.ts", import.meta.url),
    "utf8"
  );
  for (const forbidden of [
    ".create(",
    ".start(",
    ".stop(",
    ".delete(",
    ".archive(",
    ".resize(",
    ".list(",
    "setLabels",
    "setAutostopInterval",
    "setAutoArchiveInterval",
    "setAutoDeleteInterval",
    "executeCommand",
    "createSession",
    "acquireRunnerCredential",
    "leaseCredential",
    "daytonaSandboxName",
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});
