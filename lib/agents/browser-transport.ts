import {
  type AgentDefinition,
  type AgentRunnerHealth,
  agentEnvelopeSchema,
  agentRunnerHealthSchema,
  agentsEnvelopeSchema,
  type CreateAgentInput,
  canonicalUuidSchema,
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
import { browserApplicationPath } from "@/lib/application-path";

const DEFAULT_RECONNECT_DELAY_MS = 1000;
const DEFAULT_START_RETRY_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 30_000;
const MAX_START_RETRY_DELAY_MS = 2000;
const START_MAX_ATTEMPTS = 3;

const strictAgentsEnvelopeSchema = agentsEnvelopeSchema.strict();
const strictAgentEnvelopeSchema = agentEnvelopeSchema.strict();
const strictHarnessesEnvelopeSchema = harnessesEnvelopeSchema.strict();
const strictOkEnvelopeSchema = okEnvelopeSchema.strict();
const prewarmEnvelopeSchema = z
  .object({
    agentId: canonicalUuidSchema,
    warm: warmStateSchema,
  })
  .strict();

type Fetch = typeof globalThis.fetch;

export type BrowserRunnerTransportOptions = Readonly<{
  reconnectDelayMs?: number;
  startRetryDelayMs?: number;
}>;

export type StreamRunEventsOptions = Readonly<{
  lastEventId?: number;
  onEvent: (event: RunEvent) => void;
  signal?: AbortSignal;
}>;

export type RunnerStopOutcome = Readonly<{
  pending: boolean;
  run: RunSnapshot;
}>;

type EventStreamProgress = {
  cursor: number;
  terminal: boolean;
  terminalSnapshot?: RunSnapshot;
};

type ReadJsonOptions = Readonly<{
  retryableBodyReadFailure?: boolean;
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
  stopRun: (runId: string, signal?: AbortSignal) => Promise<RunnerStopOutcome>;
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

function invalidResponseEnvelope(
  status: number,
  options: Readonly<{ cause?: unknown; unreadable?: boolean }> = {}
): RunnerApiError {
  return new RunnerApiError(
    options.unreadable
      ? "Runner returned an unreadable response envelope."
      : "Runner returned an invalid response envelope.",
    "invalid_response_envelope",
    status,
    { cause: options.cause }
  );
}

function lostAcceptedResponseBody(
  cause: unknown,
  status: number
): RunnerApiError {
  return new RunnerApiError(
    "Runner response body was lost after the request was accepted.",
    "network_error",
    status,
    { cause, retryable: true }
  );
}

function isTransientInfrastructureStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
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

function isTerminalEvent(event: RunEvent): boolean {
  return (
    event.type === "completed" ||
    event.type === "failed" ||
    (event.type === "status" &&
      event.status !== "queued" &&
      event.status !== "running")
  );
}

export class BrowserRunnerTransport implements RunnerTransport {
  private readonly reconnectDelayMs: number;
  private readonly request: Fetch;
  private readonly startRetryDelayMs: number;

  constructor(
    request: Fetch = globalThis.fetch,
    options: BrowserRunnerTransportOptions = {}
  ) {
    this.request = request;
    this.reconnectDelayMs =
      options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.startRetryDelayMs =
      options.startRetryDelayMs ?? DEFAULT_START_RETRY_DELAY_MS;
  }

  async health(signal?: AbortSignal): Promise<AgentRunnerHealth> {
    return this.readJson(
      await this.fetch("/api/health", { signal }),
      agentRunnerHealthSchema,
      { signal }
    );
  }

  async listHarnesses(signal?: AbortSignal): Promise<HarnessStatus[]> {
    return (
      await this.readJson(
        await this.fetch("/api/harnesses", { signal }),
        strictHarnessesEnvelopeSchema,
        { signal }
      )
    ).harnesses;
  }

  async listAgents(signal?: AbortSignal): Promise<AgentDefinition[]> {
    return (
      await this.readJson(
        await this.fetch("/api/agents", { signal }),
        strictAgentsEnvelopeSchema,
        { signal }
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
        strictAgentEnvelopeSchema,
        { signal }
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
        strictAgentEnvelopeSchema,
        { signal }
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
        strictAgentEnvelopeSchema,
        { signal }
      )
    ).agent;
  }

  async deleteAgent(agentId: string, signal?: AbortSignal): Promise<void> {
    await this.readJson(
      await this.fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "DELETE",
        signal,
      }),
      strictOkEnvelopeSchema,
      { signal }
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
    await this.readJson(response, prewarmEnvelopeSchema, { signal });
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
        runListEnvelopeSchema,
        { signal }
      )
    ).runs;
  }

  async startRun(
    agentId: string,
    input: StartRunInput,
    signal?: AbortSignal
  ): Promise<RunSnapshot> {
    const body = JSON.stringify(input);
    for (let attempt = 0; attempt < START_MAX_ATTEMPTS; attempt += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: retries must remain sequential so one logical operation is admitted at a time.
        const snapshot = await this.startRunAttempt(agentId, body, signal);
        return snapshot;
      } catch (error) {
        if (
          !(
            error instanceof RunnerApiError &&
            error.retryable &&
            attempt < START_MAX_ATTEMPTS - 1
          )
        ) {
          throw error;
        }
        await this.waitForBackoff(
          this.startRetryDelayMs,
          MAX_START_RETRY_DELAY_MS,
          attempt,
          signal
        );
      }
    }
    throw new RunnerApiError("Runner request failed.", "network_error", 0, {
      retryable: true,
    });
  }

  private async startRunAttempt(
    agentId: string,
    body: string,
    signal?: AbortSignal
  ): Promise<RunSnapshot> {
    return (
      await this.readJson(
        await this.fetch(`/api/agents/${encodeURIComponent(agentId)}/runs`, {
          body,
          method: "POST",
          signal,
        }),
        runSnapshotEnvelopeSchema,
        { retryableBodyReadFailure: true, signal }
      )
    ).run;
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunSnapshot> {
    return (
      await this.readJson(
        await this.fetch(`/api/runs/${encodeURIComponent(runId)}`, { signal }),
        runSnapshotEnvelopeSchema,
        { signal }
      )
    ).run;
  }

  streamRunEvents(
    runId: string,
    options: StreamRunEventsOptions
  ): Promise<RunSnapshot> {
    return this.followRunEvents(runId, options.lastEventId ?? 0, options);
  }

  async stopRun(
    runId: string,
    signal?: AbortSignal
  ): Promise<RunnerStopOutcome> {
    const response = await this.fetch(
      `/api/runs/${encodeURIComponent(runId)}/stop`,
      {
        method: "POST",
        signal,
      }
    );
    const envelope = await this.readJson(response, runSnapshotEnvelopeSchema, {
      signal,
    });
    return { pending: response.status === 202, run: envelope.run };
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
      const response = await this.request(browserApplicationPath(path), {
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
    progress: EventStreamProgress,
    options: StreamRunEventsOptions
  ): Promise<void> {
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
    const cancelOnAbort = () => {
      reader.cancel(options.signal?.reason).catch(() => undefined);
    };
    options.signal?.addEventListener("abort", cancelOnAbort, { once: true });

    try {
      while (true) {
        if (options.signal?.aborted) {
          throw abortedError();
        }
        // biome-ignore lint/performance/noAwaitInLoops: stream chunks are ordered and must be consumed sequentially.
        const chunk = await reader.read();
        if (options.signal?.aborted) {
          throw abortedError();
        }
        if (chunk.done) {
          if (buffer.trim().length > 0) {
            throw eventStreamError(
              new Error("Runner event stream ended with an incomplete frame."),
              response.status
            );
          }
          return;
        }
        buffer += chunk.value.replaceAll("\r\n", "\n");
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const event = parseSseFrame(frame, response.status);
          if (!event || event.id <= progress.cursor) {
            continue;
          }
          progress.cursor = event.id;
          progress.terminal ||= isTerminalEvent(event);
          if (event.type === "completed") {
            progress.terminalSnapshot = event.run;
          }
          options.onEvent(event);
          if (progress.terminal) {
            return;
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
      options.signal?.removeEventListener("abort", cancelOnAbort);
      reader.cancel().catch(() => undefined);
    }
  }

  private async readJson<T>(
    response: Response,
    schema: z.ZodType<T>,
    options: ReadJsonOptions = {}
  ): Promise<T> {
    let source: string;
    try {
      source = await response.text();
    } catch (error) {
      if (options.signal?.aborted) {
        throw abortedError();
      }
      if (options.retryableBodyReadFailure) {
        throw lostAcceptedResponseBody(error, response.status);
      }
      throw invalidResponseEnvelope(response.status, {
        cause: error,
        unreadable: true,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(source);
    } catch (error) {
      throw invalidResponseEnvelope(response.status, { cause: error });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw invalidResponseEnvelope(response.status);
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
        response.status,
        { retryable: isTransientInfrastructureStatus(response.status) }
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
    const progress: EventStreamProgress = {
      cursor,
      terminal: false,
    };
    let recoveryAttempts = 0;
    while (true) {
      if (options.signal?.aborted) {
        throw abortedError();
      }
      const cursorBeforeAttempt = progress.cursor;
      let retryableFailure = false;

      if (!progress.terminal) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: each reconnect must resume from the cursor produced by the previous stream.
          const response = await this.fetch(
            `/api/runs/${encodeURIComponent(runId)}/events`,
            {
              accept: "text/event-stream",
              lastEventId: progress.cursor,
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
          await this.readEventStream(response, progress, options);
        } catch (error) {
          if (!(error instanceof RunnerApiError && error.retryable)) {
            throw error;
          }
          retryableFailure = true;
        }
      }

      if (progress.terminalSnapshot) {
        return progress.terminalSnapshot;
      }

      let snapshot: RunSnapshot;
      try {
        snapshot = await this.getRun(runId, options.signal);
      } catch (error) {
        if (!(error instanceof RunnerApiError && error.retryable)) {
          throw error;
        }
        retryableFailure = true;
        if (progress.cursor > cursorBeforeAttempt) {
          recoveryAttempts = 0;
        }
        recoveryAttempts += 1;
        await this.waitForReconnect(recoveryAttempts - 1, options.signal);
        continue;
      }

      if (snapshot.status !== "queued" && snapshot.status !== "running") {
        return snapshot;
      }

      if (progress.cursor > cursorBeforeAttempt) {
        recoveryAttempts = 0;
      }
      if (retryableFailure) {
        recoveryAttempts += 1;
      } else {
        recoveryAttempts = 0;
      }
      await this.waitForReconnect(
        Math.max(recoveryAttempts - 1, 0),
        options.signal
      );
    }
  }

  private waitForReconnect(
    attempt: number,
    signal?: AbortSignal
  ): Promise<void> {
    return this.waitForBackoff(
      this.reconnectDelayMs,
      MAX_RECONNECT_DELAY_MS,
      attempt,
      signal
    );
  }

  private waitForBackoff(
    baseDelayMs: number,
    maxDelayMs: number,
    attempt: number,
    signal?: AbortSignal
  ): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(abortedError());
    }
    const delay = Math.min(
      Math.max(0, baseDelayMs) * 2 ** Math.min(attempt, 30),
      maxDelayMs
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
