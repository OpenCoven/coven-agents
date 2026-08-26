import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  type AgentDefinition,
  agentIdSchema,
  createAgentInputSchema,
  type RunSnapshot,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { isRunnableHarness, SUPPORTED_HARNESS_IDS } from "@opencoven/harness";
import {
  enforceWorkerEdgeLimit,
  type WorkerAbuseDecision,
  workerRouteClass,
} from "./abuse.js";
import {
  corsHeaders,
  errorEnvelope,
  HttpError,
  hasValidHeaderToken,
  json,
  readJson,
} from "./http.js";
import { importVerifyKey, verifyRunnerToken } from "./identity.js";
import { AlreadyRunningError, OperationConflictError } from "./run-state.js";
import {
  createRunEventStream,
  type RunEventStreamOptions,
  type RunEventStreamSnapshot,
} from "./sse.js";
import { tenantOf } from "./tenant.js";

type Awaitable<T> = T | Promise<T>;

export type CloudRunnerEnvironment = Omit<
  Pick<Env, "AGENT_CONTROL_TOKEN" | "ALLOWED_ORIGIN" | "RUNNER_VERIFY_KEY">,
  "ALLOWED_ORIGIN"
> & {
  ALLOWED_ORIGIN: string;
  EDGE_ABUSE_KEY_SECRET?: string;
  EDGE_REQUEST_LIMITER: RateLimit;
  TENANT_MUTATION_LIMITER: RateLimit;
  TENANT_RUN_LIMITER: RateLimit;
};

/**
 * Importing an SPKI key on every request would be wasteful, but the cache is
 * keyed on the SPKI string itself rather than unconditionally reused: a
 * rotated key must be picked up immediately, not served stale until a
 * redeploy.
 */
let verifyKeyCache: { key: CryptoKey; spki: string } | null = null;

async function getVerifyKey(spki: string): Promise<CryptoKey> {
  if (verifyKeyCache?.spki === spki) {
    return verifyKeyCache.key;
  }
  const key = await importVerifyKey(spki);
  verifyKeyCache = { key, spki };
  return key;
}

export type CloudRunnerDirectory = {
  /**
   * Takes the tenant rather than filtering at the call site, so a listing can
   * never be assembled without one. An accidental `list()` is a type error.
   */
  list: (tenantId: string) => Awaitable<AgentDefinition[]>;
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
  listRuns: () => Awaitable<RunSnapshot[]>;
  snapshot: () => Awaitable<AgentDefinition | null>;
  start: (
    input: unknown,
    identityToken: string
  ) => Awaitable<{
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

/**
 * The contract permits any harness runtime; this runner can only drive the ones
 * it actually ships. Checked at both create and update, because an update that
 * skipped it could move a working agent onto a runtime that cannot run.
 */
function assertRunnableHarness(runtime: string): void {
  if (!isRunnableHarness(runtime)) {
    throw new HttpError(
      `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
      400,
      "harness_unsupported"
    );
  }
}

function fail(error: unknown, cors: Headers): Response {
  if (error instanceof HttpError) {
    return json(
      errorEnvelope(error.code, error.message, error.retryable, error.details),
      { status: error.status },
      cors
    );
  }
  /**
   * Matched by name as well as prototype, like the ZodError branch below and
   * for the same reason: these are thrown inside the YoloAgent Durable Object,
   * and the RPC boundary preserves an error's name and message but strips its
   * prototype chain. `instanceof` was therefore false for every DO-thrown
   * instance, and a run refused because one was already active fell through to
   * the 500 catch-all — the client saw a retryable `internal_error` instead of
   * the 409 that names the actual condition, and retrying was guaranteed to
   * hit the same wall.
   */
  if (
    error instanceof OperationConflictError ||
    (error instanceof Error && error.name === "OperationConflictError")
  ) {
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
  if (
    error instanceof AlreadyRunningError ||
    (error instanceof Error && error.name === "AlreadyRunningError")
  ) {
    return json(
      errorEnvelope(
        "already_running",
        "An agent already has an active run.",
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
  /**
   * The fallback, and the only place an unrecognised failure is ever seen.
   *
   * This used to log the sentence and drop the error, so every unhandled throw
   * in the worker produced one indistinguishable line. That is what made four
   * separate defects each take a round of guesswork to find: the run reached
   * the worker, returned 500, and the log said nothing about why. An error
   * handler that destroys the error is worse than no handler, because it looks
   * like the failure was accounted for.
   *
   * Sanitised, because a thrown error can carry a credential in its message —
   * a failed fetch stringifies its request, and a harness token travels in an
   * Authorization header. `sanitizeEvidenceText` is the same redaction the run
   * evidence goes through before it is persisted.
   */
  const detail =
    error instanceof Error
      ? {
          message: sanitizeEvidenceText(error.message),
          name: error.name,
          stack: error.stack ? sanitizeEvidenceText(error.stack) : undefined,
        }
      : { message: sanitizeEvidenceText(String(error)), name: "UnknownError" };

  console.error("Cloud runner request failed.", detail);

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

function abuseResponse(
  decision: WorkerAbuseDecision,
  cors: Headers
): Response | null {
  if (decision.kind === "allowed") {
    return null;
  }
  const headers = new Headers({
    "cache-control": "no-store",
  });
  if (decision.kind === "limited") {
    headers.set("retry-after", String(decision.retryAfterSeconds));
    return json(
      errorEnvelope(
        "rate_limited",
        "Too many requests. Try again later.",
        true
      ),
      { headers, status: 429 },
      cors
    );
  }
  return json(
    errorEnvelope("abuse_control_unavailable", "Please try again later.", true),
    { headers, status: 503 },
    cors
  );
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
      const routeClass = workerRouteClass(request.method, url.pathname);
      const sourceAdmission = abuseResponse(
        await enforceWorkerEdgeLimit({
          env: environment,
          ip: request.headers.get("cf-connecting-ip"),
          routeClass,
          stage: "source",
        }),
        cors
      );
      if (sourceAdmission) {
        return sourceAdmission;
      }

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
        !hasValidHeaderToken(
          request,
          "x-runner-token",
          environment.AGENT_CONTROL_TOKEN ?? ""
        )
      ) {
        return json(
          errorEnvelope("unauthorized", "Runner token was rejected.", false),
          { status: 401 },
          cors
        );
      }

      /**
       * Identity and authorization are now two different tokens on two
       * different headers, on purpose. `X-Runner-Token` above proves only
       * that the caller may reach this worker at all — it is a coarse
       * deployment gate, and no tenant may ever be derived from it. Identity
       * comes from `Authorization: Bearer <token>`: a claim signed by a key
       * this worker can verify but not mint, so the worker can trust the
       * `tenant` inside it without being able to forge one itself. If the
       * worker cannot verify identity — no verify key configured — it must
       * refuse rather than fall back to a default tenant.
       */
      if (!environment.RUNNER_VERIFY_KEY) {
        return json(
          errorEnvelope("unauthorized", "Identity cannot be verified.", false),
          { status: 401 },
          cors
        );
      }
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) {
        return json(
          errorEnvelope("unauthorized", "Identity was rejected.", false),
          { status: 401 },
          cors
        );
      }
      const claims = await verifyRunnerToken(
        authorization.slice(7),
        await getVerifyKey(environment.RUNNER_VERIFY_KEY)
      );
      if (!claims) {
        return json(
          errorEnvelope("unauthorized", "Identity was rejected.", false),
          { status: 401 },
          cors
        );
      }
      const callerTenant = claims.tenant;
      const tenantAdmission = abuseResponse(
        await enforceWorkerEdgeLimit({
          env: environment,
          ip: request.headers.get("cf-connecting-ip"),
          routeClass,
          stage: "tenant",
          tenant: callerTenant,
        }),
        cors
      );
      if (tenantAdmission) {
        return tenantAdmission;
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

      try {
        // Resolved inside the try: a Durable Object binding failure here would
        // otherwise escape `fail()` and return a bare platform 500, with no
        // error envelope and no CORS headers, so the browser would report it as
        // a network error rather than the failure it is.
        const directory = await dependencies.getDirectory(environment);
        const yoloAgent = (agentId: string): Promise<CloudRunnerAgent> =>
          Promise.resolve(dependencies.getYoloAgent(environment, agentId));

        if (url.pathname === "/api/agents") {
          if (request.method === "GET") {
            return json(
              { agents: await directory.list(callerTenant) },
              {},
              cors
            );
          }
          if (request.method === "POST") {
            const input = createAgentInputSchema.parse(await readJson(request));
            assertRunnableHarness(input.runtime);
            const now = new Date().toISOString();
            const definition: AgentDefinition = {
              ...input,
              createdAt: now,
              id: crypto.randomUUID(),
              lastRunAt: null,
              // Ownership is stamped from the caller, never from the request:
              // createAgentInputSchema omits `owner` and is strict, so a
              // submitted one is rejected rather than reaching this spread.
              owner: { kind: "tenant", tenantId: callerTenant },
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
          /**
           * Knowing an agent id must not be enough to reach it. A definition
           * owned by another tenant is reported as 404 rather than 403, so the
           * endpoint does not confirm that the id exists for someone else.
           */
          if (!current || tenantOf(current) !== callerTenant) {
            throw new HttpError("Agent was not found.", 404, "not_found");
          }

          if (!action && request.method === "GET") {
            return json({ agent: current }, {}, cors);
          }
          if (!action && request.method === "PUT") {
            const input = createAgentInputSchema.parse(await readJson(request));
            assertRunnableHarness(input.runtime);
            const configured = await agent.configure({
              ...input,
              createdAt: current.createdAt,
              id,
              lastRunAt: current.lastRunAt,
              // An update must never move an agent between tenants, so the
              // stored owner is carried forward rather than taken from the
              // request or re-derived.
              owner: current.owner,
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
          if (action === "runs" && request.method === "GET") {
            // The retained history (terminal runs plus any live one), newest
            // first. Without this a console refresh forgets every run the
            // agent still remembers.
            return json(
              {
                apiVersion: AGENT_RUNNER_API_VERSION,
                runs: await agent.listRuns(),
              },
              {},
              cors
            );
          }
          if (action === "runs" && request.method === "POST") {
            // The plan is enforced before the run, not only when the
            // credential is fetched. A lapsed user is issued a fresh `demo`
            // claim, and without this a run would start and fail late — or
            // succeed outright if a credential were still stored.
            if (claims.plan !== "subscriber") {
              return json(
                errorEnvelope(
                  "subscription_required",
                  "Starting a run needs an active subscription.",
                  false
                ),
                { status: 403 },
                cors
              );
            }
            const started = await agent.start(
              await readJson(request),
              authorization.slice(7)
            );
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
          /**
           * A run id resolves to an agent, so reaching a run without checking
           * that agent's owner would let anyone holding an id read, stream or
           * cancel another tenant's run. The ownership check belongs here,
           * before the action, not on the agent routes alone.
           */
          const owning = await agent.snapshot();
          if (!owning || tenantOf(owning) !== callerTenant) {
            throw new HttpError("Run was not found.", 404, "run_not_found");
          }
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
