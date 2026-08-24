import {
  agentEnvelopeSchema,
  createAgentInputSchema,
  okEnvelopeSchema,
  type RunEvent,
  type RunResult,
  runErrorEnvelopeSchema,
  runEventSchema,
  runSnapshotEnvelopeSchema,
  runSnapshotToResult,
  startRunInputSchema,
} from "@opencoven/agent-contracts";
import type { ArrivedEvent } from "@/lib/demo/offsets";
import { DEMO_REPOSITORY } from "@/lib/demo/recordable";

const DEFAULT_RECORDING_TIMEOUT_MS = 15 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 10_000;
const DEMO_REPOSITORY_URL = "https://github.com/OpenCoven/demo-workspace.git";
const DEMO_WORKSPACE = "/workspace";
const DEMO_REPOSITORY_WORKSPACE = "/workspace/repo";
const TERMINAL_EVENT_TYPES = new Set<RunEvent["type"]>(["completed", "failed"]);

type Environment = Readonly<Record<string, string | undefined>>;
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

export type CaptureEnvironment = {
  identityToken: string;
  runnerToken: string;
  runnerUrl: string;
  timeoutMs: number;
};

export type CaptureRunOptions = {
  repository: string;
  task: string;
};

export type CapturedRun = {
  arrivals: ArrivedEvent[];
  result: RunResult;
};

export type CaptureDependencies = {
  environment?: Environment;
  now?: () => number;
  randomUUID?: () => string;
  request?: FetchLike;
};

type RunnerConnection = {
  identityToken: string;
  request: FetchLike;
  runnerToken: string;
  runnerUrl: string;
};

function nonblank(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

export function readCaptureEnvironment(
  environment: Environment
): CaptureEnvironment {
  const runnerUrl =
    environment.DEMO_RUNNER_URL ?? environment.NEXT_PUBLIC_CLOUD_RUNNER_URL;
  const runnerToken = environment.DEMO_RUNNER_TOKEN;
  const identityToken = environment.DEMO_RUNNER_IDENTITY_TOKEN;
  const missing: string[] = [];
  if (!nonblank(runnerUrl)) {
    missing.push("DEMO_RUNNER_URL or NEXT_PUBLIC_CLOUD_RUNNER_URL");
  }
  if (!nonblank(runnerToken)) {
    missing.push("DEMO_RUNNER_TOKEN");
  }
  if (!nonblank(identityToken)) {
    missing.push("DEMO_RUNNER_IDENTITY_TOKEN");
  }
  if (
    !nonblank(runnerUrl) ||
    !nonblank(runnerToken) ||
    !nonblank(identityToken)
  ) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}.`
    );
  }

  const rawTimeout = environment.DEMO_RECORDING_TIMEOUT_MS;
  const timeoutMs =
    rawTimeout === undefined
      ? DEFAULT_RECORDING_TIMEOUT_MS
      : Number(rawTimeout);
  if (!(Number.isInteger(timeoutMs) && timeoutMs > 0)) {
    throw new Error(
      "DEMO_RECORDING_TIMEOUT_MS must be a positive integer in milliseconds."
    );
  }

  return {
    identityToken,
    runnerToken,
    runnerUrl: runnerUrl.trim().replace(/\/+$/, ""),
    timeoutMs,
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Demo recording was aborted.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown capture failure.";
}

async function fetchRunner(
  connection: RunnerConnection,
  path: string,
  init: RequestInit,
  signal: AbortSignal
): Promise<Response> {
  const method = init.method ?? "GET";
  let response: Response;
  try {
    response = await connection.request(`${connection.runnerUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${connection.identityToken}`,
        "x-runner-token": connection.runnerToken,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw abortError(signal);
    }
    throw new Error(
      `Runner request ${method} ${path} failed before receiving a response.`,
      { cause: error }
    );
  }

  if (!response.ok) {
    const body = await response
      .clone()
      .json()
      .catch(() => null);
    const parsed = runErrorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      throw new Error(
        `Runner request ${method} ${path} failed (${response.status}, ${parsed.data.error.code}): ${parsed.data.error.message}`
      );
    }
    throw new Error(
      `Runner request ${method} ${path} failed (${response.status}).`
    );
  }
  return response;
}

async function readJson(
  response: Response,
  description: string
): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new Error(`Runner returned invalid JSON for ${description}.`, {
      cause: error,
    });
  }
}

function parseRunEvent(payload: string): RunEvent {
  let value: unknown;
  try {
    value = JSON.parse(payload) as unknown;
  } catch (error) {
    throw new Error("Run event payload was not valid JSON.", { cause: error });
  }
  const parsed = runEventSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Run event schema validation failed.", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export async function readRunEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: RunEvent) => void,
  signal?: AbortSignal
): Promise<boolean> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  let terminal = false;
  const cancelOnAbort = () =>
    reader.cancel(signal?.reason).catch(() => undefined);
  signal?.addEventListener("abort", cancelOnAbort, { once: true });

  const dispatch = (): void => {
    if (dataLines.length === 0) {
      return;
    }
    const event = parseRunEvent(dataLines.join("\n"));
    dataLines = [];
    onEvent(event);
    terminal ||= TERMINAL_EVENT_TYPES.has(event.type);
  };

  const consumeLine = (lineWithPossibleCarriageReturn: string): void => {
    const line = lineWithPossibleCarriageReturn.endsWith("\r")
      ? lineWithPossibleCarriageReturn.slice(0, -1)
      : lineWithPossibleCarriageReturn;
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) {
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "data") {
      dataLines.push(value);
    }
  };

  try {
    while (!terminal) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      // biome-ignore lint/performance/noAwaitInLoops: SSE chunks must be consumed in order.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1 && !terminal) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (terminal) {
      await reader.cancel();
      return true;
    }
    buffer += decoder.decode();
    if (buffer) {
      consumeLine(buffer);
    }
    dispatch();
    return terminal;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

async function createTemporaryAgent(
  connection: RunnerConnection,
  operationId: string,
  signal: AbortSignal
): Promise<string> {
  const input = createAgentInputSchema.parse({
    backend: "cloud",
    description: "Temporary agent for recording a demo transcript.",
    instructions: [
      `You must clone ${DEMO_REPOSITORY_URL} into ${DEMO_REPOSITORY_WORKSPACE}.`,
      `Operate only there (${DEMO_REPOSITORY_WORKSPACE}); do not inspect, read, or modify files outside that repository.`,
      "Complete the requested task and verify the result with appropriate tests or checks before reporting.",
    ].join(" "),
    model: "auto",
    name: `demo-record-${operationId.slice(0, 8)}`,
    runtime: "copilot",
    workspace: DEMO_WORKSPACE,
  });
  const response = await fetchRunner(
    connection,
    "/api/agents",
    { body: JSON.stringify(input), method: "POST" },
    signal
  );
  const parsed = agentEnvelopeSchema.safeParse(
    await readJson(response, "agent creation")
  );
  if (!parsed.success) {
    throw new Error("Runner returned an invalid agent envelope.", {
      cause: parsed.error,
    });
  }
  return parsed.data.agent.id;
}

async function startRun(
  connection: RunnerConnection,
  agentId: string,
  operationId: string,
  task: string,
  signal: AbortSignal
): Promise<string> {
  const input = startRunInputSchema.parse({ operationId, task });
  const response = await fetchRunner(
    connection,
    `/api/agents/${encodeURIComponent(agentId)}/runs`,
    { body: JSON.stringify(input), method: "POST" },
    signal
  );
  const parsed = runSnapshotEnvelopeSchema.safeParse(
    await readJson(response, "run start")
  );
  if (!parsed.success) {
    throw new Error("Runner returned an invalid run start envelope.", {
      cause: parsed.error,
    });
  }
  return parsed.data.run.id;
}

async function collectArrivals(
  connection: RunnerConnection,
  runId: string,
  now: () => number,
  signal: AbortSignal
): Promise<ArrivedEvent[]> {
  const arrivals: ArrivedEvent[] = [];
  const seen = new Set<number>();
  let cursor = 0;
  let terminal = false;

  while (!terminal) {
    // biome-ignore lint/performance/noAwaitInLoops: reconnects are sequential and advance one SSE cursor.
    const response = await fetchRunner(
      connection,
      `/api/runs/${encodeURIComponent(runId)}/events`,
      {
        headers: {
          accept: "text/event-stream",
          "last-event-id": String(cursor),
        },
      },
      signal
    );
    if (!response.body) {
      throw new Error("Runner returned an empty run event stream.");
    }
    terminal = await readRunEventStream(
      response.body,
      (event) => {
        const arrival = { event, receivedAt: now() };
        if (seen.has(event.id)) {
          return;
        }
        if (event.id <= cursor) {
          throw new Error("Run event ids did not increase monotonically.");
        }
        seen.add(event.id);
        cursor = event.id;
        arrivals.push(arrival);
      },
      signal
    );
  }
  return arrivals;
}

async function fetchResult(
  connection: RunnerConnection,
  runId: string,
  signal: AbortSignal
): Promise<RunResult> {
  const response = await fetchRunner(
    connection,
    `/api/runs/${encodeURIComponent(runId)}`,
    {},
    signal
  );
  const parsed = runSnapshotEnvelopeSchema.safeParse(
    await readJson(response, "final run snapshot")
  );
  if (!parsed.success) {
    throw new Error("Runner returned an invalid final run envelope.", {
      cause: parsed.error,
    });
  }
  return runSnapshotToResult(parsed.data.run);
}

async function deleteTemporaryAgent(
  connection: RunnerConnection,
  agentId: string
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("Temporary agent cleanup exceeded its timeout.")
      ),
    CLEANUP_TIMEOUT_MS
  );
  try {
    const response = await fetchRunner(
      connection,
      `/api/agents/${encodeURIComponent(agentId)}`,
      { method: "DELETE" },
      controller.signal
    );
    const parsed = okEnvelopeSchema.safeParse(
      await readJson(response, "temporary agent cleanup")
    );
    if (!parsed.success) {
      throw new Error("Runner returned an invalid cleanup envelope.", {
        cause: parsed.error,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function captureRun(
  options: CaptureRunOptions,
  dependencies: CaptureDependencies = {}
): Promise<CapturedRun> {
  if (options.repository !== DEMO_REPOSITORY) {
    throw new Error(
      `Refusing capture: repository must be exactly ${DEMO_REPOSITORY}.`
    );
  }

  const configuration = readCaptureEnvironment(
    dependencies.environment ?? process.env
  );
  const connection: RunnerConnection = {
    identityToken: configuration.identityToken,
    request: dependencies.request ?? globalThis.fetch,
    runnerToken: configuration.runnerToken,
    runnerUrl: configuration.runnerUrl,
  };
  const now = dependencies.now ?? Date.now;
  const randomUUID = dependencies.randomUUID ?? crypto.randomUUID;
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(
          `Demo recording timed out after ${configuration.timeoutMs}ms.`
        )
      ),
    configuration.timeoutMs
  );
  let agentId: string | undefined;
  let captured: CapturedRun | undefined;
  let primaryError: unknown;

  try {
    const operationId = randomUUID();
    agentId = await createTemporaryAgent(
      connection,
      operationId,
      controller.signal
    );
    const runId = await startRun(
      connection,
      agentId,
      operationId,
      options.task,
      controller.signal
    );
    const arrivals = await collectArrivals(
      connection,
      runId,
      now,
      controller.signal
    );
    const result = await fetchResult(connection, runId, controller.signal);
    captured = { arrivals, result };
  } catch (error) {
    primaryError = controller.signal.aborted
      ? abortError(controller.signal)
      : error;
  } finally {
    clearTimeout(timeout);
  }

  let cleanupError: unknown;
  if (agentId) {
    try {
      await deleteTemporaryAgent(connection, agentId);
    } catch (error) {
      cleanupError = error;
    }
  }

  if (cleanupError && primaryError) {
    throw new Error(
      `Demo capture failed: ${errorMessage(primaryError)} Cleanup also failed: ${errorMessage(cleanupError)}`,
      {
        cause: new AggregateError(
          [primaryError, cleanupError],
          "Capture and cleanup both failed."
        ),
      }
    );
  }
  if (cleanupError) {
    throw cleanupError;
  }
  if (primaryError) {
    throw primaryError;
  }
  if (!captured) {
    throw new Error("Demo capture completed without a result.");
  }
  return captured;
}
