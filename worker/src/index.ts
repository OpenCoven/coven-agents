import { getSandbox } from "@cloudflare/sandbox";
import {
  agentIdSchema,
  createAgentInputSchema,
} from "@opencoven/agent-contracts";
import { isRunnableHarness, SUPPORTED_HARNESS_IDS } from "@opencoven/harness";
import { getAgentByName } from "agents";
import type { AgentDirectory, YoloAgent } from "./agents";
import {
  corsHeaders,
  HttpError,
  hasValidBearerToken,
  json,
  readJson,
} from "./http";
import { UNOWNED_TENANT } from "./tenant";

export { Sandbox } from "@cloudflare/sandbox";
export { AgentDirectory, YoloAgent } from "./agents";

function fail(error: unknown, cors: Headers): Response {
  if (error instanceof HttpError) {
    return json(
      { code: error.code, error: error.message },
      { status: error.status },
      cors
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return json(
      { code: "invalid_request", error: "Request validation failed." },
      { status: 400 },
      cors
    );
  }
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      event: "runner.request.failed",
    })
  );
  return json(
    { code: "internal_error", error: "Runner request failed." },
    { status: 500 },
    cors
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env.ALLOWED_ORIGIN);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors, status: 204 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ mode: "cloud", ok: true }, {}, cors);
    }

    if (!hasValidBearerToken(request, env.AGENT_CONTROL_TOKEN ?? "")) {
      return json(
        { code: "unauthorized", error: "Runner token was rejected." },
        { status: 401 },
        cors
      );
    }

    /**
     * The single shared runner token proves authorization, not identity, so
     * every caller today resolves to one tenant. The tenant is threaded through
     * ownership, listing, and sandbox keys regardless, so introducing real
     * per-user identity becomes a change to this one expression rather than a
     * search for every place isolation was assumed.
     */
    const callerTenant = UNOWNED_TENANT;

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

    if (url.pathname === "/api/harnesses" && request.method === "GET") {
      try {
        return json({ harnesses: await directory.harnesses() }, {}, cors);
      } catch (error) {
        return fail(error, cors);
      }
    }

    try {
      if (url.pathname === "/api/agents") {
        if (request.method === "GET") {
          return json({ agents: await directory.list(callerTenant) }, {}, cors);
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
          if (!isRunnableHarness(input.runtime)) {
            throw new HttpError(
              `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
              400,
              "harness_unsupported"
            );
          }
          const now = new Date().toISOString();
          const definition = {
            ...input,
            createdAt: now,
            id: crypto.randomUUID(),
            lastRunAt: null,
            owner: callerTenant,
            status: "idle" as const,
            updatedAt: now,
          };
          const agent = await getAgentByName<Env, YoloAgent>(
            env.YoloAgent,
            definition.id
          );
          await agent.configure(definition);
          await directory.upsert(definition);
          return json({ agent: definition }, { status: 201 }, cors);
        }
      }

      const match = url.pathname.match(/^\/api\/agents\/([^/]+)(?:\/(runs))?$/);
      if (match) {
        const [, rawId, action] = match;
        const id = agentIdSchema.parse(decodeURIComponent(rawId ?? ""));
        const agent = await getAgentByName<Env, YoloAgent>(env.YoloAgent, id);

        /**
         * Knowing an agent id must not be enough to reach it. Every per-agent
         * route resolves the definition first and refuses one owned by another
         * tenant, reported as 404 so the endpoint does not confirm that an id
         * exists for someone else.
         */
        const owned = await agent.snapshot();
        if (!owned || (owned.owner ?? UNOWNED_TENANT) !== callerTenant) {
          throw new HttpError("Agent was not found.", 404, "not_found");
        }

        if (!action && request.method === "GET") {
          return json({ agent: owned }, {}, cors);
        }
        if (!action && request.method === "DELETE") {
          await agent.decommission();
          await directory.remove(id);
          return json({ ok: true }, {}, cors);
        }
        if (action === "runs" && request.method === "POST") {
          const result = await agent.execute(await readJson(request));
          const definition = await agent.snapshot();
          if (definition) {
            await directory.upsert(definition);
          }
          return json({ run: result }, {}, cors);
        }
      }

      return json(
        { code: "not_found", error: "Route was not found." },
        { status: 404 },
        cors
      );
    } catch (error) {
      return fail(error, cors);
    }
  },
} satisfies ExportedHandler<Env>;
