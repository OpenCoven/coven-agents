import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  type AgentDefinition,
  agentIdSchema,
  createAgentInputSchema,
  type RunSnapshot,
  sanitizeEvidenceText,
  startRunInputSchema,
  type WarmState,
} from "@opencoven/agent-contracts";
import { isRunnableHarness, SUPPORTED_HARNESS_IDS } from "@opencoven/harness";
import {
  enforceWorkerEdgeLimit,
  type WorkerAbuseDecision,
  workerRouteClass,
} from "./abuse.js";
import {
  type AdmissionDecision,
  type AdmissionRecord,
  type AdmissionRequest,
  AdmissionUnavailableError,
  admissionMode,
  tenantAdmissionHash,
} from "./admission.js";
import {
  corsHeaders,
  errorEnvelope,
  HttpError,
  hasValidHeaderToken,
  json,
  readJson,
} from "./http.js";
import { importVerifyKey, verifyRunnerToken } from "./identity.js";
import {
  AgentBusyError,
  AgentDecommissioningError,
  AlreadyRunningError,
  hashOperation,
  isTerminal,
  OperationConflictError,
} from "./run-state.js";
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
  RUN_ADMISSION_CONSECUTIVE_MAX?: string;
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX?: string;
  RUN_ADMISSION_MODE?: string;
  RUN_ADMISSION_TENANT_ACTIVE_MAX?: string;
  RUN_ADMISSION_TENANT_QUEUE_MAX?: string;
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
  registerRun: (
    runId: string,
    agentId: string
  ) => Awaitable<boolean | undefined>;
  unregisterRun: (
    runId: string,
    agentId: string
  ) => Awaitable<boolean | undefined>;
  enqueueRunMappingCleanup?: (
    runId: string,
    agentId: string
  ) => Awaitable<void>;
  remove: (agentId: string) => Awaitable<void>;
  upsert: (definition: AgentDefinition) => Awaitable<AgentDefinition>;
  lookupRun: (runId: string) => Awaitable<string | null>;
};

export type CloudRunnerAgent = {
  configure: (definition: AgentDefinition) => Awaitable<AgentDefinition>;
  discardRun: (runId: string) => Awaitable<boolean | undefined>;
  decommission: () => Awaitable<void>;
  enqueue: (
    input: unknown,
    runId: string,
    requestHash: string,
    identityToken: string
  ) => Awaitable<{ created: boolean; run: RunSnapshot }>;
  getEventStream: (
    runId: string,
    lastEventId: number
  ) => Awaitable<RunEventStreamSnapshot | null>;
  getRun: (runId: string) => Awaitable<RunSnapshot | null>;
  listRuns: () => Awaitable<RunSnapshot[]>;
  snapshot: () => Awaitable<AgentDefinition | null>;
  warm: () => Awaitable<WarmState>;
  start: (
    input: unknown,
    identityToken: string
  ) => Awaitable<{
    created: boolean;
    run: RunSnapshot;
  }>;
  stop: (
    runId: string,
    dispatchToken?: string
  ) => Awaitable<RunSnapshot | null>;
};

export type CloudRunnerAdmission = {
  admit: (input: AdmissionRequest) => Awaitable<AdmissionDecision>;
  getRecord?: (runId: string) => Awaitable<AdmissionRecord | null>;
  getByOperationId?: (operationId: string) => Awaitable<AdmissionRecord | null>;
  enqueueCleanup?: (agentId: string, runId: string) => Awaitable<void>;
  release: (runId: string, dispatchToken?: string) => Awaitable<boolean>;
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
  getAdmission?: (environment: Environment) => Awaitable<CloudRunnerAdmission>;
  getYoloAgent: (
    environment: Environment,
    agentId: string
  ) => Awaitable<CloudRunnerAgent>;
};

async function cleanupRun(
  agent: CloudRunnerAgent,
  runId: string,
  agentId: string,
  admission?: CloudRunnerAdmission,
  stopFirst = false
): Promise<unknown | null> {
  let firstError: unknown | null = null;
  const remember = (error: unknown) => {
    if (firstError === null) {
      firstError = error;
    }
  };
  const attempt = async (action: () => Awaitable<unknown>) => {
    try {
      return { ok: true, value: await action() } as const;
    } catch (error) {
      remember(error);
      return { ok: false, value: undefined } as const;
    }
  };

  let safeToRelease = false;
  if (stopFirst) {
    const stopped = await attempt(() => agent.stop(runId));
    const discarded = await attempt(() => agent.discardRun(runId));
    safeToRelease =
      (discarded.ok && discarded.value !== false) ||
      (stopped.ok &&
        (stopped.value === null ||
          (typeof stopped.value === "object" &&
            stopped.value !== null &&
            "status" in stopped.value &&
            typeof stopped.value.status === "string" &&
            isTerminal(stopped.value.status as RunSnapshot["status"]))));
  } else {
    const discarded = await attempt(() => agent.discardRun(runId));
    if (discarded.ok && discarded.value !== false) {
      safeToRelease = true;
    } else {
      const stopped = await attempt(() => agent.stop(runId));
      safeToRelease =
        stopped.ok &&
        (stopped.value === null ||
          (typeof stopped.value === "object" &&
            stopped.value !== null &&
            "status" in stopped.value &&
            typeof stopped.value.status === "string" &&
            isTerminal(stopped.value.status as RunSnapshot["status"])));
    }
  }
  if (admission && safeToRelease) {
    const released = await attempt(() => admission.release(runId));
    if (!released.ok && admission.enqueueCleanup) {
      await attempt(() => admission.enqueueCleanup?.(agentId, runId));
    }
  } else if (admission?.enqueueCleanup) {
    await attempt(() => admission.enqueueCleanup?.(agentId, runId));
  }
  return firstError;
}

function isOperationConflict(error: unknown): boolean {
  return (
    error instanceof OperationConflictError ||
    (error instanceof Error && error.name === "OperationConflictError")
  );
}

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
    error instanceof AdmissionUnavailableError ||
    (error instanceof Error && error.name === "AdmissionUnavailableError")
  ) {
    return json(
      errorEnvelope(
        "admission_unavailable",
        "Run admission is temporarily unavailable. Try again later.",
        true
      ),
      { status: 503 },
      cors
    );
  }
  if (
    error instanceof AgentDecommissioningError ||
    (error instanceof Error && error.name === "AgentDecommissioningError")
  ) {
    return json(
      errorEnvelope(
        "agent_decommissioning",
        "Agent decommission is still in progress. Try again later.",
        true
      ),
      { status: 409 },
      cors
    );
  }
  if (
    error instanceof AlreadyRunningError ||
    error instanceof AgentBusyError ||
    (error instanceof Error &&
      (error.name === "AlreadyRunningError" || error.name === "AgentBusyError"))
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

function busyResponse(
  reason: "global_busy" | "tenant_queue_full",
  cors: Headers
): Response {
  const message =
    reason === "tenant_queue_full"
      ? "This tenant has too much work waiting."
      : "The cloud runner is busy. Try again later.";
  return json(errorEnvelope("busy", message, true), { status: 409 }, cors);
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
            // Creating a profile is a declared intent to run, so the
            // container starts booting while the user types their first
            // mission. Subscribers only — a demo tenant cannot run, so
            // warming for one would spend a container on nothing. A warm
            // failure never fails the creation it rides on.
            if (claims.plan === "subscriber") {
              await Promise.resolve(agent.warm()).catch(() => undefined);
            }
            return json({ agent: configured }, { status: 201 }, cors);
          }
        }

        if (
          url.pathname === "/api/tenant/prewarm" &&
          request.method === "POST"
        ) {
          // Sign-in-time warming for a returning user: boot the sandbox of
          // the agent they most recently ran. Idempotent — the agent's warm
          // state single-flights the fiber — and quota-free for the caller:
          // no run is counted and no credential is fetched.
          if (claims.plan !== "subscriber") {
            return json(
              errorEnvelope(
                "subscription_required",
                "Warming needs an active subscription.",
                false
              ),
              { status: 403 },
              cors
            );
          }
          const owned = await directory.list(callerTenant);
          const [target] = [...owned].sort(
            (left, right) =>
              Date.parse(right.lastRunAt ?? right.updatedAt) -
              Date.parse(left.lastRunAt ?? left.updatedAt)
          );
          if (!target) {
            return new Response(null, { headers: cors, status: 204 });
          }
          const warm = await Promise.resolve(
            (await yoloAgent(target.id)).warm()
          ).catch(() => null);
          return json({ agentId: target.id, warm }, { status: 202 }, cors);
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
            // An edited profile is about to be run — same intent signal as
            // creation, same warm, same subscriber gate.
            if (claims.plan === "subscriber") {
              await Promise.resolve(agent.warm()).catch(() => undefined);
            }
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
            const input = startRunInputSchema.parse(await readJson(request));
            const runAdmissionMode = admissionMode(environment);
            const requestHash = await hashOperation(id, input.task);
            const runId = crypto.randomUUID();
            let prepared: Awaited<ReturnType<CloudRunnerAgent["enqueue"]>>;
            try {
              prepared = await agent.enqueue(
                input,
                runId,
                requestHash,
                authorization.slice(7)
              );
            } catch (error) {
              await cleanupRun(agent, runId, id);
              throw error;
            }
            if (!prepared.created) {
              if (isTerminal(prepared.run.status)) {
                let terminalAdmission: CloudRunnerAdmission;
                try {
                  if (!dependencies.getAdmission) {
                    throw new AdmissionUnavailableError(
                      "Run admission is not configured."
                    );
                  }
                  terminalAdmission =
                    await dependencies.getAdmission(environment);
                  const stale = terminalAdmission.getByOperationId
                    ? await terminalAdmission.getByOperationId(
                        input.operationId
                      )
                    : null;
                  // A terminal local run can outlive a failed release
                  // callback. Releasing by the durable operation record first
                  // repairs both queued and active stale admission.
                  await terminalAdmission.release(
                    stale?.runId ?? prepared.run.id
                  );
                } catch (error) {
                  if (
                    error instanceof AdmissionUnavailableError ||
                    (error instanceof Error &&
                      error.name === "AdmissionUnavailableError")
                  ) {
                    throw error;
                  }
                  throw new AdmissionUnavailableError(
                    "Terminal run admission reconciliation failed.",
                    { cause: error }
                  );
                }
                return json(
                  {
                    apiVersion: AGENT_RUNNER_API_VERSION,
                    run: prepared.run,
                  },
                  { status: 202 },
                  cors
                );
              }
              let existingAdmission: CloudRunnerAdmission | null = null;
              let admissionRecord: AdmissionRecord | null = null;
              try {
                existingAdmission = dependencies.getAdmission
                  ? await dependencies.getAdmission(environment)
                  : null;
                admissionRecord = existingAdmission?.getByOperationId
                  ? await existingAdmission.getByOperationId(input.operationId)
                  : null;
              } catch {
                return busyResponse("global_busy", cors);
              }
              if (!existingAdmission || !admissionRecord) {
                return busyResponse("global_busy", cors);
              }
              const originalAgentId = await directory.lookupRun(
                admissionRecord.runId
              );
              const originalAgent = originalAgentId
                ? await yoloAgent(originalAgentId)
                : agent;
              const original = await originalAgent.getRun(
                admissionRecord.runId
              );
              if (!original) {
                return busyResponse("global_busy", cors);
              }
              if (isTerminal(original.status)) {
                await existingAdmission.release(admissionRecord.runId);
              }
              return json(
                {
                  apiVersion: AGENT_RUNNER_API_VERSION,
                  run: original,
                },
                { status: 202 },
                cors
              );
            }
            if (!dependencies.getAdmission) {
              await cleanupRun(agent, runId, id);
              throw new Error("Run admission is not configured.");
            }

            let admission: CloudRunnerAdmission;
            try {
              admission = await dependencies.getAdmission(environment);
            } catch (error) {
              await cleanupRun(agent, runId, id);
              if (runAdmissionMode === "reject") {
                return busyResponse("global_busy", cors);
              }
              throw error;
            }

            let decision: AdmissionDecision;
            try {
              decision = await admission.admit({
                agentId: id,
                operationId: input.operationId,
                requestHash,
                runId,
                tenantHash: await tenantAdmissionHash(
                  environment.EDGE_ABUSE_KEY_SECRET,
                  callerTenant
                ),
              });
            } catch (error) {
              await cleanupRun(agent, runId, id, admission, true);
              if (
                runAdmissionMode === "reject" &&
                !isOperationConflict(error)
              ) {
                return busyResponse("global_busy", cors);
              }
              throw error;
            }

            if (decision.kind === "refused") {
              const cleanupError = await cleanupRun(
                agent,
                runId,
                id,
                admission
              );
              if (cleanupError) {
                throw cleanupError;
              }
              return busyResponse(decision.reason, cors);
            }
            if (decision.kind === "duplicate") {
              const cleanupError = await cleanupRun(
                agent,
                runId,
                id,
                admission
              );
              if (cleanupError) {
                throw cleanupError;
              }
              const originalAgentId = await directory.lookupRun(decision.runId);
              const originalAgent = originalAgentId
                ? await yoloAgent(originalAgentId)
                : agent;
              const original = await originalAgent.getRun(decision.runId);
              if (!original) {
                return busyResponse("global_busy", cors);
              }
              if (isTerminal(original.status)) {
                await admission.release(decision.runId);
              }
              return json(
                { apiVersion: AGENT_RUNNER_API_VERSION, run: original },
                { status: 202 },
                cors
              );
            }
            if (decision.kind === "queued" && runAdmissionMode === "reject") {
              const cleanupError = await cleanupRun(
                agent,
                runId,
                id,
                admission
              );
              if (cleanupError) {
                throw cleanupError;
              }
              return busyResponse("global_busy", cors);
            }

            let mappingCreated = false;
            try {
              mappingCreated =
                (await directory.registerRun(runId, id)) !== false;
              const admittedRun = await agent.getRun(runId);
              if (!admittedRun) {
                throw new Error("Admitted run disappeared after registration.");
              }
              return json(
                {
                  apiVersion: AGENT_RUNNER_API_VERSION,
                  run: admittedRun ?? prepared.run,
                },
                { status: 202 },
                cors
              );
            } catch (error) {
              if (mappingCreated) {
                try {
                  await directory.unregisterRun(runId, id);
                } catch {
                  if (directory.enqueueRunMappingCleanup) {
                    try {
                      await directory.enqueueRunMappingCleanup(runId, id);
                    } catch {
                      // Preserve the original request failure.
                    }
                  }
                }
              }
              await cleanupRun(agent, runId, id, admission, true);
              throw error;
            }
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
