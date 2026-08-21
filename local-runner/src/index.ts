import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  AGENT_RUNNER_LIMITS,
  type AgentDefinition,
  agentIdSchema,
  createAgentInputSchema,
  type RunError,
  type RunEvent,
  type RunSnapshot,
  sanitizeEvidenceText,
  startRunInputSchema,
} from "@opencoven/agent-contracts";
import { z } from "zod";
import { RunEventBroker } from "./event-broker.js";
import {
  MAX_EVENTS_PER_RUN,
  RunStore,
  type StoredRun,
  truncateRunText,
} from "./run-store.js";
import {
  buildInvocation,
  type Invocation,
  resolveSecureWorkspace,
} from "./runtime.js";
import { AgentStore } from "./store.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_PER_RUN = 20;

type TerminationReason = "output_limit" | "stop" | "timeout";

type LiveRun = {
  child: ChildProcess;
  terminationReason?: TerminationReason;
};

export type LocalRunnerOptions = {
  allowedOrigin?: string;
  root: string;
  runStorePath?: string;
  runTimeoutMs?: number;
  spawn?: typeof nodeSpawn;
  storePath: string;
  token: string;
};

class RequestError extends Error {
  readonly code: string;
  readonly details?: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    message: string,
    status: number,
    code: string,
    options: { cause?: unknown; details?: string; retryable?: boolean } = {}
  ) {
    super(message, { cause: options.cause });
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
    this.status = status;
  }
}

function isTerminal(status: RunSnapshot["status"]): boolean {
  return status !== "queued" && status !== "running";
}

function nextEventId(record: StoredRun): number {
  return (record.events.at(-1)?.id ?? 0) + 1;
}

function withEvents(record: StoredRun, events: RunEvent[]): StoredRun {
  return {
    ...record,
    events: [...record.events, ...events].slice(-MAX_EVENTS_PER_RUN),
  };
}

function sanitizeLocalEvidence(value: string, token: string): string {
  return sanitizeEvidenceText(value, token ? [token] : []).replace(
    /(^|\r?\n)(?:(?:export|declare -x)\s+)?[A-Za-z_][A-Za-z0-9_]*=[^\r\n]*/gmu,
    "$1[environment assignment redacted]"
  );
}

function appendOutput(
  current: string,
  addition: string,
  token: string
): string {
  return truncateRunText(
    sanitizeLocalEvidence(current ? `${current}${addition}` : addition, token)
  );
}

function truncateCommand(value: string): string {
  if (value.length <= AGENT_RUNNER_LIMITS.maxCommandLength) {
    return value;
  }
  const suffix = "\n[command truncated by runner]";
  return `${value.slice(0, AGENT_RUNNER_LIMITS.maxCommandLength - suffix.length)}${suffix}`;
}

function operationHash(agentId: string, task: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ agentId, task }))
    .digest("hex");
}

function sameToken(supplied: string, expected: string): boolean {
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

function parseLastEventId(request: IncomingMessage): number {
  const value = request.headers["last-event-id"];
  if (value === undefined) {
    return 0;
  }
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RequestError(
      "Last-Event-ID must be a non-negative integer.",
      400,
      "invalid_event_cursor"
    );
  }
  return parsed;
}

async function readJson(
  request: IncomingMessage,
  allowEmpty = false
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new RequestError(
        "Request body is too large.",
        413,
        "body_too_large"
      );
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (allowEmpty && !body) {
    return null;
  }
  try {
    return JSON.parse(body) as unknown;
  } catch (error) {
    // biome-ignore lint/style/useErrorCause: RequestError forwards cause through its options.
    throw new RequestError(
      "Request body must be valid JSON.",
      400,
      "invalid_json",
      { cause: error }
    );
  }
}

function setCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigin: string
): void {
  if (request.headers.origin === allowedOrigin) {
    response.setHeader("access-control-allow-origin", allowedOrigin);
  }
  response.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, last-event-id"
  );
  response.setHeader(
    "access-control-allow-methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  response.setHeader("vary", "Origin");
}

function sendJson(
  response: ServerResponse,
  value: unknown,
  status = 200
): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function toRunError(
  code: string,
  message: string,
  retryable = false,
  details?: string
): RunError {
  return {
    code: code.slice(0, 64),
    ...(details
      ? { details: details.slice(0, AGENT_RUNNER_LIMITS.maxDetailsLength) }
      : {}),
    message: message.slice(0, AGENT_RUNNER_LIMITS.maxMessageLength),
    retryable,
  };
}

function sendError(
  response: ServerResponse,
  status: number,
  error: RunError
): void {
  sendJson(
    response,
    {
      apiVersion: AGENT_RUNNER_API_VERSION,
      error,
      requestId: randomUUID(),
    },
    status
  );
}

function authorized(request: IncomingMessage, token: string): boolean {
  const { authorization } = request.headers;
  if (!authorization?.startsWith("Bearer ") || !token) {
    return false;
  }
  return sameToken(authorization.slice(7), token);
}

export function createLocalRunner(options: LocalRunnerOptions): {
  initialize: () => Promise<void>;
  server: Server;
} {
  const allowedOrigin = options.allowedOrigin ?? "http://localhost:3000";
  const root = resolve(options.root);
  const store = new AgentStore(options.storePath);
  const runStore = new RunStore(
    options.runStorePath ?? resolve(dirname(options.storePath), "runs.json")
  );
  const spawn = options.spawn ?? nodeSpawn;
  const runTimeoutMs = options.runTimeoutMs ?? 900_000;
  const liveRuns = new Map<string, LiveRun>();
  const activeRunByAgent = new Map<string, string>();
  const launchingAgents = new Set<string>();
  const stopRequested = new Set<string>();
  const eventBroker = new RunEventBroker();

  function runInBackground(task: Promise<void>): void {
    task.catch(() => {
      console.error("Local runner background work failed.");
    });
  }

  function updateRun(
    runId: string,
    change: (record: StoredRun) => StoredRun
  ): Promise<StoredRun | null> {
    return eventBroker.update(runId, async () => {
      let events: RunEvent[] = [];
      const record = await runStore.update(runId, (current) => {
        const previousId = current.events.at(-1)?.id ?? 0;
        const next = change(current);
        events = next.events.filter((event) => event.id > previousId);
        return next;
      });
      return {
        events,
        terminal: record ? isTerminal(record.run.status) : false,
        value: record,
      };
    });
  }

  async function refreshAgentStatus(agentId: string): Promise<void> {
    const definition = await store.get(agentId);
    if (!definition) {
      return;
    }
    const runs = await runStore.listForAgent(agentId);
    const active = runs.some((record) => !isTerminal(record.run.status));
    const [latest] = [...runs].sort(
      (left, right) =>
        Date.parse(right.run.completedAt ?? right.run.createdAt) -
        Date.parse(left.run.completedAt ?? left.run.createdAt)
    );
    const now = new Date().toISOString();
    await store.upsert({
      ...definition,
      lastRunAt: latest?.run.completedAt ?? definition.lastRunAt,
      status: active
        ? "running"
        : latest?.run.status === "failed"
          ? "error"
          : "idle",
      updatedAt: now,
    });
  }

  function finishRun(
    runId: string,
    result: {
      command?: string;
      completedAt: string;
      diagnostic?: string;
      error?: RunError;
      exitCode: number | null;
      status: Extract<
        RunSnapshot["status"],
        "cancelled" | "completed" | "failed"
      >;
      stderr: string;
      stdout: string;
    }
  ): Promise<StoredRun | null> {
    return updateRun(runId, (record) => {
      if (isTerminal(record.run.status)) {
        return record;
      }
      const output = result.diagnostic
        ? appendOutput(
            record.run.output,
            `\n${result.diagnostic}`,
            options.token
          )
        : record.run.output;
      const commandEvidence = [
        ...record.run.commandEvidence,
        {
          command: truncateCommand(
            sanitizeLocalEvidence(result.command ?? "local-cli", options.token)
          ),
          completedAt: result.completedAt,
          exitCode: result.exitCode,
          startedAt: record.run.startedAt ?? record.run.createdAt,
          stderr: truncateRunText(
            sanitizeLocalEvidence(result.stderr, options.token)
          ),
          stdout: truncateRunText(
            sanitizeLocalEvidence(result.stdout, options.token)
          ),
        },
      ].slice(-MAX_EVIDENCE_PER_RUN);
      const run: RunSnapshot = {
        ...record.run,
        commandEvidence,
        completedAt: result.completedAt,
        ...(result.error ? { error: result.error } : {}),
        output: truncateRunText(output),
        status: result.status,
      };
      const statusEvent: RunEvent = {
        at: result.completedAt,
        id: nextEventId(record),
        status: result.status,
        type: "status",
      };
      const base = withEvents({ ...record, run }, [statusEvent]);
      if (result.status === "failed" && result.error) {
        return withEvents(base, [
          {
            at: result.completedAt,
            error: result.error,
            id: nextEventId(base),
            type: "failed",
          },
        ]);
      }
      if (result.status === "completed") {
        return withEvents(base, [
          {
            at: result.completedAt,
            id: nextEventId(base),
            run,
            type: "completed",
          },
        ]);
      }
      return base;
    });
  }

  async function completeQueuedCancellation(runId: string): Promise<void> {
    const completedAt = new Date().toISOString();
    await finishRun(runId, {
      completedAt,
      diagnostic: "Run cancelled before local CLI execution began.",
      exitCode: null,
      status: "cancelled",
      stderr: "",
      stdout: "",
    });
  }

  async function executeQueuedRun(
    definition: AgentDefinition,
    runId: string
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const started = await updateRun(runId, (record) => {
      if (record.run.status !== "queued") {
        return record;
      }
      const event: RunEvent = {
        at: startedAt,
        id: nextEventId(record),
        status: "running",
        type: "status",
      };
      return withEvents(
        {
          ...record,
          run: {
            ...record.run,
            startedAt,
            status: "running",
          },
        },
        [event]
      );
    });

    if (started?.run.status !== "running") {
      return;
    }
    await refreshAgentStatus(definition.id);

    if (stopRequested.has(runId)) {
      await completeQueuedCancellation(runId);
      stopRequested.delete(runId);
      await refreshAgentStatus(definition.id);
      return;
    }

    let invocation: Invocation;
    try {
      invocation = buildInvocation(definition, started.run.task, root);
      invocation.cwd = resolveSecureWorkspace(root, definition.workspace);
    } catch {
      const completedAt = new Date().toISOString();
      await finishRun(runId, {
        command: definition.runtime,
        completedAt,
        diagnostic: "The configured workspace could not be used safely.",
        error: toRunError(
          "invalid_workspace",
          "Configured workspace is unavailable.",
          false
        ),
        exitCode: null,
        status: "failed",
        stderr: "",
        stdout: "",
      });
      await refreshAgentStatus(definition.id);
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      const completedAt = new Date().toISOString();
      await finishRun(runId, {
        command: invocation.command,
        completedAt,
        diagnostic: "The configured local CLI could not be started.",
        error: toRunError(
          "cli_unavailable",
          "Local CLI could not start.",
          false
        ),
        exitCode: null,
        status: "failed",
        stderr: "",
        stdout: "",
      });
      await refreshAgentStatus(definition.id);
      return;
    }

    const live: LiveRun = { child };
    liveRuns.set(runId, live);
    activeRunByAgent.set(definition.id, runId);
    if (stopRequested.has(runId)) {
      live.terminationReason = "stop";
      child.kill("SIGTERM");
    }

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let writes = Promise.resolve();
    const collect = (target: "stderr" | "stdout", chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        if (!live.terminationReason) {
          live.terminationReason = "output_limit";
          child.kill("SIGTERM");
        }
        return;
      }
      const text = sanitizeLocalEvidence(chunk.toString("utf8"), options.token);
      if (target === "stdout") {
        stdout = appendOutput(stdout, text, options.token);
      } else {
        stderr = appendOutput(stderr, text, options.token);
      }
      writes = writes.then(async () => {
        await updateRun(runId, (record) => {
          const event: RunEvent = {
            at: new Date().toISOString(),
            id: nextEventId(record),
            output: truncateRunText(text),
            type: "output",
          };
          return withEvents(
            {
              ...record,
              run: {
                ...record.run,
                output: appendOutput(record.run.output, text, options.token),
              },
            },
            [event]
          );
        });
      });
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));

    const timer = setTimeout(() => {
      if (!live.terminationReason) {
        live.terminationReason = "timeout";
        child.kill("SIGTERM");
      }
    }, runTimeoutMs);

    const outcome = await new Promise<{
      error?: Error;
      exitCode: number | null;
    }>((resolveOutcome) => {
      child.once("error", (error) => {
        resolveOutcome({
          error:
            error instanceof Error ? error : new Error("Local CLI failed."),
          exitCode: null,
        });
      });
      child.once("close", (exitCode) => resolveOutcome({ exitCode }));
    });
    clearTimeout(timer);
    await writes;

    const completedAt = new Date().toISOString();
    const reason = live.terminationReason;
    if (reason === "stop") {
      await finishRun(runId, {
        command: invocation.command,
        completedAt,
        diagnostic: "Run cancelled by operator request.",
        exitCode: outcome.exitCode,
        status: "cancelled",
        stderr,
        stdout,
      });
    } else if (reason === "timeout") {
      await finishRun(runId, {
        command: invocation.command,
        completedAt,
        diagnostic: "Runner stopped the process after the configured timeout.",
        error: toRunError(
          "timeout",
          "Run exceeded the configured timeout.",
          true
        ),
        exitCode: outcome.exitCode,
        status: "failed",
        stderr,
        stdout,
      });
    } else if (reason === "output_limit") {
      await finishRun(runId, {
        command: invocation.command,
        completedAt,
        diagnostic: "Runner stopped the process after the output limit.",
        error: toRunError(
          "output_limit",
          "Run exceeded the captured output limit.",
          false
        ),
        exitCode: outcome.exitCode,
        status: "failed",
        stderr,
        stdout,
      });
    } else if (outcome.error) {
      await finishRun(runId, {
        command: invocation.command,
        completedAt,
        diagnostic: sanitizeLocalEvidence(outcome.error.message, options.token),
        error: toRunError(
          "cli_unavailable",
          "Local CLI could not start.",
          false
        ),
        exitCode: null,
        status: "failed",
        stderr,
        stdout,
      });
    } else if (outcome.exitCode === 0) {
      await finishRun(runId, {
        command: invocation.command,
        completedAt,
        exitCode: outcome.exitCode,
        status: "completed",
        stderr,
        stdout,
      });
    } else {
      await finishRun(runId, {
        command: invocation.command,
        completedAt,
        diagnostic: "Local CLI exited unsuccessfully.",
        error: toRunError(
          "runner_failed",
          "Local CLI execution failed.",
          false
        ),
        exitCode: outcome.exitCode,
        status: "failed",
        stderr,
        stdout,
      });
    }

    liveRuns.delete(runId);
    activeRunByAgent.delete(definition.id);
    stopRequested.delete(runId);
    await refreshAgentStatus(definition.id);
    runInBackground(startNext(definition.id));
  }

  async function startNext(agentId: string): Promise<void> {
    if (launchingAgents.has(agentId) || activeRunByAgent.has(agentId)) {
      return;
    }
    launchingAgents.add(agentId);
    try {
      const definition = await store.get(agentId);
      const queued = await runStore.findFirstByAgentStatus(agentId, "queued");
      if (!queued) {
        return;
      }
      if (!definition) {
        const completedAt = new Date().toISOString();
        await finishRun(queued.run.id, {
          completedAt,
          diagnostic: "Agent profile was removed before this run started.",
          error: toRunError(
            "agent_not_found",
            "Agent profile was removed.",
            false
          ),
          exitCode: null,
          status: "failed",
          stderr: "",
          stdout: "",
        });
        return;
      }
      await executeQueuedRun(definition, queued.run.id);
    } finally {
      launchingAgents.delete(agentId);
      const queued = await runStore.findFirstByAgentStatus(agentId, "queued");
      if (queued && !activeRunByAgent.has(agentId)) {
        runInBackground(startNext(agentId));
      }
    }
  }

  async function stopRun(runId: string): Promise<StoredRun | null> {
    const record = await runStore.get(runId);
    if (!record || isTerminal(record.run.status)) {
      return record;
    }
    stopRequested.add(runId);
    if (record.run.status === "queued") {
      await completeQueuedCancellation(runId);
      stopRequested.delete(runId);
      await refreshAgentStatus(record.run.agentId);
      return runStore.get(runId);
    }
    const live = liveRuns.get(runId);
    if (live && !live.terminationReason) {
      live.terminationReason = "stop";
      live.child.kill("SIGTERM");
    }
    return runStore.get(runId);
  }

  const server = createServer(async (request, response) => {
    setCors(request, response, allowedOrigin);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    if (request.method === "GET" && request.url === "/api/health") {
      sendJson(response, {
        apiVersion: AGENT_RUNNER_API_VERSION,
        capabilities: [...AGENT_RUNNER_CAPABILITIES],
        minimumClientVersion: "1.0.0",
        mode: "local",
      });
      return;
    }
    if (!authorized(request, options.token)) {
      sendError(
        response,
        401,
        toRunError("unauthorized", "Runner token was rejected.", false)
      );
      return;
    }

    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/agents") {
        if (request.method === "GET") {
          sendJson(response, { agents: await store.list() });
          return;
        }
        if (request.method === "POST") {
          const input = createAgentInputSchema.parse(await readJson(request));
          if (input.backend !== "local") {
            throw new RequestError(
              "Local runner only accepts local agents.",
              400,
              "backend_mismatch"
            );
          }
          const now = new Date().toISOString();
          const definition: AgentDefinition = {
            ...input,
            createdAt: now,
            id: randomUUID(),
            lastRunAt: null,
            status: "idle",
            updatedAt: now,
          };
          buildInvocation(definition, "Validate configuration.", root);
          resolveSecureWorkspace(root, definition.workspace);
          await store.upsert(definition);
          sendJson(response, { agent: definition }, 201);
          return;
        }
      }

      const agentMatch = url.pathname.match(
        /^\/api\/agents\/([^/]+)(?:\/(runs))?$/
      );
      if (agentMatch) {
        const [, rawId, action] = agentMatch;
        const id = agentIdSchema.parse(decodeURIComponent(rawId ?? ""));
        const agent = await store.get(id);
        if (!agent) {
          throw new RequestError("Agent was not found.", 404, "not_found");
        }
        if (!action && request.method === "GET") {
          sendJson(response, { agent });
          return;
        }
        if (!action && request.method === "PUT") {
          const input = createAgentInputSchema.parse(await readJson(request));
          if (input.backend !== "local") {
            throw new RequestError(
              "Local runner only accepts local agents.",
              400,
              "backend_mismatch"
            );
          }
          const updated: AgentDefinition = {
            ...input,
            createdAt: agent.createdAt,
            id: agent.id,
            lastRunAt: agent.lastRunAt,
            status: agent.status,
            updatedAt: new Date().toISOString(),
          };
          buildInvocation(updated, "Validate configuration.", root);
          resolveSecureWorkspace(root, updated.workspace);
          await store.upsert(updated);
          sendJson(response, { agent: updated });
          return;
        }
        if (!action && request.method === "DELETE") {
          const runs = await runStore.listForAgent(id);
          await Promise.all(runs.map((record) => stopRun(record.run.id)));
          await store.remove(id);
          sendJson(response, { ok: true });
          return;
        }
        if (action === "runs" && request.method === "POST") {
          const input = startRunInputSchema.parse(await readJson(request));
          const createdAt = new Date().toISOString();
          const run: RunSnapshot = {
            agentId: agent.id,
            apiVersion: AGENT_RUNNER_API_VERSION,
            commandEvidence: [],
            completedAt: null,
            createdAt,
            fileEvidence: [],
            id: randomUUID(),
            operationId: input.operationId,
            output: "",
            startedAt: null,
            status: "queued",
            task: input.task,
          };
          const created = await runStore.createOrGet({
            events: [
              {
                at: createdAt,
                id: 1,
                operationId: input.operationId,
                runId: run.id,
                type: "accepted",
              },
            ],
            operationHash: operationHash(agent.id, input.task),
            run,
          });
          if (created.kind === "conflict") {
            throw new RequestError(
              "Operation ID was already used for a different request.",
              409,
              "operation_conflict"
            );
          }
          sendJson(
            response,
            {
              apiVersion: AGENT_RUNNER_API_VERSION,
              run: created.record.run,
            },
            202
          );
          if (created.kind === "created") {
            queueMicrotask(() => {
              runInBackground(startNext(agent.id));
            });
          }
          return;
        }
      }

      const runMatch = url.pathname.match(
        /^\/api\/runs\/([^/]+)(?:\/(events|stop))?$/
      );
      if (runMatch) {
        const [, rawId, action] = runMatch;
        const runId = agentIdSchema.parse(decodeURIComponent(rawId ?? ""));
        if (!action && request.method === "GET") {
          const record = await runStore.get(runId);
          if (!record) {
            throw new RequestError("Run was not found.", 404, "run_not_found");
          }
          sendJson(response, {
            apiVersion: AGENT_RUNNER_API_VERSION,
            run: record.run,
          });
          return;
        }
        if (action === "events" && request.method === "GET") {
          const record = await runStore.get(runId);
          if (!record) {
            throw new RequestError("Run was not found.", 404, "run_not_found");
          }
          const lastEventId = parseLastEventId(request);
          response.statusCode = 200;
          response.setHeader("cache-control", "no-cache");
          response.setHeader("connection", "keep-alive");
          response.setHeader(
            "content-type",
            "text/event-stream; charset=utf-8"
          );
          response.setHeader("x-accel-buffering", "no");
          response.write(": connected\n\n");
          request.once("close", () => {
            eventBroker.unsubscribe(runId, response);
          });
          await eventBroker.subscribe(
            runId,
            lastEventId,
            async () => {
              const current = await runStore.get(runId);
              return {
                events: current?.events ?? [],
                terminal: current ? isTerminal(current.run.status) : true,
              };
            },
            response
          );
          return;
        }
        if (action === "stop" && request.method === "POST") {
          await readJson(request, true);
          const record = await stopRun(runId);
          if (!record) {
            throw new RequestError("Run was not found.", 404, "run_not_found");
          }
          sendJson(response, {
            apiVersion: AGENT_RUNNER_API_VERSION,
            run: record.run,
          });
          return;
        }
      }

      throw new RequestError("Route was not found.", 404, "not_found");
    } catch (error) {
      if (error instanceof RequestError) {
        sendError(
          response,
          error.status,
          toRunError(error.code, error.message, error.retryable, error.details)
        );
        return;
      }
      if (error instanceof z.ZodError) {
        sendError(
          response,
          400,
          toRunError("invalid_request", "Request validation failed.", false)
        );
        return;
      }
      console.error("Local runner request failed.");
      sendError(
        response,
        500,
        toRunError("internal_error", "Runner request failed.", true)
      );
    }
  });

  return {
    async initialize(): Promise<void> {
      const recovered = await runStore.recoverInterrupted();
      await Promise.all(
        recovered.map((record) => refreshAgentStatus(record.run.agentId))
      );
    },
    server,
  };
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  const token = process.env.OPENCOVEN_LOCAL_TOKEN ?? "";
  if (!token) {
    throw new Error("OPENCOVEN_LOCAL_TOKEN is required.");
  }
  const port = Number(process.env.OPENCOVEN_LOCAL_PORT ?? "7331");
  const root = resolve(process.env.OPENCOVEN_LOCAL_ROOT ?? process.cwd());
  const storePath = resolve(
    process.env.OPENCOVEN_AGENT_STORE ?? ".opencoven/agents.json"
  );
  const runner = createLocalRunner({
    allowedOrigin: process.env.OPENCOVEN_ALLOWED_ORIGIN,
    root,
    runStorePath: process.env.OPENCOVEN_RUN_STORE
      ? resolve(process.env.OPENCOVEN_RUN_STORE)
      : undefined,
    runTimeoutMs: Number(process.env.OPENCOVEN_RUN_TIMEOUT_MS ?? "900000"),
    storePath,
    token,
  });
  runner
    .initialize()
    .then(() => {
      runner.server.listen(port, "127.0.0.1", () => {
        console.log(
          JSON.stringify({
            event: "opencoven.local_runner.started",
            root,
            store: storePath,
            url: `http://127.0.0.1:${port}`,
          })
        );
      });
    })
    .catch(() => {
      console.error("Local runner failed to initialize.");
      process.exitCode = 1;
    });
}
