import { getSandbox } from "@cloudflare/sandbox";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  agentIdSchema,
  createAgentInputSchema,
} from "@opencoven/agent-contracts";
import { getAgentByName } from "agents";
import {
  type AgentDirectory,
  OperationConflictError,
  type YoloAgent,
} from "./agents.js";
import {
  corsHeaders,
  errorEnvelope,
  HttpError,
  hasValidBearerToken,
  json,
  readJson,
  serializeSse,
} from "./http.js";

export { Sandbox } from "@cloudflare/sandbox";
export { AgentDirectory, YoloAgent } from "./agents.js";

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

function eventStream(
  events: Parameters<typeof serializeSse>[0],
  lastEventId: number,
  cors: Headers
): Response {
  const headers = new Headers(cors);
  headers.set("cache-control", "no-cache");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("x-accel-buffering", "no");
  return new Response(serializeSse(events, lastEventId), { headers });
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

function yoloAgent(
  env: Env,
  agentId: string
): Promise<DurableObjectStub<YoloAgent>> {
  return getAgentByName<Env, YoloAgent>(env.YoloAgent, agentId);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env.ALLOWED_ORIGIN);
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

    if (!hasValidBearerToken(request, env.AGENT_CONTROL_TOKEN ?? "")) {
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
      const sandbox = getSandbox(env.Sandbox, "deployment-diagnostic", {
        enableDefaultSession: false,
        sleepAfter: "30s",
      });
      try {
        const result = await sandbox.exec("printf coven-agents");
        return json(
          {
            exitCode: result.exitCode,
            ok: result.success && result.stdout === "coven-agents",
            output: result.stdout,
          },
          {},
          cors
        );
      } catch (error) {
        return fail(error, cors);
      }
    }

    const directory = await getAgentByName<Env, AgentDirectory>(
      env.AgentDirectory,
      "default"
    );

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
          const definition = {
            ...input,
            createdAt: now,
            id: crypto.randomUUID(),
            lastRunAt: null,
            status: "idle" as const,
            updatedAt: now,
          };
          const agent = await yoloAgent(env, definition.id);
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
        const agent = await yoloAgent(env, id);
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
        const agent = await yoloAgent(env, agentId);
        if (!action && request.method === "GET") {
          const run = await agent.getRun(runId);
          if (!run) {
            throw new HttpError("Run was not found.", 404, "run_not_found");
          }
          return json({ apiVersion: AGENT_RUNNER_API_VERSION, run }, {}, cors);
        }
        if (action === "events" && request.method === "GET") {
          const events = await agent.getEvents(
            runId,
            parseLastEventId(request)
          );
          if (!events) {
            throw new HttpError("Run was not found.", 404, "run_not_found");
          }
          return eventStream(events, parseLastEventId(request), cors);
        }
        if (action === "stop" && request.method === "POST") {
          await readJson(request, true);
          const run = await agent.stop(runId);
          if (!run) {
            throw new HttpError("Run was not found.", 404, "run_not_found");
          }
          return json({ apiVersion: AGENT_RUNNER_API_VERSION, run }, {}, cors);
        }
      }

      throw new HttpError("Route was not found.", 404, "not_found");
    } catch (error) {
      return fail(error, cors);
    }
  },
} satisfies ExportedHandler<Env>;
