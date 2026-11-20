import assert from "node:assert/strict";
import test from "node:test";
import {
  DaytonaInternalServerError,
  DaytonaNotFoundError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
import type { RunSandboxBindingRefusalReason } from "@opencoven/agent-contracts";
import {
  admissionLimitsFromEnvironment,
  dispatchRunnerClaim,
} from "../admission";
import type { RunnerStore } from "../store";
import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerRunRecord,
  RunnerSandboxBinding,
} from "../types";
import { configuredDaytonaRunnerExecutor } from "./executor";
import { daytonaSandboxLabels, daytonaSandboxName } from "./names";
import { daytonaPersistentResourceLifecycle } from "./resource-lifecycle";
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
}> &
  Readonly<Record<string, unknown>>;

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
    snapshotFailure?: boolean;
  }> = {}
) {
  const calls: string[] = [];
  const data: SandboxData = {
    autoArchiveInterval: configuration.autoArchiveInterval,
    autoDeleteInterval: configuration.autoDeleteInterval,
    autoDestroyAt: undefined,
    autoPauseInterval: 0,
    autoStopInterval: configuration.autoStopInterval,
    cpu: configuration.resources.cpu,
    disk: configuration.resources.disk,
    domainAllowList: undefined,
    gpu: 0,
    id: SANDBOX_ID,
    labels: matchingLabels,
    linkedSandboxId: undefined,
    memory: configuration.resources.memory,
    networkAllowList: undefined,
    networkBlockAll: false,
    outboundProxyUrl: undefined,
    public: false,
    snapshot: configuration.snapshotName,
    state: SandboxState.STARTED,
    target: configuration.target,
    volumes: [],
    warmPoolId: undefined,
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
              if (options.snapshotFailure) {
                return Promise.reject(
                  new DaytonaNotFoundError("snapshot absent")
                );
              }
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
  // Refusals complete before snapshot preflight; successful dispatches still
  // require it, as the configured executor tests below assert.
  assert.deepEqual(fake.calls, ONE_GET);
});

const policyDrift: Readonly<Record<string, unknown>> = {
  autoArchiveInterval: 0,
  autoDeleteInterval: 1,
  autoDestroyAt: "2030-01-01T00:00:00Z",
  autoPauseInterval: 1,
  autoStopInterval: 0,
  cpu: 999,
  disk: 999,
  domainAllowList: "*",
  gpu: 1,
  linkedSandboxId: "other",
  memory: 999,
  networkAllowList: "0.0.0.0/0",
  networkBlockAll: true,
  outboundProxyUrl: "https://unexpected-proxy.invalid",
  snapshot: "unapproved-snapshot",
  target: "other-region",
  volumes: [{}],
  warmPoolId: "pool",
};
for (const [field, value] of Object.entries(policyDrift)) {
  test(`bound dispatch refuses actual ${field} drift despite matching labels`, async () => {
    const fake = recording({
      get: () => Promise.resolve({ ...recording().data, [field]: value }),
    });
    assert.equal(await refusal(fake), "configuration_drift");
    assert.deepEqual(fake.calls, ONE_GET);
  });
}
for (const field of [
  "snapshot",
  "target",
  "cpu",
  "memory",
  "disk",
  "gpu",
  "autoStopInterval",
  "autoArchiveInterval",
  "autoDeleteInterval",
  "autoPauseInterval",
  "networkBlockAll",
]) {
  for (const value of [
    undefined,
    null,
    "malformed",
    () => undefined,
    Number.NaN,
  ]) {
    test(`bound dispatch fails closed on ${field} metadata: ${String(value)}`, async () => {
      const fake = recording({
        get: () => Promise.resolve({ ...recording().data, [field]: value }),
      });
      assert.equal(await refusal(fake), "configuration_drift");
      assert.deepEqual(fake.calls, ONE_GET);
    });
  }
}
for (const field of [
  "autoDestroyAt",
  "domainAllowList",
  "linkedSandboxId",
  "networkAllowList",
  "outboundProxyUrl",
  "volumes",
  "warmPoolId",
]) {
  for (const value of [null, 123, () => undefined]) {
    test(`bound dispatch refuses malformed optional ${field}: ${String(value)}`, async () => {
      const fake = recording({
        get: () => Promise.resolve({ ...recording().data, [field]: value }),
      });
      assert.equal(await refusal(fake), "configuration_drift");
      assert.deepEqual(fake.calls, ONE_GET);
    });
  }
}

function composedExecutor(
  fake: ReturnType<typeof recording>,
  store = fake.store
) {
  return configuredDaytonaRunnerExecutor({
    operator: { kind: "runner-operator" },
    sandboxConfiguration: configuration,
    sandboxDependencies: { daytona: fake.daytona },
    store,
  });
}

for (const scenario of providerRefusals) {
  test(`configured executor decides ${scenario.name} before failing snapshot preflight`, async () => {
    const fake = recording({
      get: () => scenario.sandbox(recording().data),
      snapshotFailure: true,
    });
    const executor = composedExecutor(fake);
    await assert.rejects(
      () => executor.ensureExecutionContext(authority),
      (error: unknown) =>
        executor.sandboxBindingRefusal?.(error) === scenario.expected
    );
    assert.deepEqual(fake.calls, ONE_GET);
  });
}

test("configured bound dispatch still verifies the pinned snapshot after successful sandbox resolution", async () => {
  const fake = recording();
  await composedExecutor(fake).ensureExecutionContext(authority);
  assert.deepEqual(fake.calls, [
    ...ONE_GET,
    `provider.snapshot.get:${configuration.snapshotName}`,
  ]);
});

test("a valid bound sandbox cannot bypass a failing snapshot preflight", async () => {
  const fake = recording({ snapshotFailure: true });
  const executor = composedExecutor(fake);
  await assert.rejects(
    () => executor.ensureExecutionContext(authority),
    (error: unknown) =>
      error instanceof DaytonaSandboxLifecycleError &&
      executor.sandboxBindingRefusal?.(error) === null
  );
  assert.deepEqual(fake.calls, [
    ...ONE_GET,
    `provider.snapshot.get:${configuration.snapshotName}`,
  ]);
});

test("unbound dispatch keeps snapshot verification before any provider sandbox call or reservation", async () => {
  const fake = recording({ binding: null, snapshotFailure: true });
  await assert.rejects(() =>
    composedExecutor(fake).ensureExecutionContext(authority)
  );
  assert.deepEqual(fake.calls, [
    "store.getDispatchAgent",
    `provider.snapshot.get:${configuration.snapshotName}`,
  ]);
});

async function composedDispatch(fake: ReturnType<typeof recording>) {
  const run = {
    agentId: AGENT_ID,
    agentRuntime: "copilot",
    executionPermission: "unrestricted",
    githubBrokerPolicy: null,
    id: authority.runId,
    sandboxBinding: binding,
    tenant: TENANT,
    version: 1,
  } as RunnerRunRecord;
  const attemptId = "00000000-0000-4000-8000-000000000003";
  const errors: unknown[] = [];
  const preparationAuthority = { ...authority, attemptId, expectedVersion: 2 };
  const overrides: Record<string, unknown> = {
    authorizeDaytonaPreparation: () => {
      fake.calls.push("store.authorizeDaytonaPreparation");
      return Promise.resolve({
        attemptId,
        authority: preparationAuthority,
        kind: "authorized",
      });
    },
    cleanupTerminalLease: () => {
      fake.calls.push("store.cleanupTerminalLease");
      return Promise.resolve({ kind: "updated", value: run });
    },
    finalizeRun: (_operator: unknown, input: { error: unknown }) => {
      fake.calls.push("store.finalizeRun");
      errors.push(input.error);
      return Promise.resolve({ kind: "finalized", prunedRunIds: [], run });
    },
    releaseDaytonaPreparation: () => {
      fake.calls.push("store.releaseDaytonaPreparation");
      return Promise.resolve({
        authority: { ...authority, expectedVersion: 3 },
        kind: "released",
      });
    },
    releaseUnstartedDispatch: () => {
      fake.calls.push("store.releaseUnstartedDispatch");
      return Promise.resolve({ kind: "released", value: run });
    },
  };
  const store = new Proxy(fake.store, {
    get: (target, property) =>
      typeof property === "string" && Object.hasOwn(overrides, property)
        ? overrides[property]
        : Reflect.get(target, property),
  });
  const result = await dispatchRunnerClaim(
    { authority, run },
    {
      acquireCredential: () => {
        fake.calls.push("credential.acquire");
        throw new Error("credential must not be leased");
      },
      credentialInput: () => {
        fake.calls.push("credential.input");
        throw new Error("credential must not be staged");
      },
      executor: composedExecutor(fake, store),
      limits: admissionLimitsFromEnvironment({}),
      operator: { kind: "runner-operator" },
      store,
    }
  );
  return { errors, result };
}

for (const scenario of providerRefusals) {
  test(`composed admission refuses ${scenario.name} without reservation, credential or staging`, async () => {
    const fake = recording({
      get: () => scenario.sandbox(recording().data),
      snapshotFailure: true,
    });
    const { errors, result } = await composedDispatch(fake);
    assert.deepEqual(result, {
      kind: "refused",
      reason: "sandbox_binding",
      runId: authority.runId,
    });
    assert.deepEqual(fake.calls, [
      "store.getDispatchAgent",
      "store.authorizeDaytonaPreparation",
      ...ONE_GET,
      "store.releaseDaytonaPreparation",
      "store.finalizeRun",
      "store.cleanupTerminalLease",
    ]);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] && typeof errors[0] === "object");
    assert.equal(Reflect.get(errors[0], "code"), "sandbox_binding_refused");
    assert.equal(Reflect.get(errors[0], "details"), scenario.expected);
    assert.equal(Reflect.get(errors[0], "retryable"), false);
  });
}

test("composed admission releases and requeues a snapshot preflight failure without acquiring credentials", async () => {
  const fake = recording({ snapshotFailure: true });
  const { errors, result } = await composedDispatch(fake);
  assert.deepEqual(result, {
    kind: "retryable",
    reason: "sandbox_unavailable",
    runId: authority.runId,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(fake.calls, [
    "store.getDispatchAgent",
    "store.authorizeDaytonaPreparation",
    ...ONE_GET,
    `provider.snapshot.get:${configuration.snapshotName}`,
    "store.releaseDaytonaPreparation",
    "store.releaseUnstartedDispatch",
  ]);
});

for (const [field, value] of Object.entries(policyDrift)) {
  test(`composed admission refuses observed ${field} drift without credentials`, async () => {
    const fake = recording({
      get: () => Promise.resolve({ ...recording().data, [field]: value }),
    });
    const { result } = await composedDispatch(fake);
    assert.deepEqual(result, {
      kind: "refused",
      reason: "sandbox_binding",
      runId: authority.runId,
    });
    assert.deepEqual(fake.calls, [
      "store.getDispatchAgent",
      "store.authorizeDaytonaPreparation",
      ...ONE_GET,
      "store.releaseDaytonaPreparation",
      "store.finalizeRun",
      "store.cleanupTerminalLease",
    ]);
  });
}
for (const scenario of recordRefusals) {
  test(`configured executor refuses ${scenario.name} without snapshot or sandbox I/O`, async () => {
    const fake = recording({
      agent: agent(scenario.agent),
      snapshotFailure: true,
    });
    const executor = composedExecutor(fake);
    await assert.rejects(
      () => executor.ensureExecutionContext(authority),
      (error: unknown) =>
        executor.sandboxBindingRefusal?.(error) === scenario.expected
    );
    assert.deepEqual(fake.calls, NO_PROVIDER_CALL);
  });
}
test("a missing server configuration identity cannot authorize a bound sandbox", async () => {
  const fake = recording();
  await assert.rejects(
    () =>
      ensureDaytonaSandboxForDispatch(
        { kind: "runner-operator" },
        authority,
        { ...configuration, configurationId: undefined },
        { daytona: fake.daytona, store: fake.store }
      ),
    (error: unknown) =>
      error instanceof DaytonaSandboxBindingRefusedError &&
      error.reason === "configuration_drift"
  );
  assert.deepEqual(fake.calls, ONE_GET);
});
test("a recognized prior identity still requires matching observed policy without relabeling", async () => {
  const fake = recording();
  const result = await ensureDaytonaSandboxForDispatch(
    { kind: "runner-operator" },
    authority,
    {
      ...configuration,
      configurationId: "next-configuration",
      priorConfigurationIds: ["current-configuration"],
    },
    { daytona: fake.daytona, store: fake.store }
  );
  assert.equal(result.sandbox.id, SANDBOX_ID);
  assert.deepEqual(fake.calls, ONE_GET);
});

test("a deterministic sandbox name cannot substitute for the recorded ID", async () => {
  const fake = recording({
    binding: {
      ...binding,
      expectedSandboxId: daytonaSandboxName(TENANT, AGENT_ID),
    },
  });
  assert.equal(await refusal(fake), "sandbox_id_mismatch");
  assert.deepEqual(fake.calls, NO_PROVIDER_CALL);
});

test("bound dispatch accepts the same domain allow list in a different order", async () => {
  const fake = recording({
    get: () =>
      Promise.resolve({
        ...recording().data,
        domainAllowList: "a.example,b.example",
      }),
  });
  const result = await ensureDaytonaSandboxForDispatch(
    { kind: "runner-operator" },
    authority,
    { ...configuration, domainAllowList: "b.example,a.example" },
    { daytona: fake.daytona, store: fake.store }
  );
  assert.equal(result.sandbox.id, SANDBOX_ID);
  assert.deepEqual(fake.calls, ONE_GET);
});

for (const scenario of [
  ...providerRefusals,
  {
    expected: "bound",
    name: "valid pre-stamped identity",
    sandbox: (data: SandboxData) => Promise.resolve(data),
  },
]) {
  test(`guarded owner bind verifies ${scenario.name} with one exact provider read`, async () => {
    const fake = recording({ get: () => scenario.sandbox(recording().data) });
    const lifecycle = daytonaPersistentResourceLifecycle({
      configuration: () => configuration,
      daytona: () => fake.daytona,
      inventoryDaytona: () => assert.fail("inventory"),
      operator: { kind: "runner-operator" },
      repairDaytona: () => assert.fail("repair"),
      store: {
        bindExistingSandbox: async (_principal, _agentId, _binding, verify) => {
          await verify(
            agent({ daytonaSandboxId: null, sandboxLifecycle: "unprovisioned" })
          );
          return "bound";
        },
      } as Pick<RunnerStore, "bindExistingSandbox"> as RunnerStore,
    });
    assert.ok(lifecycle.bind);
    assert.equal(
      await lifecycle.bind(
        { kind: "subscriber", tenant: TENANT, userId: AGENT_ID },
        AGENT_ID,
        binding
      ),
      scenario.expected
    );
    assert.deepEqual(fake.calls, [`provider.get:${SANDBOX_ID}`]);
  });
}
