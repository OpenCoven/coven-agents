import "server-only";

import type { RunnerStore } from "../store";
import type { RunnerAgentRecord, RunnerPrincipal } from "../types";
import { hermeticSandboxId } from "./executor";

type HermeticSandboxStore = Pick<
  RunnerStore,
  | "attachDaytonaSandbox"
  | "beginDaytonaSandboxDecommission"
  | "beginDaytonaSandboxWarm"
  | "deleteDecommissionedAgent"
  | "finishDaytonaSandboxWarm"
  | "reserveDaytonaSandbox"
>;

async function ensureHermeticSandbox(
  principal: RunnerPrincipal,
  agent: RunnerAgentRecord,
  store: HermeticSandboxStore
): Promise<
  | { agent: RunnerAgentRecord; kind: "ready" }
  | { agent: RunnerAgentRecord; kind: "in_progress" }
  | { kind: "not_found" | "stale_version" }
> {
  const sandboxId = hermeticSandboxId(agent.tenant, agent.id);
  if (
    agent.sandboxLifecycle === "ready" &&
    agent.daytonaSandboxId === sandboxId
  ) {
    return { agent, kind: "ready" };
  }
  const reserved = await store.reserveDaytonaSandbox(principal, {
    agentId: agent.id,
    expectedGeneration: agent.sandboxGeneration,
    expectedSandboxId: agent.daytonaSandboxId,
    expectedVersion: agent.version,
    provisioningStaleBefore: new Date(),
  });
  if (reserved.kind !== "reserved") {
    return reserved.kind === "in_progress"
      ? { agent: reserved.value, kind: "in_progress" }
      : reserved;
  }
  const attached = await store.attachDaytonaSandbox(principal, {
    agentId: reserved.value.id,
    expectedGeneration: reserved.value.sandboxGeneration,
    expectedVersion: reserved.value.version,
    sandboxId,
  });
  if (attached.kind === "updated") {
    return { agent: attached.value, kind: "ready" };
  }
  return { kind: attached.kind };
}

export async function warmHermeticSandbox(
  principal: RunnerPrincipal,
  agent: RunnerAgentRecord,
  store: HermeticSandboxStore
): Promise<
  | { agent: RunnerAgentRecord; kind: "ready" | "in_progress" }
  | { kind: "not_found" | "stale_version" }
  | { kind: "unavailable"; source: "database" }
> {
  try {
    const ensured = await ensureHermeticSandbox(principal, agent, store);
    if (ensured.kind === "in_progress") {
      return ensured;
    }
    if (ensured.kind !== "ready") {
      return ensured;
    }
    const warm = await store.beginDaytonaSandboxWarm(principal, {
      agentId: ensured.agent.id,
      expectedGeneration: ensured.agent.sandboxGeneration,
      expectedVersion: ensured.agent.version,
    });
    if (warm.kind === "in_progress") {
      return { agent: warm.value, kind: "in_progress" };
    }
    if (warm.kind !== "started") {
      return warm;
    }
    const finished = await store.finishDaytonaSandboxWarm(principal, {
      agentId: warm.value.id,
      expectedGeneration: warm.value.sandboxGeneration,
      expectedVersion: warm.value.version,
      status: "ready",
    });
    return finished.kind === "updated"
      ? { agent: finished.value, kind: "ready" }
      : finished;
  } catch {
    return { kind: "unavailable", source: "database" };
  }
}

export async function deleteHermeticSandbox(
  principal: RunnerPrincipal,
  agentId: string,
  store: HermeticSandboxStore
): Promise<
  | { kind: "deleted" }
  | { kind: "busy" | "not_found" | "stale_version" }
  | { kind: "unavailable"; source: "database" }
> {
  try {
    const decommission = await store.beginDaytonaSandboxDecommission(
      principal,
      {
        agentId,
        provisioningStaleBefore: new Date(),
      }
    );
    if (decommission.kind !== "decommissioning") {
      return decommission.kind === "cleanup_required"
        ? { kind: "busy" }
        : decommission;
    }
    return await store.deleteDecommissionedAgent(principal, {
      agentId: decommission.value.id,
      expectedGeneration: decommission.value.sandboxGeneration,
      expectedVersion: decommission.value.version,
    });
  } catch {
    return { kind: "unavailable", source: "database" };
  }
}
