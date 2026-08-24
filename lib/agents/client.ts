import {
  type AgentDefinition,
  agentEnvelopeSchema,
  agentsEnvelopeSchema,
  apiErrorSchema,
  type CreateAgentInput,
  okEnvelopeSchema,
  type RunResult,
  type RunSnapshot,
  runEnvelopeSchema,
  runErrorEnvelopeSchema,
  runSnapshotEnvelopeSchema,
  runSnapshotToResult,
} from "@opencoven/agent-contracts";

/** How often a queued cloud run is re-read while waiting for it to finish. */
const RUN_POLL_INTERVAL_MS = 1000;

export type RunnerClientOptions = {
  /** Overridable so tests do not spend real seconds asleep. */
  pollIntervalMs?: number;
};

/**
 * A v4 uuid for the operation id, without assuming `crypto.randomUUID`.
 *
 * Browsers only expose `randomUUID` in a secure context, so reaching a local
 * runner over plain HTTP on a LAN address — `http://192.168.1.10:7331`, a
 * documented setup — leaves it undefined and every run would throw before the
 * request was even sent. `getRandomValues` carries no such restriction, so it
 * is the fallback rather than `Math.random`, which would weaken the uniqueness
 * the id exists to provide.
 */
function operationId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === "function") {
    return source.randomUUID();
  }
  if (typeof source?.getRandomValues === "function") {
    const bytes = source.getRandomValues(new Uint8Array(16));
    // Version 4, variant 10xx, per RFC 4122.
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }
  throw new RunnerApiError(
    "This environment provides no secure random source, so a run cannot be started safely.",
    "no_random_source",
    0
  );
}

export interface RunnerConnection {
  endpoint: string;
  token: string;
}

export class RunnerApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "RunnerApiError";
    this.code = code;
    this.status = status;
  }
}

type Fetch = typeof globalThis.fetch;

/**
 * The two backends report errors differently and this client talks to both.
 *
 * The cloud runner answers the contract envelope,
 * `{ apiVersion, error: { code, message, retryable }, requestId }`, while the
 * local runner still answers the older flat `{ code, error }`. Reading only one
 * of them would not fail loudly — it would quietly degrade every error from the
 * other backend to "Runner request failed (400)", losing `already_running`,
 * `harness_unsupported` and the rest.
 *
 * This is a deliberate stopgap. It exists because the local runner has not
 * moved to the async protocol yet; when it does, the flat branch goes.
 */
function readRunnerError(
  body: unknown,
  status: number
): { code: string; message: string } {
  const envelope = runErrorEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    return {
      code: envelope.data.error.code,
      message: envelope.data.error.message,
    };
  }
  const flat = apiErrorSchema.safeParse(body);
  if (flat.success) {
    return { code: flat.data.code, message: flat.data.error };
  }
  return {
    code: "runner_error",
    message: `Runner request failed (${status}).`,
  };
}

export class RunnerClient {
  private readonly connection: RunnerConnection;
  private readonly endpoint: string;
  private readonly request: Fetch;
  private readonly pollIntervalMs: number;

  constructor(
    connection: RunnerConnection,
    request: Fetch = globalThis.fetch,
    options: RunnerClientOptions = {}
  ) {
    this.connection = connection;
    this.endpoint = connection.endpoint.replace(/\/+$/, "");
    this.request = request;
    this.pollIntervalMs = options.pollIntervalMs ?? RUN_POLL_INTERVAL_MS;
  }

  async listAgents(signal?: AbortSignal): Promise<AgentDefinition[]> {
    const response = await this.fetch("/api/agents", { signal });
    return agentsEnvelopeSchema.parse(await response.json()).agents;
  }

  async createAgent(input: CreateAgentInput): Promise<AgentDefinition> {
    const response = await this.fetch("/api/agents", {
      body: JSON.stringify(input),
      method: "POST",
    });
    return agentEnvelopeSchema.parse(await response.json()).agent;
  }

  /**
   * Runs a mission and resolves once it has finished, on either backend.
   *
   * The local runner answers 200 with a finished `RunResult`. The cloud runner
   * answers 202 with a queued `RunSnapshot` and executes in the background, so
   * this follows the run to completion and projects it onto the same shape.
   * Callers see one method with one return type and do not have to know which
   * backend they are pointed at.
   */
  async runAgent(
    agentId: string,
    task: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RunResult> {
    const response = await this.fetch(
      `/api/agents/${encodeURIComponent(agentId)}/runs`,
      {
        // An operation id makes the start idempotent on the cloud runner: a
        // retried POST resolves to the same run instead of starting a second.
        // The local runner ignores the extra field.
        body: JSON.stringify({ operationId: operationId(), task }),
        method: "POST",
        signal: options.signal,
      }
    );
    const body = await response.json();

    const finished = runEnvelopeSchema.safeParse(body);
    if (finished.success) {
      return finished.data.run;
    }

    const accepted = runSnapshotEnvelopeSchema.safeParse(body);
    if (!accepted.success) {
      throw new RunnerApiError(
        "Runner returned an unrecognised run payload.",
        "unexpected_run_payload",
        response.status
      );
    }
    return await this.awaitRun(accepted.data.run, options.signal);
  }

  /** Polls a queued run until it reaches a terminal state. */
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
      // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by definition — the next read only makes sense after this interval has elapsed and the previous one has resolved.
      await this.wait(signal);
      const response = await this.fetch(
        `/api/runs/${encodeURIComponent(snapshot.id)}`,
        { signal }
      );
      snapshot = runSnapshotEnvelopeSchema.parse(await response.json()).run;
    }
    return runSnapshotToResult(snapshot);
  }

  /**
   * Sleeps between polls, waking immediately if the caller aborts.
   *
   * A bare `setTimeout` would leave an abort waiting out the rest of the
   * interval before anything noticed it.
   */
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

  /** Cancels a run in flight. Cloud runner only; the local runner has no such route. */
  async stopRun(runId: string): Promise<RunSnapshot> {
    const response = await this.fetch(
      `/api/runs/${encodeURIComponent(runId)}/stop`,
      { method: "POST" }
    );
    return runSnapshotEnvelopeSchema.parse(await response.json()).run;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const response = await this.fetch(
      `/api/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" }
    );
    okEnvelopeSchema.parse(await response.json());
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.endpoint) {
      throw new RunnerApiError(
        "Runner endpoint is required.",
        "missing_endpoint",
        0
      );
    }
    if (!this.connection.token) {
      throw new RunnerApiError(
        "Runner access token is required.",
        "missing_token",
        0
      );
    }

    const response = await this.request(`${this.endpoint}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.connection.token}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      const body = await response
        .clone()
        .json()
        .catch(() => null);
      const { code, message } = readRunnerError(body, response.status);
      throw new RunnerApiError(message, code, response.status);
    }

    return response;
  }
}
