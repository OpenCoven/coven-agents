import {
  agentEnvelopeSchema,
  agentIdSchema,
  agentsEnvelopeSchema,
  createAgentInputSchema,
  KEY_ID_PATTERN,
  okEnvelopeSchema,
  type RunEvent,
  type RunnerClaims,
  type RunResult,
  runErrorEnvelopeSchema,
  runEventSchema,
  runnerClaimsSchema,
  runSnapshotEnvelopeSchema,
  runSnapshotToResult,
  sanitizeEvidenceText,
  startRunInputSchema,
} from "@opencoven/agent-contracts";
import { mintRunnerToken } from "@/lib/agents/runner-token";
import type { ArrivedEvent } from "@/lib/demo/offsets";
import { DEMO_REPOSITORY } from "@/lib/demo/recordable";
import { demoRecordingSecrets } from "@/lib/demo/recording-secrets";

const DEFAULT_RECORDING_TIMEOUT_MS = 15 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 10_000;
const MAX_SSE_RECOVERY_ATTEMPTS = 5;
const SSE_RETRY_BASE_MS = 250;
const SSE_RETRY_MAX_MS = 4000;
const DEMO_REPOSITORY_URL = "https://github.com/OpenCoven/demo-workspace.git";
const DEMO_WORKSPACE = "/workspace";
const DEMO_REPOSITORY_WORKSPACE = "/workspace/repo";
const recorderClaimsSchema = runnerClaimsSchema.omit({ exp: true, kid: true });

type Environment = Readonly<Record<string, string | undefined>>;
type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;
type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;
type FetchRunnerOptions = {
  ambiguousOnAbort?: boolean;
};

export type CaptureEnvironment = {
  identityClaims: Omit<RunnerClaims, "exp" | "kid">;
  runnerToken: string;
  runnerUrl: string;
  secrets: string[];
  signingKeyId: string;
  signingKey: string;
  timeoutMs: number;
};

export type CaptureRunOptions = {
  repository: string;
  task: string;
};

export type CapturedRun = {
  arrivals: ArrivedEvent[];
  result: RunResult;
  secrets: string[];
};

export type CaptureDependencies = {
  environment?: Environment;
  mintIdentity?: IdentityMinter;
  now?: () => number;
  randomUUID?: () => string;
  request?: FetchLike;
  sleep?: Sleep;
};

type RunnerConnection = {
  identityToken: () => Promise<string>;
  request: FetchLike;
  runnerToken: string;
  runnerUrl: string;
  secrets: string[];
};

type IdentityMinter = (
  claims: Omit<RunnerClaims, "exp" | "kid">,
  signingKey: string,
  legacyKeyId?: string
) => Promise<string>;

class RetryableSseError extends Error {
  readonly terminalObserved: boolean;

  constructor(
    message: string,
    terminalObserved: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RetryableSseError";
    this.terminalObserved = terminalObserved;
  }
}

class RunnerTransportError extends Error {
  constructor(method: string, path: string, options?: ErrorOptions) {
    super(
      `Runner request ${method} ${path} failed before receiving a response.`,
      options
    );
    this.name = "RunnerTransportError";
  }
}

class PotentialOrphanError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PotentialOrphanError";
  }
}

function nonblank(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

export function readCaptureEnvironment(
  environment: Environment
): CaptureEnvironment {
  const runnerUrl =
    environment.DEMO_RUNNER_URL ?? environment.NEXT_PUBLIC_CLOUD_RUNNER_URL;
  const runnerToken = environment.DEMO_RUNNER_TOKEN;
  const signingKey = environment.DEMO_RUNNER_SIGNING_KEY;
  const signingKeyId = environment.DEMO_RUNNER_SIGNING_KEY_ID ?? "legacy";
  const subject = environment.DEMO_RUNNER_SUBJECT;
  const tenant = environment.DEMO_RUNNER_TENANT;
  const missing: string[] = [];
  if (!nonblank(runnerUrl)) {
    missing.push("DEMO_RUNNER_URL or NEXT_PUBLIC_CLOUD_RUNNER_URL");
  }
  if (!nonblank(runnerToken)) {
    missing.push("DEMO_RUNNER_TOKEN");
  }
  if (!nonblank(signingKey)) {
    missing.push("DEMO_RUNNER_SIGNING_KEY");
  }
  if (!KEY_ID_PATTERN.test(signingKeyId)) {
    throw new Error("DEMO_RUNNER_SIGNING_KEY_ID must be a valid key id.");
  }
  if (!nonblank(subject)) {
    missing.push("DEMO_RUNNER_SUBJECT");
  }
  if (!nonblank(tenant)) {
    missing.push("DEMO_RUNNER_TENANT");
  }
  if (
    !nonblank(runnerUrl) ||
    !nonblank(runnerToken) ||
    !nonblank(signingKey) ||
    !nonblank(subject) ||
    !nonblank(tenant)
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

  const claims = recorderClaimsSchema.safeParse({
    authVersion: 0,
    plan: "subscriber",
    sub: subject,
    tenant,
  });
  if (!claims.success) {
    throw new Error(
      "DEMO_RUNNER_SUBJECT and DEMO_RUNNER_TENANT must satisfy runner identity constraints."
    );
  }

  return {
    identityClaims: claims.data,
    runnerToken,
    runnerUrl: runnerUrl.trim().replace(/\/+$/, ""),
    secrets: demoRecordingSecrets(environment),
    signingKey,
    signingKeyId,
    timeoutMs,
  };
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Demo recording was aborted.");
}

function sleepWithAbort(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      clearTimeout(timeout);
      reject(abortError(signal));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown capture failure.";
}

function sanitizedError(
  error: unknown,
  secrets: readonly string[],
  fallback: string
): Error {
  const message = error instanceof Error ? error.message : fallback;
  return new Error(sanitizeEvidenceText(message, secrets));
}

function isTerminalEvent(event: RunEvent): boolean {
  return (
    event.type === "completed" ||
    event.type === "failed" ||
    (event.type === "status" &&
      ["completed", "failed", "cancelled"].includes(event.status))
  );
}

function agentIdFromEnvelope(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("agent" in value)) {
    return undefined;
  }
  const { agent } = value;
  if (typeof agent !== "object" || agent === null || !("id" in agent)) {
    return undefined;
  }
  const parsed = agentIdSchema.safeParse(agent.id);
  return parsed.success ? parsed.data : undefined;
}

async function fetchRunner(
  connection: RunnerConnection,
  path: string,
  init: RequestInit,
  signal: AbortSignal,
  options: FetchRunnerOptions = {}
): Promise<Response> {
  const method = init.method ?? "GET";
  let identityToken: string;
  try {
    identityToken = await connection.identityToken();
  } catch (error) {
    throw new Error(
      `Runner identity could not be minted for ${method} ${path}.`,
      { cause: error }
    );
  }
  if (nonblank(identityToken) && !connection.secrets.includes(identityToken)) {
    connection.secrets.push(identityToken);
  }

  let response: Response;
  try {
    response = await connection.request(`${connection.runnerUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${identityToken}`,
        "x-runner-token": connection.runnerToken,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
      signal,
    });
  } catch (error) {
    if (signal.aborted && !options.ambiguousOnAbort) {
      throw abortError(signal);
    }
    // biome-ignore lint/style/useErrorCause: RunnerTransportError forwards this cause through its constructor.
    throw new RunnerTransportError(method, path, { cause: error });
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
    terminal ||= isTerminalEvent(event);
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
    while (true) {
      if (signal?.aborted) {
        throw abortError(signal);
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: SSE chunks must be consumed in order.
        chunk = await reader.read();
      } catch (error) {
        if (signal?.aborted) {
          throw new Error(abortError(signal).message, { cause: error });
        }
        // biome-ignore lint/style/useErrorCause: RetryableSseError forwards this cause through its constructor.
        throw new RetryableSseError(
          "Run event stream transport was interrupted.",
          terminal,
          { cause: error }
        );
      }
      const { done, value } = chunk;
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (signal?.aborted) {
      throw abortError(signal);
    }
    buffer += decoder.decode();
    if (buffer.length > 0 || dataLines.length > 0) {
      throw new RetryableSseError(
        "Run event stream ended with an incomplete frame.",
        terminal
      );
    }
    return terminal;
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort);
    reader.releaseLock();
  }
}

async function createTemporaryAgent(
  connection: RunnerConnection,
  operationId: string,
  retainAgentId: (agentId: string) => void,
  signal: AbortSignal
): Promise<string> {
  const temporaryName = `demo-record-${operationId}`;
  const input = createAgentInputSchema.parse({
    backend: "cloud",
    description: "Temporary agent for recording a demo transcript.",
    instructions: [
      `You must clone ${DEMO_REPOSITORY_URL} into ${DEMO_REPOSITORY_WORKSPACE}.`,
      `Operate only there (${DEMO_REPOSITORY_WORKSPACE}); do not inspect, read, or modify files outside that repository.`,
      "Complete the requested task and verify the result with appropriate tests or checks before reporting.",
    ].join(" "),
    model: "auto",
    name: temporaryName,
    runtime: "copilot",
    workspace: DEMO_WORKSPACE,
  });
  let response: Response;
  try {
    response = await fetchRunner(
      connection,
      "/api/agents",
      { body: JSON.stringify(input), method: "POST" },
      signal,
      { ambiguousOnAbort: true }
    );
  } catch (error) {
    if (!(error instanceof RunnerTransportError)) {
      throw error;
    }
    const recoveredId = await recoverAmbiguousCreateForCleanup(
      connection,
      temporaryName
    );
    retainAgentId(recoveredId);
    throw new Error(
      "Agent creation response was lost; recovered the exact temporary agent for cleanup.",
      { cause: error }
    );
  }
  let envelope: unknown;
  try {
    envelope = await readJson(response, "agent creation");
  } catch (error) {
    const recoveredId = await recoverAmbiguousCreateForCleanup(
      connection,
      temporaryName
    );
    retainAgentId(recoveredId);
    throw new Error(
      "Agent creation response was lost; recovered the exact temporary agent for cleanup.",
      { cause: error }
    );
  }
  const candidateId = agentIdFromEnvelope(envelope);
  if (candidateId) {
    retainAgentId(candidateId);
  }
  const parsed = agentEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new Error("Runner returned an invalid agent envelope.", {
      cause: parsed.error,
    });
  }
  return parsed.data.agent.id;
}

async function recoverAmbiguousCreateForCleanup(
  connection: RunnerConnection,
  temporaryName: string
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("Temporary agent recovery exceeded its timeout.")
      ),
    CLEANUP_TIMEOUT_MS
  );
  try {
    return await recoverAmbiguousCreate(
      connection,
      temporaryName,
      controller.signal
    );
  } finally {
    clearTimeout(timer);
  }
}

async function recoverAmbiguousCreate(
  connection: RunnerConnection,
  temporaryName: string,
  signal: AbortSignal
): Promise<string> {
  let envelope: unknown;
  try {
    const response = await fetchRunner(connection, "/api/agents", {}, signal);
    envelope = await readJson(response, "ambiguous agent creation recovery");
  } catch (error) {
    throw new PotentialOrphanError(
      "Potential orphan: agent creation response was lost and recovery listing failed.",
      { cause: error }
    );
  }

  const parsed = agentsEnvelopeSchema.safeParse(envelope);
  if (!parsed.success) {
    throw new PotentialOrphanError(
      "Potential orphan: agent creation response was lost and recovery listing failed."
    );
  }
  const matches = parsed.data.agents.filter(
    (agent) => agent.name === temporaryName
  );
  if (matches.length === 0) {
    throw new PotentialOrphanError(
      "Potential orphan: agent creation response was lost and no exact temporary name match was found."
    );
  }
  if (matches.length !== 1) {
    throw new PotentialOrphanError(
      "Potential orphan: agent creation response was lost and multiple exact temporary name matches were found; cleanup was refused."
    );
  }
  return matches[0].id;
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
  sleep: Sleep,
  signal: AbortSignal
): Promise<ArrivedEvent[]> {
  const arrivals: ArrivedEvent[] = [];
  const seen = new Set<number>();
  let cursor = 0;
  let terminal = false;
  let terminalObservedDuringRecovery = false;
  let recoveryAttempts = 0;

  while (!terminal) {
    const cursorBeforeRequest = cursor;
    try {
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
      const responseTerminal = await readRunEventStream(
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
      terminal = responseTerminal || terminalObservedDuringRecovery;
      terminalObservedDuringRecovery = false;
      recoveryAttempts = 0;
    } catch (error) {
      if (
        !(
          error instanceof RetryableSseError ||
          error instanceof RunnerTransportError
        )
      ) {
        throw error;
      }
      if (error instanceof RetryableSseError) {
        terminalObservedDuringRecovery ||= error.terminalObserved;
      }
      if (cursor > cursorBeforeRequest) {
        recoveryAttempts = 0;
      }
      recoveryAttempts += 1;
      if (recoveryAttempts > MAX_SSE_RECOVERY_ATTEMPTS) {
        throw new Error(
          "Run event stream could not be resumed after bounded retries.",
          { cause: error }
        );
      }
      const delay = Math.min(
        SSE_RETRY_BASE_MS * 2 ** (recoveryAttempts - 1),
        SSE_RETRY_MAX_MS
      );
      await sleep(delay, signal);
    }
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
  const mintIdentity = dependencies.mintIdentity ?? mintRunnerToken;
  const connection: RunnerConnection = {
    identityToken: () =>
      mintIdentity(
        configuration.identityClaims,
        configuration.signingKey,
        configuration.signingKeyId
      ),
    request: dependencies.request ?? globalThis.fetch,
    runnerToken: configuration.runnerToken,
    runnerUrl: configuration.runnerUrl,
    secrets: configuration.secrets,
  };
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? sleepWithAbort;
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
      (createdAgentId) => {
        agentId = createdAgentId;
      },
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
      sleep,
      controller.signal
    );
    const result = await fetchResult(connection, runId, controller.signal);
    captured = { arrivals, result, secrets: connection.secrets };
  } catch (error) {
    primaryError =
      error instanceof PotentialOrphanError
        ? error
        : controller.signal.aborted
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

  const safePrimaryError = primaryError
    ? sanitizedError(primaryError, configuration.secrets, "Capture failed.")
    : undefined;
  const safeCleanupError = cleanupError
    ? sanitizedError(
        cleanupError,
        configuration.secrets,
        "Temporary agent cleanup failed."
      )
    : undefined;

  if (safeCleanupError && safePrimaryError) {
    throw new Error(
      `Demo capture failed: ${errorMessage(safePrimaryError)} Cleanup also failed: ${errorMessage(safeCleanupError)}`,
      {
        cause: new AggregateError(
          [safePrimaryError, safeCleanupError],
          "Capture and cleanup both failed."
        ),
      }
    );
  }
  if (safeCleanupError) {
    throw safeCleanupError;
  }
  if (safePrimaryError) {
    throw safePrimaryError;
  }
  if (!captured) {
    throw new Error("Demo capture completed without a result.");
  }
  return captured;
}
