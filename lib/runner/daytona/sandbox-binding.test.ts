import assert from "node:assert/strict";
import test from "node:test";
import {
  DaytonaInternalServerError,
  DaytonaNotFoundError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
import type { RunSandboxBindingRefusalReason } from "@opencoven/agent-contracts";
import type { RunnerStore } from "../store";
import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerSandboxBinding,
} from "../types";
import { configuredDaytonaRunnerExecutor } from "./executor";
import { daytonaSandboxLabels } from "./names";
import {
  DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
  DaytonaSandboxBindingRefusedError,
  type DaytonaSandboxConfiguration,
  DaytonaSandboxLifecycleError,
  type DaytonaSandboxService,
  ensureDaytonaSandboxForDispatch,
} from "./sandbox";

const TENANT = "private_tenant";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const SANDBOX_ID = "sandbox-recorded-1";
const GENERATION = 3;
const binding: RunnerSandboxBinding = {
  expectedGeneration: GENERATION,
  expectedSandboxId: SANDBOX_ID,
};
const configuration: DaytonaSandboxConfiguration = {
  autoArchiveInterval: 10_080,
  autoDeleteInterval: -1,
  autoStopInterval: 15,
  configurationId: "current-configuration",
  resources: { cpu: 2, disk: 10, memory: 4 },
  snapshotName: "coven-agents-copilot-2",
  target: "us",
  ttlMinutes: 0,
};
const authority = {
  expectedVersion: 1,
  leaseToken: "dispatch-lease",
  runId: "00000000-0000-4000-8000-000000000002",
} as RunnerDispatchAuthority;

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date(),
    daytonaSandboxId: SANDBOX_ID,
    description: "",
    familiarId: "auto",
    id: AGENT_ID,
    instructions: "test",
    lastRunAt: null,
    model: "test",
    name: "test",
    runtime: "copilot",
    sandboxGeneration: GENERATION,
    sandboxLifecycle: "ready",
    sandboxTrust: "clean",
    sandboxUpdatedAt: new Date(),
    status: "idle",
    tenant: TENANT,
    updatedAt: new Date(),
    version: 4,
    warmAttemptVersion: 0,
    warmStatus: "not_started",
    warmUpdatedAt: new Date(),
    workspace: null,
    ...overrides,
  };
}

const matchingLabels = {
  ...daytonaSandboxLabels(TENANT, AGENT_ID),
  configurationId: "current-configuration",
  credentialBoundaryVersion: DAYTONA_CREDENTIAL_BOUNDARY_VERSION,
  sandboxGeneration: String(GENERATION),
};

type SandboxData = Readonly<{
  id: string;
  labels: Record<string, string>;
  public: boolean;
  state: SandboxState | undefined;
}>;

/**
 * Records every call. Any sandbox member that is not plain data is a method:
 * touching it is recorded, so a start, delete, relabel, resize, or interval
 * call cannot happen unnoticed. Unknown provider or store methods are recorded
 * and then fail, so the fake cannot silently satisfy a create path.
 */
function recording(
  options: Readonly<{
    agent?: RunnerAgentRecord;
    binding?: RunnerSandboxBinding | null;
    get?: (id: string) => Promise<SandboxData>;
  }> = {}
) {
  const calls: string[] = [];
  const data: SandboxData = {
    id: SANDBOX_ID,
    labels: matchingLabels,
    public: false,
    state: SandboxState.STARTED,
  };
  const recordedSandbox = (value: SandboxData): Sandbox =>
    new Proxy(value as object, {
      get: (target, property) => {
        if (typeof property !== "string" || property === "then") {
          return;
        }
        if (Object.hasOwn(target, property)) {
          return (target as Record<string, unknown>)[property];
        }
        return (...parameters: unknown[]) => {
          calls.push(`sandbox.${property}(${parameters.length})`);
          return Promise.resolve();
        };
      },
    }) as Sandbox;
  const daytona = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string" || property === "then") {
          return;
        }
        if (property === "snapshot") {
          return {
            get: (name: string) => {
              calls.push(`provider.snapshot.get:${name}`);
              return Promise.resolve({
                cpu: 2,
                disk: 10,
                mem: 4,
                name,
                state: "active",
              });
            },
          };
        }
        return async (...parameters: unknown[]) => {
          if (property === "get") {
            calls.push(`provider.get:${String(parameters[0])}`);
            const resolved = await (
              options.get ?? (() => Promise.resolve(data))
            )(String(parameters[0]));
            return recordedSandbox(resolved);
          }
          calls.push(`provider.${property}`);
          throw new Error(`provider.${property} must not be called`);
        };
      },
    }
  ) as DaytonaSandboxService;
  const store = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (typeof property !== "string" || property === "then") {
          return;
        }
        return () => {
          calls.push(`store.${property}`);
          if (property === "getDispatchAgent") {
            return Promise.resolve({
              agent: options.agent ?? agent(),
              kind: "found" as const,
              run: {
                sandboxBinding:
                  options.binding === undefined ? binding : options.binding,
              },
            });
          }
          return Promise.reject(new Error(`store.${property} must not run`));
        };
      },
    }
  ) as RunnerStore;
  return { calls, data, daytona, store };
}

function dispatch(fake: ReturnType<typeof recording>) {
  return ensureDaytonaSandboxForDispatch(
    { kind: "runner-operator" },
    authority,
    configuration,
    { daytona: fake.daytona, store: fake.store }
  );
}

async function refusal(
  fake: ReturnType<typeof recording>
): Promise<RunSandboxBindingRefusalReason> {
  try {
    await dispatch(fake);
  } catch (error) {
    assert.ok(
      error instanceof DaytonaSandboxBindingRefusedError,
      `expected a binding refusal, got ${String(error)}`
    );
    // Not the lifecycle error the dispatcher retains or retries on.
    assert.equal(error instanceof DaytonaSandboxLifecycleError, false);
    return error.reason;
  }
  return assert.fail("a bound dispatch that should refuse resolved");
}

const ONE_GET = ["store.getDispatchAgent", `provider.get:${SANDBOX_ID}`];
const NO_PROVIDER_CALL = ["store.getDispatchAgent"];

test("a bound dispatch returns the exact recorded sandbox after exactly one provider get", async () => {
  const fake = recording();
  const result = await dispatch(fake);

  assert.equal(result.sandbox.id, SANDBOX_ID);
  assert.equal(result.agent.daytonaSandboxId, SANDBOX_ID);
  assert.deepEqual(fake.calls, ONE_GET);
});

const providerRefusals: readonly Readonly<{
  expected: RunSandboxBindingRefusalReason;
  name: string;
  sandbox: (data: SandboxData) => Promise<SandboxData>;
}>[] = [
  {
    expected: "provider_not_found",
    name: "provider not found",
    sandbox: () => Promise.reject(new DaytonaNotFoundError("absent")),
  },
  {
    expected: "destroyed",
    name: "destroyed",
    sandbox: (data) =>
      Promise.resolve({ ...data, state: SandboxState.DESTROYED }),
  },
  {
    expected: "not_started",
    name: "stopped",
    sandbox: (data) =>
      Promise.resolve({ ...data, state: SandboxState.STOPPED }),
  },
  {
    expected: "not_started",
    name: "archived",
    sandbox: (data) =>
      Promise.resolve({ ...data, state: SandboxState.ARCHIVED }),
  },
  {
    expected: "not_started",
    name: "errored",
    sandbox: (data) => Promise.resolve({ ...data, state: SandboxState.ERROR }),
  },
  {
    expected: "not_started",
    name: "state not reported",
    sandbox: (data) => Promise.resolve({ ...data, state: undefined }),
  },
  {
    expected: "returned_id_mismatch",
    name: "returned ID differs from the bound ID",
    sandbox: (data) => Promise.resolve({ ...data, id: "sandbox-other" }),
  },
  {
    expected: "public_sandbox",
    name: "public sandbox",
    sandbox: (data) => Promise.resolve({ ...data, public: true }),
  },
  {
    expected: "ownership_mismatch",
    name: "labelled for another tenant",
    sandbox: (data) =>
      Promise.resolve({
        ...data,
        labels: {
          ...data.labels,
          ...daytonaSandboxLabels("other_tenant", AGENT_ID),
        },
      }),
  },
  {
    expected: "ownership_mismatch",
    name: "labelled with another generation",
    sandbox: (data) =>
      Promise.resolve({
        ...data,
        labels: { ...data.labels, sandboxGeneration: String(GENERATION - 1) },
      }),
  },
  {
    expected: "configuration_drift",
    name: "configuration drift",
    sandbox: (data) =>
      Promise.resolve({
        ...data,
        labels: { ...data.labels, configurationId: "old-configuration" },
      }),
  },
  {
    expected: "credential_boundary_missing",
    name: "missing credential boundary label",
    sandbox: (data) => {
      const { credentialBoundaryVersion: _removed, ...labels } = data.labels;
      return Promise.resolve({ ...data, labels });
    },
  },
];

for (const scenario of providerRefusals) {
  test(`a bound dispatch refuses and mutates nothing: ${scenario.name}`, async () => {
    const fake = recording({ get: () => scenario.sandbox(recording().data) });

    assert.equal(await refusal(fake), scenario.expected);
    // One read by the exact recorded ID. No create, start, delete, resize,
    // setLabels, interval, snapshot, name lookup, reservation, or attach.
    assert.deepEqual(fake.calls, ONE_GET);
  });
}

const recordRefusals: readonly Readonly<{
  agent: Partial<RunnerAgentRecord>;
  expected: RunSandboxBindingRefusalReason;
  name: string;
}>[] = [
  {
    agent: { daytonaSandboxId: null, sandboxLifecycle: "unprovisioned" },
    expected: "no_recorded_sandbox",
    name: "no recorded sandbox",
  },
  {
    agent: { daytonaSandboxId: "sandbox-replacement" },
    expected: "sandbox_id_mismatch",
    name: "a different recorded ID",
  },
  {
    agent: { sandboxGeneration: GENERATION + 1 },
    expected: "generation_mismatch",
    name: "generation changed",
  },
  ...(
    [
      "provisioning",
      "provisioning_ambiguous",
      "resizing",
      "resetting",
      "decommissioning",
      "decommission_failed",
    ] as const
  ).map((sandboxLifecycle) => ({
    agent: { sandboxLifecycle },
    expected: "lifecycle_not_ready" as const,
    name: `lifecycle ${sandboxLifecycle}`,
  })),
];

for (const scenario of recordRefusals) {
  test(`a bound dispatch refuses from the record without any provider call: ${scenario.name}`, async () => {
    const fake = recording({ agent: agent(scenario.agent) });

    assert.equal(await refusal(fake), scenario.expected);
    assert.deepEqual(fake.calls, NO_PROVIDER_CALL);
  });
}

test("a provider outage on a bound dispatch stays retryable and still mutates nothing", async () => {
  const fake = recording({
    get: () => Promise.reject(new DaytonaInternalServerError("unavailable")),
  });

  await assert.rejects(
    () => dispatch(fake),
    (error: unknown) =>
      !(error instanceof DaytonaSandboxBindingRefusedError) &&
      error instanceof DaytonaInternalServerError
  );
  assert.deepEqual(fake.calls, ONE_GET);
});

test("the same missing sandbox reaches reservation only when the run is unbound", async () => {
  const unbound = recording({
    binding: null,
    get: () => Promise.reject(new DaytonaNotFoundError("absent")),
  });

  await assert.rejects(() => dispatch(unbound));
  // Unchanged behaviour: an unbound run still enters the create path, which
  // this fake stops at its first durable step.
  assert.deepEqual(unbound.calls, [
    ...ONE_GET,
    "store.reserveDaytonaSandboxForDispatch",
  ]);

  const bound = recording({
    get: () => Promise.reject(new DaytonaNotFoundError("absent")),
  });
  assert.equal(await refusal(bound), "provider_not_found");
  assert.deepEqual(bound.calls, ONE_GET);
});

test("the executor names a binding refusal and does not call it cleanup-pending", async () => {
  const fake = recording({
    get: () => Promise.reject(new DaytonaNotFoundError("absent")),
  });
  const executor = configuredDaytonaRunnerExecutor({
    operator: { kind: "runner-operator" },
    sandboxConfiguration: configuration,
    sandboxDependencies: { daytona: fake.daytona },
    store: fake.store,
  });

  let thrown: unknown;
  try {
    await executor.ensureExecutionContext(authority);
  } catch (error) {
    thrown = error;
  }
  assert.equal(executor.sandboxBindingRefusal?.(thrown), "provider_not_found");
  assert.equal(executor.isCleanupPending(thrown), false);
  assert.equal(executor.sandboxBindingRefusal?.(new Error("other")), null);
  assert.equal(
    executor.sandboxBindingRefusal?.(
      new DaytonaSandboxLifecycleError("lifecycle", { retryable: true })
    ),
    null
  );
  // The pinned-snapshot preflight is the only other provider call, and it is
  // a read made before the sandbox is resolved.
  assert.deepEqual(fake.calls, [
    `provider.snapshot.get:${configuration.snapshotName}`,
    ...ONE_GET,
  ]);
});
