import {
  type AgentDefinition,
  type AgentRunnerHealth,
  type CreateAgentInput,
  type RunEvent,
  type RunResult,
  type RunSnapshot,
  runSnapshotToResult,
} from "@opencoven/agent-contracts";
import type { HarnessStatus } from "@opencoven/harness";
import {
  BrowserRunnerTransport,
  RunnerApiError,
  type RunnerStopOutcome,
  type RunnerTransport,
} from "./browser-transport";

export { RunnerApiError } from "./browser-transport";

const RUN_POLL_INTERVAL_MS = 1000;

export type RunnerClientOptions = {
  pollIntervalMs?: number;
};

function operationId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") {
    return source.randomUUID();
  }
  if (typeof source?.getRandomValues === "function") {
    const bytes = source.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0"));
    return [
      hex.slice(0, 4).join(""),
      hex.slice(4, 6).join(""),
      hex.slice(6, 8).join(""),
      hex.slice(8, 10).join(""),
      hex.slice(10).join(""),
    ].join("-");
  }
  throw new RunnerApiError(
    "This environment provides no secure random source, so a run cannot be started safely.",
    "no_random_source",
    0
  );
}

/**
 * Product-facing runner client.
 *
 * Protocol paths, credentials, envelopes, errors, and event-stream recovery
 * belong to `BrowserRunnerTransport`. This layer only coordinates operations
 * that span requests, such as waiting for an accepted run to finish.
 */
export class RunnerClient {
  private readonly pollIntervalMs: number;
  private readonly transport: RunnerTransport;

  constructor(
    transport: RunnerTransport = new BrowserRunnerTransport(),
    options: RunnerClientOptions = {}
  ) {
    this.transport = transport;
    this.pollIntervalMs = options.pollIntervalMs ?? RUN_POLL_INTERVAL_MS;
  }

  health(signal?: AbortSignal): Promise<AgentRunnerHealth> {
    return this.transport.health(signal);
  }

  listHarnesses(signal?: AbortSignal): Promise<HarnessStatus[]> {
    return this.transport.listHarnesses(signal);
  }

  listAgents(signal?: AbortSignal): Promise<AgentDefinition[]> {
    return this.transport.listAgents(signal);
  }

  getAgent(agentId: string, signal?: AbortSignal): Promise<AgentDefinition> {
    return this.transport.getAgent(agentId, signal);
  }

  updateAgent(
    agentId: string,
    input: CreateAgentInput,
    signal?: AbortSignal
  ): Promise<AgentDefinition> {
    return this.transport.updateAgent(agentId, input, signal);
  }

  createAgent(
    input: CreateAgentInput,
    signal?: AbortSignal,
    idempotencyKey?: string
  ): Promise<AgentDefinition> {
    return this.transport.createAgent(input, signal, idempotencyKey);
  }

  prewarmTenant(signal?: AbortSignal): Promise<void> {
    return this.transport.prewarmTenant(signal);
  }

  async runAgent(
    agentId: string,
    task: string,
    options: { harnessId?: string; signal?: AbortSignal } = {}
  ): Promise<RunResult> {
    const queued = await this.transport.startRun(
      agentId,
      { operationId: operationId(), task },
      options.signal
    );
    return this.awaitRun(queued, options.signal);
  }

  startRun(
    agentId: string,
    task: string,
    options: { harnessId?: string; signal?: AbortSignal } = {}
  ): Promise<RunSnapshot> {
    return this.transport.startRun(
      agentId,
      { operationId: operationId(), task },
      options.signal
    );
  }

  listRuns(agentId: string, signal?: AbortSignal): Promise<RunSnapshot[]> {
    return this.transport.listRuns(agentId, signal);
  }

  getRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
    return this.transport.getRun(runId, signal);
  }

  streamRunEvents(
    runId: string,
    options: {
      lastEventId?: number;
      onEvent: (event: RunEvent) => void;
      signal?: AbortSignal;
    }
  ): Promise<RunSnapshot> {
    return this.transport.streamRunEvents(runId, options);
  }

  stopRun(runId: string, signal?: AbortSignal): Promise<RunnerStopOutcome> {
    return this.transport.stopRun(runId, signal);
  }

  deleteAgent(agentId: string, signal?: AbortSignal): Promise<void> {
    return this.transport.deleteAgent(agentId, signal);
  }

  private async awaitRun(
    queued: RunSnapshot,
    signal?: AbortSignal
  ): Promise<RunResult> {
    let snapshot = queued;
    while (snapshot.status === "queued" || snapshot.status === "running") {
      if (signal?.aborted) {
        throw new RunnerApiError(
          "Waiting for the run was aborted.",
          "aborted",
          0
        );
      }
      // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by definition.
      await this.wait(signal);
      snapshot = await this.transport.getRun(snapshot.id, signal);
    }
    return runSnapshotToResult(snapshot);
  }

  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, this.pollIntervalMs);
      function onAbort() {
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
