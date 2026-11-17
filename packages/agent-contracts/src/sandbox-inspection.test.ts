import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_INSPECTION_CONTRACT_VERSION,
  sandboxInspectionRequestSchema,
  sandboxInspectionResultSchema,
} from "./index";

const record = {
  agentId: "00000000-0000-4000-8000-000000000001",
  fence: "none",
  generation: 3,
  lifecycle: "ready",
  sandboxId: "sandbox-a",
} as const;
const policy = {
  adapterVersion: "daytona-adapter-v1",
  capabilityContractVersion: "hosted-v1",
  credentialBoundaryVersion: "attempt-reset-v1",
  harnesses: [{ id: "copilot", package: "@github/copilot", version: "1.0.0" }],
  resources: { cpu: 2, diskGib: 10, memoryGib: 4 },
  sdkVersion: "0.220.0",
  snapshotName: "snapshot-1",
  target: "us",
} as const;
const observed = {
  autoArchiveInterval: 10_080,
  autoDeleteInterval: -1,
  autoDestroyAtConfigured: false,
  autoPauseInterval: 0,
  autoStopInterval: 15,
  cpu: 2,
  diskGib: 10,
  domainAllowListConfigured: false,
  domainAllowListMatchesPolicy: true,
  gpu: null,
  identity: {
    configuration: "current",
    credentialBoundary: true,
    generationLabel: true,
    ownershipLabels: true,
  },
  linkedSandbox: false,
  memoryGib: 4,
  networkAllowListConfigured: false,
  networkBlockAll: null,
  public: false,
  snapshot: "snapshot-1",
  state: "stopped",
  target: "us",
  volumes: 0,
  warmPool: false,
} as const;

test("the inspection contract is version 1", () => {
  assert.equal(SANDBOX_INSPECTION_CONTRACT_VERSION, 1);
});

test("a request names exactly one sandbox ID and generation", () => {
  const request = { expectedGeneration: 3, expectedSandboxId: "sandbox-a" };
  assert.deepEqual(sandboxInspectionRequestSchema.parse(request), request);
  for (const invalid of [
    {},
    { ...request, tenant: "tenant-b" },
    { ...request, expectedGeneration: -1 },
    { ...request, expectedGeneration: 1.5 },
    { ...request, expectedSandboxId: "" },
    { ...request, expectedSandboxId: "../sandbox" },
    { ...request, expectedSandboxId: "a b" },
    { ...request, expectedSandboxId: "a".repeat(129) },
  ]) {
    assert.equal(
      sandboxInspectionRequestSchema.safeParse(invalid).success,
      false
    );
  }
});

test("every outcome parses and carries only its own fields", () => {
  const results = [
    { observed, outcome: "observed", policy, record, version: 1 },
    { outcome: "not_found", policy, record, version: 1 },
    {
      outcome: "ambiguous",
      reason: "sandbox_id_mismatch",
      record: { ...record, sandboxId: null },
      version: 1,
    },
    // The provider was asked about the supplied ID, so it may be echoed.
    {
      outcome: "ambiguous",
      reason: "returned_id_mismatch",
      record,
      version: 1,
    },
    { outcome: "unauthorized", version: 1 },
    { outcome: "unavailable", source: "provider", version: 1 },
  ];
  for (const result of results) {
    assert.deepEqual(sandboxInspectionResultSchema.parse(result), result);
  }
});

test("a refusal decided from the database never carries the recorded sandbox ID", () => {
  for (const reason of [
    "generation_mismatch",
    "no_recorded_sandbox",
    "pending_lifecycle",
    "sandbox_id_mismatch",
  ]) {
    assert.equal(
      sandboxInspectionResultSchema.safeParse({
        outcome: "ambiguous",
        reason,
        record,
        version: 1,
      }).success,
      false,
      reason
    );
    assert.equal(
      sandboxInspectionResultSchema.safeParse({
        outcome: "ambiguous",
        reason,
        record: { ...record, sandboxId: null },
        version: 1,
      }).success,
      true,
      reason
    );
  }
});

test("results cannot carry identifiers, labels, or another version", () => {
  const base = { observed, outcome: "observed", policy, record, version: 1 };
  for (const invalid of [
    { ...base, version: 2 },
    { ...base, sandboxId: "sandbox-a" },
    { ...base, observed: { ...observed, id: "sandbox-a" } },
    { ...base, observed: { ...observed, labels: { tenantDigest: "x" } } },
    { ...base, observed: { ...observed, name: "coven-agent-x" } },
    { ...base, observed: { ...observed, cpu: Number.NaN } },
    { ...base, observed: { ...observed, state: "paused" } },
    { ...base, record: { ...record, fence: "released" } },
    { ...base, record: { ...record, agentId: "" } },
    { ...base, record: { ...record, agentId: undefined } },
    { ...base, record: { ...record, sandboxId: "../sandbox" } },
    { ...base, record: { ...record, sandboxId: undefined } },
    { ...base, observed: { ...observed, domainAllowList: "example.test" } },
    { ...base, observed: { ...observed, networkAllowList: "0.0.0.0/0" } },
    { ...base, observed: { ...observed, autoDestroyAt: "2026-12-01" } },
    { ...base, observed: { ...observed, linkedSandbox: "sandbox-b" } },
    { ...base, observed: { ...observed, warmPool: "pool-1" } },
    { ...base, observed: { ...observed, domainAllowListMatchesPolicy: null } },
    // Bounds and required keys on the consumer fields.
    { ...base, observed: { ...observed, gpu: -1 } },
    { ...base, observed: { ...observed, gpu: 4097 } },
    { ...base, observed: { ...observed, gpu: 1.5 } },
    { ...base, observed: { ...observed, gpu: undefined } },
    { ...base, observed: { ...observed, autoPauseInterval: -2 } },
    { ...base, observed: { ...observed, autoPauseInterval: 10_000_001 } },
    { ...base, observed: { ...observed, volumes: 1025 } },
    { ...base, observed: { ...observed, autoDestroyAtConfigured: undefined } },
    { ...base, observed: { ...observed, linkedSandbox: undefined } },
    {
      ...base,
      observed: { ...observed, networkAllowListConfigured: undefined },
    },
    { ...base, observed: { ...observed, warmPool: undefined } },
    { ...base, record: { ...record, agentId: "a".repeat(129) } },
    { ...base, record: { ...record, sandboxId: "a".repeat(129) } },
    { ...base, record: { ...record, tenant: "tenant-b" } },
    { outcome: "unauthorized", reason: "wrong_tenant", version: 1 },
    { outcome: "unavailable", source: "https://provider.example", version: 1 },
    { outcome: "ready", version: 1 },
  ]) {
    assert.equal(
      sandboxInspectionResultSchema.safeParse(invalid).success,
      false
    );
  }
});
