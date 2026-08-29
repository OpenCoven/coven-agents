import "server-only";

import { randomUUID } from "node:crypto";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  AGENT_RUNNER_LIMITS,
  agentEnvelopeSchema,
  agentIdSchema,
  agentRunnerHealthSchema,
  agentsEnvelopeSchema,
  createAgentInputSchema,
  okEnvelopeSchema,
  type RunErrorEnvelope,
  runErrorEnvelopeSchema,
  runListEnvelopeSchema,
  runSnapshotEnvelopeSchema,
  startRunInputSchema,
} from "@opencoven/agent-contracts";
import {
  harnessesEnvelopeSchema,
  SUPPORTED_HARNESS_IDS,
} from "@opencoven/harness";
import { z } from "zod";
import { readBoundedJson } from "@/lib/abuse/body";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import { abusePolicyFor } from "@/lib/abuse/policy";
import type {
  RunnerAuth,
  RunnerAuthenticatedSubscriber,
  RunnerSecretAuthorization,
  RunnerSubscriberAuthorization,
} from "./auth";
import type { RunnerReconciliationResult } from "./reconcile";
import { type RunnerService, RunnerServiceError } from "./service";
import { createRunEventStream } from "./sse";

const emptyObjectSchema = z.object({}).strict();
const diagnosticResponseSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    ok: z.boolean(),
    output: z.string().max(1024),
  })
  .strict();

type RunnerHttpLogger = Readonly<{
  error: (message: string, details: Readonly<{ name: string }>) => void;
}>;

type After = (callback: () => void | Promise<void>) => void;

export type RunnerHttpDependencies = Readonly<{
  after?: After;
  auth: RunnerAuth;
  createEventStream?: typeof createRunEventStream;
  createRequestId?: () => string;
  createOperatorService: () => RunnerService | Promise<RunnerService>;
  createService: (
    subscriber: RunnerAuthenticatedSubscriber
  ) => RunnerService | Promise<RunnerService>;
  enforceAbuse: (input: AbuseEnforcementInput) => Promise<AbuseAdmission>;
  ipAddress: (request: Request) => string | null;
  logger?: RunnerHttpLogger;
}>;

export type RunnerHttpHandlers = Readonly<{
  createAgent: (request: Request) => Promise<Response>;
  deleteAgent: (request: Request, agentId: string) => Promise<Response>;
  diagnoseSandbox: (request: Request) => Promise<Response>;
  getAgent: (request: Request, agentId: string) => Promise<Response>;
  getHarnesses: (request: Request) => Promise<Response>;
  getRun: (request: Request, runId: string) => Promise<Response>;
  getRunEvents: (request: Request, runId: string) => Promise<Response>;
  health: (request: Request) => Promise<Response>;
  listAgentRuns: (request: Request, agentId: string) => Promise<Response>;
  listAgents: (request: Request) => Promise<Response>;
  prewarmTenant: (request: Request) => Promise<Response>;
  reconcile: (request: Request) => Promise<Response>;
  startAgentRun: (request: Request, agentId: string) => Promise<Response>;
  stopRun: (request: Request, runId: string) => Promise<Response>;
  updateAgent: (request: Request, agentId: string) => Promise<Response>;
}>;

type BoundedJsonResult<T> =
  | Readonly<{ kind: "ok"; value: T }>
  | Readonly<{ kind: "response"; response: Response }>;

function requestId(dependencies: RunnerHttpDependencies): string {
  const candidate = dependencies.createRequestId?.() ?? randomUUID();
  const normalized =
    typeof candidate === "string"
      ? candidate.trim().slice(0, AGENT_RUNNER_LIMITS.maxRequestIdLength)
      : "";
  return normalized || randomUUID();
}

function errorResponse(
  dependencies: RunnerHttpDependencies,
  status: number,
  code: string,
  message: string,
  retryable: boolean
): Response {
  const body: RunErrorEnvelope = runErrorEnvelopeSchema.parse({
    apiVersion: AGENT_RUNNER_API_VERSION,
    error: { code, message, retryable },
    requestId: requestId(dependencies),
  });
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function invalidRequest(dependencies: RunnerHttpDependencies): Response {
  return errorResponse(
    dependencies,
    400,
    "invalid_request",
    "Request validation failed.",
    false
  );
}

function invalidId(
  dependencies: RunnerHttpDependencies,
  value: string
): Response | null {
  return agentIdSchema.safeParse(value).success
    ? null
    : invalidRequest(dependencies);
}

function agentNotFound(dependencies: RunnerHttpDependencies): Response {
  return errorResponse(
    dependencies,
    404,
    "not_found",
    "Agent was not found.",
    false
  );
}

function runNotFound(dependencies: RunnerHttpDependencies): Response {
  return errorResponse(
    dependencies,
    404,
    "run_not_found",
    "Run was not found.",
    false
  );
}

function runnerUnavailable(dependencies: RunnerHttpDependencies): Response {
  return errorResponse(
    dependencies,
    503,
    "runner_unavailable",
    "Runner service is temporarily unavailable. Try again later.",
    true
  );
}

function providerUnavailable(dependencies: RunnerHttpDependencies): Response {
  return errorResponse(
    dependencies,
    503,
    "provider_unavailable",
    "Runner provider is temporarily unavailable. Try again later.",
    true
  );
}

function providerRejected(dependencies: RunnerHttpDependencies): Response {
  return errorResponse(
    dependencies,
    422,
    "provider_rejected",
    "Runner provider rejected the operation.",
    false
  );
}

function staleVersion(dependencies: RunnerHttpDependencies): Response {
  return errorResponse(
    dependencies,
    409,
    "stale_version",
    "The agent changed concurrently. Try again.",
    true
  );
}

function unreachableResult(value: never): never {
  throw new Error(
    `Runner HTTP adapter received an unsupported result: ${JSON.stringify(value)}`
  );
}

function subscriberFailure(
  dependencies: RunnerHttpDependencies,
  decision: Exclude<RunnerSubscriberAuthorization, { kind: "allowed" }>
): Response {
  return decision.kind === "unauthorized"
    ? errorResponse(
        dependencies,
        401,
        "unauthorized",
        "Identity was rejected.",
        false
      )
    : errorResponse(
        dependencies,
        403,
        "subscription_required",
        "An active subscription is required.",
        false
      );
}

function secretFailure(
  dependencies: RunnerHttpDependencies,
  decision: Exclude<RunnerSecretAuthorization, { kind: "allowed" }>,
  unavailableCode: "diagnostic_unavailable" | "reconcile_unavailable"
): Response {
  return decision.kind === "unavailable"
    ? errorResponse(
        dependencies,
        503,
        unavailableCode,
        "Please try again later.",
        true
      )
    : errorResponse(
        dependencies,
        401,
        "unauthorized",
        "Operator token was rejected.",
        false
      );
}

function abuseFailure(
  dependencies: RunnerHttpDependencies,
  admission: Exclude<AbuseAdmission, { kind: "allowed" }>
): Response {
  if (admission.kind === "denied") {
    const response = errorResponse(
      dependencies,
      429,
      "rate_limited",
      "Too many requests. Try again later.",
      true
    );
    response.headers.set("retry-after", String(admission.retryAfterSeconds));
    return response;
  }
  return errorResponse(
    dependencies,
    503,
    "abuse_control_unavailable",
    "Please try again later.",
    true
  );
}

function policyInput(
  route: AbuseEnforcementInput["route"],
  ipAddress: string | null,
  subscriber?: RunnerAuthenticatedSubscriber
): AbuseEnforcementInput {
  return {
    failClosed: true,
    ip: ipAddress,
    route,
    ...(subscriber
      ? {
          tenant: subscriber.principal.tenant,
          userId: subscriber.userId,
        }
      : {}),
  };
}

async function authorizeSubscriber(
  request: Request,
  route: AbuseEnforcementInput["route"],
  dependencies: RunnerHttpDependencies
): Promise<Response | RunnerAuthenticatedSubscriber> {
  const subscriber = await dependencies.auth.authorizeSubscriber();
  if (subscriber.kind !== "allowed") {
    return subscriberFailure(dependencies, subscriber);
  }
  const admission = await dependencies.enforceAbuse(
    policyInput(route, dependencies.ipAddress(request), subscriber)
  );
  if (admission.kind !== "allowed") {
    return abuseFailure(dependencies, admission);
  }
  return subscriber;
}

async function authorizeSecret(
  request: Request,
  route: "runner_diagnostic" | "runner_reconcile",
  dependencies: RunnerHttpDependencies
): Promise<Response | null> {
  const admission = await dependencies.enforceAbuse(
    policyInput(route, dependencies.ipAddress(request))
  );
  if (admission.kind !== "allowed") {
    return abuseFailure(dependencies, admission);
  }

  const authorization =
    route === "runner_diagnostic"
      ? dependencies.auth.authorizeDiagnostic(request)
      : dependencies.auth.authorizeReconcile(request);
  if (authorization.kind !== "allowed") {
    return secretFailure(
      dependencies,
      authorization,
      route === "runner_diagnostic"
        ? "diagnostic_unavailable"
        : "reconcile_unavailable"
    );
  }
  return null;
}

async function boundedJson<T>(
  request: Request,
  route: AbuseEnforcementInput["route"],
  schema: z.ZodType<T>,
  dependencies: RunnerHttpDependencies,
  options?: { emptyBody?: unknown }
): Promise<BoundedJsonResult<T>> {
  const body = await readBoundedJson(
    request,
    abusePolicyFor(route).bodyBytes,
    schema,
    options
  );
  if (body.kind === "ok") {
    return body;
  }
  return {
    kind: "response",
    response:
      body.kind === "too_large"
        ? errorResponse(
            dependencies,
            413,
            "body_too_large",
            "Request body is too large.",
            false
          )
        : invalidRequest(dependencies),
  };
}

function isResponse(
  value: Response | RunnerAuthenticatedSubscriber
): value is Response {
  return value instanceof Response;
}

function parseLastEventId(
  request: Request,
  dependencies: RunnerHttpDependencies
): number | Response {
  const raw = request.headers.get("last-event-id");
  if (raw === null) {
    return 0;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    return errorResponse(
      dependencies,
      400,
      "invalid_event_cursor",
      "Last-Event-ID must be a non-negative integer.",
      false
    );
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed)
    ? parsed
    : errorResponse(
        dependencies,
        400,
        "invalid_event_cursor",
        "Last-Event-ID must be a non-negative integer.",
        false
      );
}

function schedule(
  dependencies: RunnerHttpDependencies,
  operation: () => Promise<void>
): void {
  if (!dependencies.after) {
    return;
  }
  try {
    dependencies.after(async () => {
      try {
        await operation();
      } catch {
        // The durable queue and authenticated cron are the correctness path.
      }
    });
  } catch {
    // `after` is a latency optimization and must never change a response.
  }
}

function reconciliationCounts(
  result: RunnerReconciliationResult
): RunnerReconciliationResult {
  const fields = [
    "adopted",
    "deferred",
    "dispatched",
    "expiredScanned",
    "failures",
    "logEvents",
    "requeued",
    "sandboxRecovered",
    "terminalCleaned",
    "terminalized",
  ] as const;
  for (const field of fields) {
    if (!Number.isSafeInteger(result[field]) || result[field] < 0) {
      throw new RunnerServiceError(
        "reconcile_unavailable",
        "Runner reconciliation returned invalid counts."
      );
    }
  }
  return {
    adopted: result.adopted,
    deferred: result.deferred,
    dispatched: result.dispatched,
    expiredScanned: result.expiredScanned,
    failures: result.failures,
    logEvents: result.logEvents,
    requeued: result.requeued,
    sandboxRecovered: result.sandboxRecovered,
    terminalCleaned: result.terminalCleaned,
    terminalized: result.terminalized,
  };
}

function serviceFailure(
  dependencies: RunnerHttpDependencies,
  error: unknown
): Response {
  if (error instanceof RunnerServiceError) {
    switch (error.code) {
      case "diagnostic_unavailable":
        return errorResponse(
          dependencies,
          503,
          "diagnostic_unavailable",
          "Please try again later.",
          true
        );
      case "reconcile_unavailable":
        return errorResponse(
          dependencies,
          503,
          "reconcile_unavailable",
          "Please try again later.",
          true
        );
      case "service_unavailable":
        return runnerUnavailable(dependencies);
      default: {
        const unsupportedCode: never = error.code;
        dependencies.logger?.error(
          "Runner service error code is unsupported.",
          {
            name: String(unsupportedCode),
          }
        );
        return errorResponse(
          dependencies,
          500,
          "internal_error",
          "Runner request failed.",
          true
        );
      }
    }
  }
  dependencies.logger?.error("Runner HTTP request failed.", {
    name: error instanceof Error ? error.name : typeof error,
  });
  return errorResponse(
    dependencies,
    500,
    "internal_error",
    "Runner request failed.",
    true
  );
}

async function safely(
  dependencies: RunnerHttpDependencies,
  handler: () => Promise<Response>
): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    return serviceFailure(dependencies, error);
  }
}

function emptyBody(
  request: Request,
  route:
    | "runner_diagnostic"
    | "runner_reconcile"
    | "runner_stop"
    | "runner_write",
  dependencies: RunnerHttpDependencies
): Promise<BoundedJsonResult<Record<string, never>>> {
  return boundedJson(request, route, emptyObjectSchema, dependencies, {
    emptyBody: {},
  });
}

export function createRunnerHttpHandlers(
  dependencies: RunnerHttpDependencies
): RunnerHttpHandlers {
  const eventStream = dependencies.createEventStream ?? createRunEventStream;

  return {
    createAgent: (request) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_write",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const body = await boundedJson(
          request,
          "runner_write",
          createAgentInputSchema,
          dependencies
        );
        if (body.kind !== "ok") {
          return body.response;
        }
        const service = await dependencies.createService(context);
        const created = await service.createAgent(
          context.principal,
          body.value
        );
        switch (created.kind) {
          case "invalid":
            return invalidRequest(dependencies);
          case "unsupported_harness":
            return errorResponse(
              dependencies,
              400,
              "harness_unsupported",
              `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
              false
            );
          case "conflict":
            return errorResponse(
              dependencies,
              409,
              "operation_conflict",
              "Agent creation conflicted with a concurrent operation.",
              true
            );
          case "unavailable":
            return runnerUnavailable(dependencies);
          case "created":
            schedule(dependencies, async () => {
              await service.warmAgent(context.principal, created.agent.id);
              await service.reconcileAndDispatch();
            });
            return Response.json(
              agentEnvelopeSchema.parse({ agent: created.agent }),
              { status: 201 }
            );
          default:
            return unreachableResult(created);
        }
      }),

    deleteAgent: (request, agentId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_write",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const invalid = invalidId(dependencies, agentId);
        if (invalid) {
          return invalid;
        }
        const service = await dependencies.createService(context);
        const deleted = await service.deleteAgent(context.principal, agentId);
        switch (deleted.kind) {
          case "not_found":
            return agentNotFound(dependencies);
          case "busy":
            return errorResponse(
              dependencies,
              409,
              "busy",
              "The agent is busy. Try again later.",
              true
            );
          case "stale_version":
            return staleVersion(dependencies);
          case "unavailable":
            return deleted.source === "provider"
              ? providerUnavailable(dependencies)
              : runnerUnavailable(dependencies);
          case "provider_rejected":
            return providerRejected(dependencies);
          case "deleted":
            return Response.json(okEnvelopeSchema.parse({ ok: true }));
          default:
            return unreachableResult(deleted);
        }
      }),

    diagnoseSandbox: (request) =>
      safely(dependencies, async () => {
        const rejected = await authorizeSecret(
          request,
          "runner_diagnostic",
          dependencies
        );
        if (rejected) {
          return rejected;
        }
        const body = await emptyBody(
          request,
          "runner_diagnostic",
          dependencies
        );
        if (body.kind !== "ok") {
          return body.response;
        }
        const service = await dependencies.createOperatorService();
        return Response.json(
          diagnosticResponseSchema.parse(await service.diagnoseSandbox())
        );
      }),

    getAgent: (request, agentId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_read",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const invalid = invalidId(dependencies, agentId);
        if (invalid) {
          return invalid;
        }
        const service = await dependencies.createService(context);
        const result = await service.getAgent(context.principal, agentId);
        return result.kind === "found"
          ? Response.json(agentEnvelopeSchema.parse({ agent: result.agent }))
          : agentNotFound(dependencies);
      }),

    getHarnesses: (request) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_read",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const service = await dependencies.createService(context);
        return Response.json(
          harnessesEnvelopeSchema.parse({
            harnesses: await service.listHarnesses(),
          })
        );
      }),

    getRun: (request, runId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_read",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const invalid = invalidId(dependencies, runId);
        if (invalid) {
          return invalid;
        }
        const service = await dependencies.createService(context);
        const result = await service.getRun(context.principal, runId);
        return result.kind === "found"
          ? Response.json(
              runSnapshotEnvelopeSchema.parse({
                apiVersion: AGENT_RUNNER_API_VERSION,
                run: result.run,
              })
            )
          : runNotFound(dependencies);
      }),

    getRunEvents: (request, runId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_read",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const invalid = invalidId(dependencies, runId);
        if (invalid) {
          return invalid;
        }
        const lastEventId = parseLastEventId(request, dependencies);
        if (lastEventId instanceof Response) {
          return lastEventId;
        }
        // Resolve the first page before returning a stream, so a foreign or
        // missing run stays an indistinguishable 404 rather than an empty SSE.
        const service = await dependencies.createService(context);
        const initial = await service.readRunEvents(
          context.principal,
          runId,
          lastEventId
        );
        if (initial.kind === "not_found") {
          return runNotFound(dependencies);
        }
        const stream = eventStream({
          lastEventId,
          read: async (cursor) => {
            const page = await service.readRunEvents(
              context.principal,
              runId,
              cursor
            );
            return page.kind === "found"
              ? { events: page.events, terminal: page.terminal }
              : null;
          },
          signal: request.signal,
        });
        return new Response(stream, {
          headers: {
            "cache-control": "no-cache",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
            "x-accel-buffering": "no",
          },
        });
      }),

    health: (request) =>
      safely(dependencies, async () => {
        const admission = await dependencies.enforceAbuse(
          policyInput("runner_public_read", dependencies.ipAddress(request))
        );
        if (admission.kind !== "allowed") {
          return abuseFailure(dependencies, admission);
        }
        return Response.json(
          agentRunnerHealthSchema.parse({
            apiVersion: AGENT_RUNNER_API_VERSION,
            capabilities: [...AGENT_RUNNER_CAPABILITIES],
            minimumClientVersion: "1.0.0",
            mode: "cloud",
          })
        );
      }),

    listAgentRuns: (request, agentId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_read",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const invalid = invalidId(dependencies, agentId);
        if (invalid) {
          return invalid;
        }
        const service = await dependencies.createService(context);
        const result = await service.listAgentRuns(context.principal, agentId);
        return result.kind === "found"
          ? Response.json(
              runListEnvelopeSchema.parse({
                apiVersion: AGENT_RUNNER_API_VERSION,
                runs: result.runs,
              })
            )
          : agentNotFound(dependencies);
      }),

    listAgents: (request) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_read",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const service = await dependencies.createService(context);
        return Response.json(
          agentsEnvelopeSchema.parse({
            agents: await service.listAgents(context.principal),
          })
        );
      }),

    prewarmTenant: (request) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_write",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const body = await emptyBody(request, "runner_write", dependencies);
        if (body.kind !== "ok") {
          return body.response;
        }
        const service = await dependencies.createService(context);
        const result = await service.prewarmMostRecent(context.principal);
        switch (result.kind) {
          case "none":
          case "not_found":
            return new Response(null, { status: 204 });
          case "unsupported_harness":
            return errorResponse(
              dependencies,
              400,
              "harness_unsupported",
              `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
              false
            );
          case "ready":
          case "in_progress":
            return Response.json(
              {
                agentId: result.agentId,
                warm: result.warm,
              },
              { status: 202 }
            );
          case "stale_version":
            return staleVersion(dependencies);
          case "unavailable":
            return result.source === "provider"
              ? providerUnavailable(dependencies)
              : runnerUnavailable(dependencies);
          case "provider_rejected":
            return providerRejected(dependencies);
          default:
            return unreachableResult(result);
        }
      }),

    reconcile: (request) =>
      safely(dependencies, async () => {
        const rejected = await authorizeSecret(
          request,
          "runner_reconcile",
          dependencies
        );
        if (rejected) {
          return rejected;
        }
        const body = await emptyBody(request, "runner_reconcile", dependencies);
        if (body.kind !== "ok") {
          return body.response;
        }
        const service = await dependencies.createOperatorService();
        return Response.json(
          reconciliationCounts(await service.reconcileAndDispatch())
        );
      }),

    startAgentRun: (request, agentId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_run_start",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const invalid = invalidId(dependencies, agentId);
        if (invalid) {
          return invalid;
        }
        const body = await boundedJson(
          request,
          "runner_run_start",
          startRunInputSchema,
          dependencies
        );
        if (body.kind !== "ok") {
          return body.response;
        }
        const service = await dependencies.createService(context);
        const result = await service.startRun(
          context.principal,
          context.authVersion,
          agentId,
          body.value
        );
        switch (result.kind) {
          case "invalid":
            return invalidRequest(dependencies);
          case "not_found":
            return agentNotFound(dependencies);
          case "unsupported_harness":
            return errorResponse(
              dependencies,
              400,
              "harness_unsupported",
              `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
              false
            );
          case "refused":
            switch (result.code) {
              case "operation_conflict":
                return errorResponse(
                  dependencies,
                  409,
                  "operation_conflict",
                  "Operation ID was already used for a different request.",
                  false
                );
              case "busy":
                return errorResponse(
                  dependencies,
                  409,
                  "busy",
                  "The cloud runner is busy. Try again later.",
                  true
                );
              case "lifecycle_conflict":
                return errorResponse(
                  dependencies,
                  409,
                  "agent_decommissioning",
                  "Agent decommission is still in progress. Try again later.",
                  true
                );
              case "admission_unavailable":
                return errorResponse(
                  dependencies,
                  503,
                  "admission_unavailable",
                  "Run admission is temporarily unavailable. Try again later.",
                  true
                );
              default:
                return unreachableResult(result.code);
            }
          case "accepted":
            if (result.scheduleReconciliation) {
              schedule(dependencies, async () => {
                await service.reconcileAndDispatch();
              });
            }
            return Response.json(
              runSnapshotEnvelopeSchema.parse({
                apiVersion: AGENT_RUNNER_API_VERSION,
                run: result.run,
              }),
              { status: 202 }
            );
          default:
            return unreachableResult(result);
        }
      }),

    stopRun: (request, runId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_stop",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const invalid = invalidId(dependencies, runId);
        if (invalid) {
          return invalid;
        }
        const body = await emptyBody(request, "runner_stop", dependencies);
        if (body.kind !== "ok") {
          return body.response;
        }
        const service = await dependencies.createService(context);
        const result = await service.stopRun(context.principal, runId);
        switch (result.kind) {
          case "not_found":
            return runNotFound(dependencies);
          case "in_progress":
            return errorResponse(
              dependencies,
              409,
              "busy",
              "Run cancellation is already in progress. Try again later.",
              true
            );
          case "unavailable":
            return runnerUnavailable(dependencies);
          case "cleanup_required":
            schedule(dependencies, async () => {
              await service.reconcileAndDispatch();
            });
            return errorResponse(
              dependencies,
              503,
              "cleanup_required",
              "Run cancellation is awaiting cleanup. Try again later.",
              true
            );
          case "stopped":
            schedule(dependencies, async () => {
              await service.reconcileAndDispatch();
            });
            return Response.json(
              runSnapshotEnvelopeSchema.parse({
                apiVersion: AGENT_RUNNER_API_VERSION,
                run: result.run,
              })
            );
          default:
            return unreachableResult(result);
        }
      }),

    updateAgent: (request, agentId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_write",
          dependencies
        );
        if (isResponse(context)) {
          return context;
        }
        const invalid = invalidId(dependencies, agentId);
        if (invalid) {
          return invalid;
        }
        const body = await boundedJson(
          request,
          "runner_write",
          createAgentInputSchema,
          dependencies
        );
        if (body.kind !== "ok") {
          return body.response;
        }
        const service = await dependencies.createService(context);
        const result = await service.updateAgent(
          context.principal,
          agentId,
          body.value
        );
        switch (result.kind) {
          case "not_found":
            return agentNotFound(dependencies);
          case "invalid":
            return invalidRequest(dependencies);
          case "unsupported_harness":
            return errorResponse(
              dependencies,
              400,
              "harness_unsupported",
              `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
              false
            );
          case "stale_version":
            return staleVersion(dependencies);
          case "unavailable":
            return runnerUnavailable(dependencies);
          case "updated":
            schedule(dependencies, async () => {
              await service.warmAgent(context.principal, result.agent.id);
              await service.reconcileAndDispatch();
            });
            return Response.json(
              agentEnvelopeSchema.parse({ agent: result.agent })
            );
          default:
            return unreachableResult(result);
        }
      }),
  };
}
