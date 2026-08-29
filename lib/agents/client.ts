import {
  type AgentDefinition,
  agentEnvelopeSchema,
  agentsEnvelopeSchema,
  apiErrorSchema,
  type CreateAgentInput,
  okEnvelopeSchema,
  type RunEvent,
  type RunResult,
  type RunSnapshot,
  runEnvelopeSchema,
  runErrorEnvelopeSchema,
  runEventSchema,
  runListEnvelopeSchema,
  runSnapshotEnvelopeSchema,
  runSnapshotToResult,
} from "@opencoven/agent-contracts";

/** How often a queued run is re-read while waiting for it to finish. */
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
 * Runner implementations have historically reported errors in two shapes.
 *
 * Agent Runner v1 answers the contract envelope,
 * `{ apiVersion, error: { code, message, retryable }, requestId }`, while the
 * older synchronous runner answered `{ code, error }`. Reading only one would
 * quietly degrade structured errors during compatibility windows.
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

/**
 * Reads one server-sent-event frame into a run event.
 *
 * Unparseable frames are dropped rather than thrown, so a comment keep-alive or
 * a field the contract gains later cannot end a stream that is otherwise fine.
 */
function readSseFrame(frame: string): RunEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");

  if (!data) {
    return null;
  }

  try {
    const parsed = runEventSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export class RunnerClient {
  private readonly request: Fetch;
  private readonly pollIntervalMs: number;

  constructor(
    request: Fetch = globalThis.fetch,
    options: RunnerClientOptions = {}
  ) {
    this.request = request;
    this.pollIntervalMs = options.pollIntervalMs ?? RUN_POLL_INTERVAL_MS;
  }

  async listAgents(signal?: AbortSignal): Promise<AgentDefinition[]> {
    const response = await this.fetch("/api/agents", { signal });
    return agentsEnvelopeSchema.parse(await response.json()).agents;
  }

  /**
   * Replaces an agent's definition.
   *
   * The runner carries `owner`, `createdAt` and `lastRunAt` forward from the
   * stored definition, so a caller cannot move an agent between tenants or
   * rewrite its history by sending different values.
   */
  async updateAgent(
    id: string,
    input: CreateAgentInput,
    signal?: AbortSignal
  ): Promise<AgentDefinition> {
    const response = await this.fetch(`/api/agents/${encodeURIComponent(id)}`, {
      body: JSON.stringify(input),
      method: "PUT",
      signal,
    });

    return agentEnvelopeSchema.parse(await response.json()).agent;
  }

  async createAgent(
    input: CreateAgentInput,
    signal?: AbortSignal
  ): Promise<AgentDefinition> {
    const response = await this.fetch("/api/agents", {
      body: JSON.stringify(input),
      method: "POST",
      signal,
    });
    return agentEnvelopeSchema.parse(await response.json()).agent;
  }

  /**
   * Runs a mission and resolves once it has finished, on either backend.
   *
   * A synchronous runner answers 200 with a finished `RunResult`. Agent Runner
   * answers 202 with a queued `RunSnapshot` and executes in the background, so
   * this follows the run to completion and projects it onto the same shape.
   * Callers see one method with one return type and do not have to know which
   * backend they are pointed at.
   */
  async runAgent(
    agentId: string,
    task: string,
    options: { harnessId?: string; signal?: AbortSignal } = {}
  ): Promise<RunResult> {
    const currentOperationId = operationId();
    const response = await this.fetch(
      `/api/agents/${encodeURIComponent(agentId)}/runs`,
      {
        // An operation id makes the start idempotent: a retried POST resolves
        // to the same run instead of starting a second.
        body: JSON.stringify({ operationId: currentOperationId, task }),
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

  /**
   * Starts a run and returns as soon as the runner has accepted it.
   *
   * `runAgent` waits for an outcome, which is the right shape for a caller that
   * only wants the result. The console is not that caller: it has a thread to
   * fill while the run is in flight, and awaiting completion first would leave
   * the record empty for the whole run and then paint it all at once.
   */
  async startRun(
    agentId: string,
    task: string,
    options: { harnessId?: string; signal?: AbortSignal } = {}
  ): Promise<RunSnapshot> {
    const currentOperationId = operationId();
    const response = await this.fetch(
      `/api/agents/${encodeURIComponent(agentId)}/runs`,
      {
        body: JSON.stringify({ operationId: currentOperationId, task }),
        method: "POST",
        signal: options.signal,
      }
    );
    const body = await response.json();

    const accepted = runSnapshotEnvelopeSchema.safeParse(body);
    if (accepted.success) {
      return accepted.data.run;
    }

    throw new RunnerApiError(
      "Runner returned an unrecognised run payload.",
      "unexpected_run_payload",
      response.status
    );
  }

  /**
   * Every run the runner still retains for one agent, newest first.
   *
   * The runner keeps a bounded history per agent, so this is the console's
   * memory across refreshes — without it a reload shows an empty session
   * list while the runs still exist on the other side.
   */
  async listRuns(
    agentId: string,
    signal?: AbortSignal
  ): Promise<RunSnapshot[]> {
    const response = await this.fetch(
      `/api/agents/${encodeURIComponent(agentId)}/runs`,
      { signal }
    );
    return runListEnvelopeSchema.parse(await response.json()).runs;
  }

  /** Re-reads one run. Used to reconcile after the event stream ends. */
  async getRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
    const response = await this.fetch(
      `/api/runs/${encodeURIComponent(runId)}`,
      { signal }
    );
    return runSnapshotEnvelopeSchema.parse(await response.json()).run;
  }

  /**
   * Follows a run's event stream, calling back for each event in order.
   *
   * Read with `fetch` rather than `EventSource` so resume cursors, aborts, and
   * structured non-OK responses use the same transport as every other request.
   *
   * Resolves when the stream closes. The runner closes it on a terminal run and
   * also on an idle timeout, so a caller that wants to be sure re-reads the
   * snapshot afterwards instead of treating the close as an outcome.
   */
  async streamRunEvents(
    runId: string,
    options: {
      lastEventId?: number;
      onEvent: (event: RunEvent) => void;
      signal?: AbortSignal;
    }
  ): Promise<void> {
    const response = await this.fetch(
      `/api/runs/${encodeURIComponent(runId)}/events`,
      {
        headers: {
          accept: "text/event-stream",
          ...(options.lastEventId
            ? { "last-event-id": String(options.lastEventId) }
            : {}),
        },
        signal: options.signal,
      }
    );

    const { body } = response;
    if (!body) {
      throw new RunnerApiError(
        "Runner returned no event stream.",
        "no_event_stream",
        response.status
      );
    }

    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";

    try {
      let done = false;
      while (!done) {
        // biome-ignore lint/performance/noAwaitInLoops: a stream is read one chunk at a time by definition; the next read cannot be issued before this one resolves.
        const chunk = await reader.read();
        if (chunk.done) {
          done = true;
          break;
        }
        buffer += chunk.value;

        // Frames are separated by a blank line. Anything after the last
        // separator is a partial frame and stays in the buffer.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = readSseFrame(frame);
          if (event) {
            options.onEvent(event);
          }
        }
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  /** Cancels a run in flight. */
  async stopRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
    const response = await this.fetch(
      `/api/runs/${encodeURIComponent(runId)}/stop`,
      { method: "POST", signal }
    );
    return runSnapshotEnvelopeSchema.parse(await response.json()).run;
  }

  async deleteAgent(agentId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetch(
      `/api/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE", signal }
    );
    okEnvelopeSchema.parse(await response.json());
  }

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.request(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        accept: "application/json",
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
