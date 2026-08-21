import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  type AgentDefinition,
  agentIdSchema,
  createAgentInputSchema,
  type RunSnapshot,
} from "@opencoven/agent-contracts";
import {
  corsHeaders,
  errorEnvelope,
  HttpError,
  hasValidBearerToken,
  json,
  readJson,
} from "./http.js";
import { OperationConflictError } from "./run-state.js";
import {
  createRunEventStream,
  type RunEventStreamOptions,
  type RunEventStreamSnapshot,
} from "./sse.js";

type Awaitable<T> = T | Promise<T>;

export type CloudRunnerEnvironment = {
  AGENT_CONTROL_TOKEN?: string;
  ALLOWED_ORIGIN: string;
};

export type CloudRunnerDirectory = {
  list: () => Awaitable<AgentDefinition[]>;
  registerRun: (runId: string, agentId: string) => Awaitable<void>;
  remove: (agentId: string) => Awaitable<void>;
  upsert: (definition: AgentDefinition) => Awaitable<AgentDefinition>;
  lookupRun: (runId: string) => Awaitable<string | null>;
};

export type CloudRunnerAgent = {
  configure: (definition: AgentDefinition) => Awaitable<AgentDefinition>;
  decommission: () => Awaitable<void>;
  getEventStream: (
    runId: string,
    lastEventId: number
  ) => Awaitable<RunEventStreamSnapshot | null>;
  getRun: (runId: string) => Awaitable<RunSnapshot | null>;
  snapshot: () => Awaitable<AgentDefinition | null>;
  start: (input: unknown) => Awaitable<{
    created: boolean;
    run: RunSnapshot;
  }>;
  stop: (runId: string) => Awaitable<RunSnapshot | null>;
};

export type CloudRunnerDependencies<
  Environment extends CloudRunnerEnvironment,
> = {
  createEventStream?: (
    options: RunEventStreamOptions
  ) => ReadableStream<Uint8Array>;
  diagnoseSandbox?: (environment: Environment) => Awaitable<{
    exitCode: number | null;
    ok: boolean;
    output: string;
  }>;
  getDirectory: (environment: Environment) => Awaitable<CloudRunnerDirectory>;
  getYoloAgent: (
    environment: Environment,
    agentId: string
  ) => Awaitable<CloudRunnerAgent>;
};

function fail(error: unknown, cors: Headers): Response {
  if (error instanceof HttpError) {
    return json(
      errorEnvelope(error.code, error.message, error.retryable, error.details),
      { status: error.status },
      cors
    );
  }
  if (error instanceof OperationConflictError) {
    return json(
      errorEnvelope(
        "operation_conflict",
        "Operation ID was already used for a different request.",
        false
      ),
      { status: 409 },
      cors
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return json(
      errorEnvelope("invalid_request", "Request validation failed.", false),
      { status: 400 },
      cors
    );
  }
  console.error("Cloud runner request failed.");
  return json(
    errorEnvelope("internal_error", "Runner request failed.", true),
    { status: 500 },
    cors
  );
}

function parseLastEventId(request: Request): number {
  const raw = request.headers.get("last-event-id");
  if (raw === null) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(
      "Last-Event-ID must be a non-negative integer.",
      400,
      "invalid_event_cursor"
    );
  }
  return parsed;
}

function eventStream(
  stream: ReadableStream<Uint8Array>,
  cors: Headers
): Response {
  const headers = new Headers(cors);
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("x-accel-buffering", "no");
  return new Response(stream, { headers });
}

export function createCloudRunner<Environment extends CloudRunnerEnvironment>(
  dependencies: CloudRunnerDependencies<Environment>
): {
  fetch: (request: Request, environment: Environment) => Promise<Response>;
} {
  const createEventStream =
    dependencies.createEventStream ?? createRunEventStream;

  return {
    async fetch(request: Request, environment: Environment): Promise<Response> {
      const cors = corsHeaders(request, environment.ALLOWED_ORIGIN);
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: cors, status: 204 });
      }

      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        return json(
          {
            apiVersion: AGENT_RUNNER_API_VERSION,
            capabilities: [...AGENT_RUNNER_CAPABILITIES],
            minimumClientVersion: "1.0.0",
            mode: "cloud",
          },
          {},
          cors
        );
      }

      if (
        !hasValidBearerToken(request, environment.AGENT_CONTROL_TOKEN ?? "")
      ) {
        return json(
          errorEnvelope("unauthorized", "Runner token was rejected.", false),
          { status: 401 },
          cors
        );
      }

      if (
        url.pathname === "/api/diagnostics/sandbox" &&
        request.method === "POST"
      ) {
        if (!dependencies.diagnoseSandbox) {
          return json(
            errorEnvelope("not_found", "Route was not found.", false),
            { status: 404 },
            cors
          );
        }
        try {
          return json(
            await dependencies.diagnoseSandbox(environment),
            {},
            cors
          );
        } catch (error) {
          return fail(error, cors);
        }
      }

      const directory = await dependencies.getDirectory(environment);
      const yoloAgent = (agentId: string): Promise<CloudRunnerAgent> =>
        Promise.resolve(dependencies.getYoloAgent(environment, agentId));

      try {
        if (url.pathname === "/api/agents") {
          if (request.method === "GET") {
            return json({ agents: await directory.list() }, {}, cors);
          }
          if (request.method === "POST") {
            const input = createAgentInputSchema.parse(await readJson(request));
            if (input.backend !== "cloud") {
              throw new HttpError(
                "Cloud runner only accepts cloud agents.",
                400,
                "backend_mismatch"
              );
            }
            const now = new Date().toISOString();
            const definition: AgentDefinition = {
              ...input,
              createdAt: now,
              id: crypto.randomUUID(),
              lastRunAt: null,
              status: "idle",
              updatedAt: now,
            };
            const agent = await yoloAgent(definition.id);
            const configured = await agent.configure(definition);
            await directory.upsert(configured);
            return json({ agent: configured }, { status: 201 }, cors);
          }
        }

        const agentMatch = url.pathname.match(
          /^\/api\/agents\/([^/]+)(?:\/(runs))?$/
        );
        if (agentMatch) {
          const [, rawId, action] = agentMatch;
          const id = agentIdSchema.parse(decodeURIComponent(rawId ?? ""));
          const agent = await yoloAgent(id);
          const current = await agent.snapshot();
          if (!current) {
            throw new HttpError("Agent was not found.", 404, "not_found");
          }

          if (!action && request.method === "GET") {
            return json({ agent: current }, {}, cors);
          }
          if (!action && request.method === "PUT") {
            const input = createAgentInputSchema.parse(await readJson(request));
            if (input.backend !== "cloud") {
              throw new HttpError(
                "Cloud runner only accepts cloud agents.",
                400,
                "backend_mismatch"
              );
            }
            const configured = await agent.configure({
              ...input,
              createdAt: current.createdAt,
              id,
              lastRunAt: current.lastRunAt,
              status: current.status,
              updatedAt: new Date().toISOString(),
            });
            await directory.upsert(configured);
            return json({ agent: configured }, {}, cors);
          }
          if (!action && request.method === "DELETE") {
            await agent.decommission();
            await directory.remove(id);
            return json({ ok: true }, {}, cors);
          }
          if (action === "runs" && request.method === "POST") {
            const started = await agent.start(await readJson(request));
            await directory.registerRun(started.run.id, id);
            return json(
              {
                apiVersion: AGENT_RUNNER_API_VERSION,
                run: started.run,
              },
              { status: 202 },
              cors
            );
          }
        }

        const runMatch = url.pathname.match(
          /^\/api\/runs\/([^/]+)(?:\/(events|stop))?$/
        );
        if (runMatch) {
          const [, rawId, action] = runMatch;
          const runId = agentIdSchema.parse(decodeURIComponent(rawId ?? ""));
          const agentId = await directory.lookupRun(runId);
          if (!agentId) {
            throw new HttpError("Run was not found.", 404, "run_not_found");
          }
          const agent = await yoloAgent(agentId);
          if (!action && request.method === "GET") {
            const run = await agent.getRun(runId);
            if (!run) {
              throw new HttpError("Run was not found.", 404, "run_not_found");
            }
            return json(
              { apiVersion: AGENT_RUNNER_API_VERSION, run },
              {},
              cors
            );
          }
          if (action === "events" && request.method === "GET") {
            const lastEventId = parseLastEventId(request);
            const snapshot = await agent.getEventStream(runId, lastEventId);
            if (!snapshot) {
              throw new HttpError("Run was not found.", 404, "run_not_found");
            }
            return eventStream(
              createEventStream({
                lastEventId,
                read: (cursor) =>
                  Promise.resolve(agent.getEventStream(runId, cursor)),
                signal: request.signal,
              }),
              cors
            );
          }
          if (action === "stop" && request.method === "POST") {
            await readJson(request, true);
            const run = await agent.stop(runId);
            if (!run) {
              throw new HttpError("Run was not found.", 404, "run_not_found");
            }
            return json(
              { apiVersion: AGENT_RUNNER_API_VERSION, run },
              {},
              cors
            );
          }
        }

        throw new HttpError("Route was not found.", 404, "not_found");
      } catch (error) {
        return fail(error, cors);
      }
    },
  };
}
