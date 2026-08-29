import {
  type AgentDefinition,
  type AgentRunnerHealth,
  agentEnvelopeSchema,
  agentRunnerHealthSchema,
  agentsEnvelopeSchema,
  type CreateAgentInput,
  okEnvelopeSchema,
  type RunEvent,
  type RunSnapshot,
  runErrorEnvelopeSchema,
  runEventSchema,
  runListEnvelopeSchema,
  runSnapshotEnvelopeSchema,
  type StartRunInput,
  warmStateSchema,
} from "@opencoven/agent-contracts";
import {
  type HarnessStatus,
  harnessesEnvelopeSchema,
} from "@opencoven/harness";
import { z } from "zod";

const DEFAULT_RECONNECT_DELAY_MS = 1000;

const strictAgentsEnvelopeSchema = agentsEnvelopeSchema.strict();
const strictAgentEnvelopeSchema = agentEnvelopeSchema.strict();
const strictHarnessesEnvelopeSchema = harnessesEnvelopeSchema.strict();
const strictOkEnvelopeSchema = okEnvelopeSchema.strict();
const prewarmEnvelopeSchema = z
  .object({
    agentId: z.string().uuid(),
    warm: warmStateSchema,
  })
  .strict();

type Fetch = typeof globalThis.fetch;

export type BrowserRunnerTransportOptions = Readonly<{
  reconnectDelayMs?: number;
}>;

export type StreamRunEventsOptions = Readonly<{
  lastEventId?: number;
  onEvent: (event: RunEvent) => void;
  signal?: AbortSignal;
}>;

export interface RunnerTransport {
  createAgent: (
    input: CreateAgentInput,
    signal?: AbortSignal
  ) => Promise<AgentDefinition>;
  deleteAgent: (agentId: string, signal?: AbortSignal) => Promise<void>;
  getAgent: (agentId: string, signal?: AbortSignal) => Promise<AgentDefinition>;
  getRun: (runId: string, signal?: AbortSignal) => Promise<RunSnapshot>;
  health: (signal?: AbortSignal) => Promise<AgentRunnerHealth>;
  listAgents: (signal?: AbortSignal) => Promise<AgentDefinition[]>;
  listHarnesses: (signal?: AbortSignal) => Promise<HarnessStatus[]>;
  listRuns: (agentId: string, signal?: AbortSignal) => Promise<RunSnapshot[]>;
  prewarmTenant: (signal?: AbortSignal) => Promise<void>;
  startRun: (
    agentId: string,
    input: StartRunInput,
    signal?: AbortSignal
  ) => Promise<RunSnapshot>;
  stopRun: (runId: string, signal?: AbortSignal) => Promise<RunSnapshot>;
  streamRunEvents: (
    runId: string,
    options: StreamRunEventsOptions
  ) => Promise<RunSnapshot>;
  updateAgent: (
    agentId: string,
    input: CreateAgentInput,
    signal?: AbortSignal
  ) => Promise<AgentDefinition>;
}

export class RunnerApiError extends Error {
  readonly code: string;
  readonly details?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    message: string,
    code: string,
    status: number,
    options: Readonly<{
      details?: string;
      cause?: unknown;
      requestId?: string;
      retryable?: boolean;
    }> = {}
  ) {
    super(message, { cause: options.cause });
    this.name = "RunnerApiError";
    this.code = code;
    this.details = options.details;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.status = status;
  }
}

function abortedError(): RunnerApiError {
  return new RunnerApiError("Runner request was aborted.", "aborted", 0);
}

function networkError(cause: unknown): RunnerApiError {
  return new RunnerApiError("Could not reach the runner.", "network_error", 0, {
    cause,
    retryable: true,
  });
}

function eventStreamError(cause: unknown, status: number): RunnerApiError {
  return new RunnerApiError(
    "Lost the runner event stream.",
    "event_stream_error",
    status,
    { cause, retryable: true }
  );
}

function parseSseFrame(frame: string, status: number): RunEvent | null {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
  if (!data) {
    return null;
  }

  try {
    const parsed = runEventSchema.safeParse(JSON.parse(data));
    if (parsed.success) {
      return parsed.data;
    }
  } catch {
    // Report every malformed data frame through one typed transport error.
  }
  throw new RunnerApiError(
    "Runner returned an invalid event stream frame.",
    "invalid_event",
    status
  );
}

export class BrowserRunnerTransport implements RunnerTransport {
  private readonly reconnectDelayMs: number;
  private readonly request: Fetch;

  constructor(
    request: Fetch = globalThis.fetch,
    options: BrowserRunnerTransportOptions = {}
  ) {
    this.request = request;
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
  }

  async health(signal?: AbortSignal): Promise<AgentRunnerHealth> {
    return this.readJson(
      await this.fetch("/api/health", { signal }),
      agentRunnerHealthSchema
    );
  }

  async listHarnesses(signal?: AbortSignal): Promise<HarnessStatus[]> {
    return (
      await this.readJson(
        await this.fetch("/api/harnesses", { signal }),
        strictHarnessesEnvelopeSchema
      )
    ).harnesses;
  }

  async listAgents(signal?: AbortSignal): Promise<AgentDefinition[]> {
    return (
      await this.readJson(
        await this.fetch("/api/agents", { signal }),
        strictAgentsEnvelopeSchema
      )
    ).agents;
  }

  async getAgent(
    agentId: string,
    signal?: AbortSignal
  ): Promise<AgentDefinition> {
    return (
      await this.readJson(
        await this.fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
          signal,
        }),
        strictAgentEnvelopeSchema
      )
    ).agent;
  }

  async createAgent(
    input: CreateAgentInput,
    signal?: AbortSignal
  ): Promise<AgentDefinition> {
    return (
      await this.readJson(
        await this.fetch("/api/agents", {
          body: JSON.stringify(input),
          method: "POST",
          signal,
        }),
        strictAgentEnvelopeSchema
      )
    ).agent;
  }

  async updateAgent(
    agentId: string,
    input: CreateAgentInput,
    signal?: AbortSignal
  ): Promise<AgentDefinition> {
    return (
      await this.readJson(
        await this.fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
          body: JSON.stringify(input),
          method: "PUT",
          signal,
        }),
        strictAgentEnvelopeSchema
      )
    ).agent;
  }

  async deleteAgent(agentId: string, signal?: AbortSignal): Promise<void> {
    await this.readJson(
      await this.fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "DELETE",
        signal,
      }),
      strictOkEnvelopeSchema
    );
  }

  async prewarmTenant(signal?: AbortSignal): Promise<void> {
    const response = await this.fetch("/api/tenant/prewarm", {
      method: "POST",
      signal,
    });
    if (response.status === 204) {
      return;
    }
    if (response.status !== 202) {
      throw new RunnerApiError(
        "Runner returned an invalid prewarm response.",
        "invalid_response_envelope",
        response.status
      );
    }
    await this.readJson(response, prewarmEnvelopeSchema);
  }

  async listRuns(
    agentId: string,
    signal?: AbortSignal
  ): Promise<RunSnapshot[]> {
    return (
      await this.readJson(
        await this.fetch(`/api/agents/${encodeURIComponent(agentId)}/runs`, {
          signal,
        }),
        runListEnvelopeSchema
      )
    ).runs;
  }

  async startRun(
    agentId: string,
    input: StartRunInput,
    signal?: AbortSignal
  ): Promise<RunSnapshot> {
    return (
      await this.readJson(
        await this.fetch(`/api/agents/${encodeURIComponent(agentId)}/runs`, {
          body: JSON.stringify(input),
          method: "POST",
          signal,
        }),
        runSnapshotEnvelopeSchema
      )
    ).run;
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
    return (
      await this.readJson(
        await this.fetch(`/api/runs/${encodeURIComponent(runId)}`, { signal }),
        runSnapshotEnvelopeSchema
      )
    ).run;
  }

  streamRunEvents(
    runId: string,
    options: StreamRunEventsOptions
  ): Promise<RunSnapshot> {
    return this.followRunEvents(runId, options.lastEventId ?? 0, options);
  }

  async stopRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
    return (
      await this.readJson(
        await this.fetch(`/api/runs/${encodeURIComponent(runId)}/stop`, {
          method: "POST",
          signal,
        }),
        runSnapshotEnvelopeSchema
      )
    ).run;
  }

  private async fetch(
    path: string,
    options: Readonly<{
      accept?: "text/event-stream";
      body?: string;
      lastEventId?: number;
      method?: "DELETE" | "GET" | "POST" | "PUT";
      signal?: AbortSignal;
    }> = {}
  ): Promise<Response> {
    if (options.signal?.aborted) {
      throw abortedError();
    }

    try {
      const response = await this.request(path, {
        body: options.body,
        credentials: "same-origin",
        headers: {
          accept: options.accept ?? "application/json",
          ...(options.body ? { "content-type": "application/json" } : {}),
          ...(options.lastEventId
            ? { "last-event-id": String(options.lastEventId) }
            : {}),
        },
        method: options.method ?? "GET",
        signal: options.signal,
      });
      if (response.ok) {
        return response;
      }
      await this.throwResponseError(response);
    } catch (error) {
      if (error instanceof RunnerApiError) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw abortedError();
      }
      throw networkError(error);
    }
    throw new RunnerApiError("Runner request failed.", "network_error", 0, {
      retryable: true,
    });
  }

  private async readEventStream(
    response: Response,
    initialCursor: number,
    options: StreamRunEventsOptions
  ): Promise<number> {
    if (!response.body) {
      throw new RunnerApiError(
        "Runner returned no event stream.",
        "no_event_stream",
        response.status
      );
    }

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .getReader();
    let buffer = "";
    let cursor = initialCursor;

    try {
      while (true) {
        if (options.signal?.aborted) {
          throw abortedError();
        }
        // biome-ignore lint/performance/noAwaitInLoops: stream chunks are ordered and must be consumed sequentially.
        const chunk = await reader.read();
        if (chunk.done) {
          return cursor;
        }
        buffer += chunk.value.replaceAll("\r\n", "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = parseSseFrame(frame, response.status);
          if (event && event.id > cursor) {
            cursor = event.id;
            options.onEvent(event);
          }
        }
      }
    } catch (error) {
      if (error instanceof RunnerApiError) {
        throw error;
      }
      if (options.signal?.aborted) {
        throw abortedError();
      }
      throw eventStreamError(error, response.status);
    } finally {
      reader.cancel().catch(() => undefined);
    }
  }

  private async readJson<T>(
    response: Response,
    schema: z.ZodType<T>
  ): Promise<T> {
    const body = await response.json().catch(() => undefined);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new RunnerApiError(
        "Runner returned an invalid response envelope.",
        "invalid_response_envelope",
        response.status
      );
    }
    return parsed.data;
  }

  private async throwResponseError(response: Response): Promise<never> {
    const body = await response.json().catch(() => undefined);
    const parsed = runErrorEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      throw new RunnerApiError(
        "Runner returned an invalid error envelope.",
        "invalid_error_envelope",
        response.status
      );
    }
    throw new RunnerApiError(
      parsed.data.error.message,
      parsed.data.error.code,
      response.status,
      {
        details: parsed.data.error.details,
        requestId: parsed.data.requestId,
        retryable: parsed.data.error.retryable,
      }
    );
  }

  private async followRunEvents(
    runId: string,
    cursor: number,
    options: StreamRunEventsOptions
  ): Promise<RunSnapshot> {
    let nextCursor = cursor;
    while (true) {
      if (options.signal?.aborted) {
        throw abortedError();
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each reconnect must resume from the cursor produced by the previous stream.
        const response = await this.fetch(
          `/api/runs/${encodeURIComponent(runId)}/events`,
          {
            accept: "text/event-stream",
            lastEventId: nextCursor,
            signal: options.signal,
          }
        );
        if (
          !response.headers
            .get("content-type")
            ?.toLowerCase()
            .startsWith("text/event-stream")
        ) {
          throw new RunnerApiError(
            "Runner returned no event stream.",
            "no_event_stream",
            response.status
          );
        }
        nextCursor = await this.readEventStream(response, nextCursor, options);
      } catch (error) {
        if (!(error instanceof RunnerApiError && error.retryable)) {
          throw error;
        }
      }

      const snapshot = await this.getRun(runId, options.signal);
      if (snapshot.status !== "queued" && snapshot.status !== "running") {
        return snapshot;
      }
      await this.waitForReconnect(options.signal);
    }
  }

  private waitForReconnect(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortedError());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, this.reconnectDelayMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
