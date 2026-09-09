import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerAgentRecord, RunnerPrincipal } from "../types";
import { hermeticSandboxId } from "./executor";
import { deleteHermeticSandbox, warmHermeticSandbox } from "./sandbox";

const principal: RunnerPrincipal = {
  kind: "subscriber",
  tenant: "tenant_a",
  userId: "00000000-0000-4000-8000-000000000001",
};

function agent(overrides: Partial<RunnerAgentRecord> = {}): RunnerAgentRecord {
  return {
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    daytonaSandboxId: null,
    description: "",
    familiarId: "auto",
    id: "00000000-0000-4000-8000-000000000002",
    instructions: "instructions",
    lastRunAt: null,
    model: "auto",
    name: "Hermetic agent",
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

test("hermetic prewarm persists deterministic lifecycle state through store fences", async () => {
  const calls: string[] = [];
  const reserved = agent({
    sandboxGeneration: 1,
    sandboxLifecycle: "provisioning",
    version: 1,
  });
  const attached = agent({
    daytonaSandboxId: hermeticSandboxId(principal.tenant, reserved.id),
    sandboxGeneration: 1,
    sandboxLifecycle: "ready",
    version: 2,
  });
  const warming = agent({
    ...attached,
    version: 3,
    warmStatus: "provisioning",
  });
  const ready = agent({ ...warming, version: 4, warmStatus: "ready" });
  const result = await warmHermeticSandbox(principal, agent(), {
    attachDaytonaSandbox: (
      _principal: RunnerPrincipal,
      input: { sandboxId: string }
    ) => {
      calls.push(`attach:${input.sandboxId}`);
      return Promise.resolve({ kind: "updated", value: attached });
    },
    beginDaytonaSandboxWarm: () => {
      calls.push("warm");
      return Promise.resolve({ kind: "started", value: warming });
    },
    finishDaytonaSandboxWarm: () => {
      calls.push("finish");
      return Promise.resolve({ kind: "updated", value: ready });
    },
    reserveDaytonaSandbox: () => {
      calls.push("reserve");
      return Promise.resolve({ kind: "reserved", value: reserved });
    },
  } as never);

  assert.deepEqual(result, { agent: ready, kind: "ready" });
  assert.deepEqual(calls, [
    "reserve",
    `attach:${hermeticSandboxId(principal.tenant, reserved.id)}`,
    "warm",
    "finish",
  ]);
});

test("hermetic delete uses the generic durable decommission fence", async () => {
  const decommissioning = agent({
    daytonaSandboxId: hermeticSandboxId(
      principal.tenant,
      "00000000-0000-4000-8000-000000000002"
    ),
    sandboxGeneration: 1,
    sandboxLifecycle: "decommissioning",
    version: 4,
  });
  const calls: string[] = [];
  const result = await deleteHermeticSandbox(principal, decommissioning.id, {
    beginDaytonaSandboxDecommission: () => {
      calls.push("decommission");
      return Promise.resolve({
        kind: "decommissioning",
        value: decommissioning,
      });
    },
    deleteDecommissionedAgent: (
      _principal: RunnerPrincipal,
      input: {
        agentId: string;
        expectedGeneration: number;
        expectedVersion: number;
      }
    ) => {
      calls.push(
        `delete:${input.agentId}:${input.expectedGeneration}:${input.expectedVersion}`
      );
      return Promise.resolve({ kind: "deleted" });
    },
  } as never);

  assert.deepEqual(result, { kind: "deleted" });
  assert.deepEqual(calls, [
    "decommission",
    "delete:00000000-0000-4000-8000-000000000002:1:4",
  ]);
});
