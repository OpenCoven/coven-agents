import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_INSPECTION_CONTRACT_VERSION,
  sandboxInspectionRequestSchema,
  sandboxInspectionResultSchema,
} from "./index";

const record = { fence: "none", generation: 3, lifecycle: "ready" } as const;
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
  networkBlockAll: null,
  public: false,
  snapshot: "snapshot-1",
  state: "stopped",
  target: "us",
  volumes: 0,
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
    { outcome: "ambiguous", reason: "sandbox_id_mismatch", record, version: 1 },
    { outcome: "unauthorized", version: 1 },
    { outcome: "unavailable", source: "provider", version: 1 },
  ];
  for (const result of results) {
    assert.deepEqual(sandboxInspectionResultSchema.parse(result), result);
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
