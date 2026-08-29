import "server-only";

import { randomUUID } from "node:crypto";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  agentEnvelopeSchema,
  agentRunnerHealthSchema,
  agentsEnvelopeSchema,
  createAgentInputSchema,
  okEnvelopeSchema,
  runListEnvelopeSchema,
  runSnapshotEnvelopeSchema,
  startRunInputSchema,
} from "@opencoven/agent-contracts";
import {
  harnessesEnvelopeSchema,
  SUPPORTED_HARNESS_IDS,
} from "@opencoven/harness";
import { z } from "zod";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import { admitAndScheduleRunnerRun } from "./admit-and-schedule";
import type {
  RunnerAuth,
  RunnerAuthenticatedSubscriber,
  RunnerSecretAuthorization,
  RunnerSubscriberAuthorization,
} from "./auth";
import { RunnerServiceError } from "./errors";
import type { RunnerReconciliationExecutionResult } from "./reconcile";
import type { RunnerDiagnosticResult, RunnerService } from "./service";
import { createRunEventStream } from "./sse";
import {
  readRunnerJson as boundedJson,
  readEmptyRunnerJson as emptyBody,
  invalidRunnerId as invalidId,
  parseRunnerEventCursor as parseLastEventId,
  runnerErrorResponse,
  runnerJsonResponse,
  unreachableRunnerResult as unreachableResult,
} from "./transport";

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
  createDiagnosticName?: () => string;
  createEventStream?: typeof createRunEventStream;
  createRequestId?: () => string;
  createOperatorService: () => RunnerService | Promise<RunnerService>;
  createService: (
    subscriber: RunnerAuthenticatedSubscriber
  ) => RunnerService | Promise<RunnerService>;
  diagnoseSandbox: (name: string) => Promise<RunnerDiagnosticResult>;
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

function invalidRequest(dependencies: RunnerHttpDependencies): Response {
  return runnerErrorResponse(dependencies, "invalid_request");
}

function agentNotFound(dependencies: RunnerHttpDependencies): Response {
  return runnerErrorResponse(dependencies, "not_found");
}

function runNotFound(dependencies: RunnerHttpDependencies): Response {
  return runnerErrorResponse(dependencies, "run_not_found");
}

function runnerUnavailable(dependencies: RunnerHttpDependencies): Response {
  return runnerErrorResponse(dependencies, "runner_unavailable");
}

function providerUnavailable(dependencies: RunnerHttpDependencies): Response {
  return runnerErrorResponse(dependencies, "provider_unavailable");
}

function providerRejected(dependencies: RunnerHttpDependencies): Response {
  return runnerErrorResponse(dependencies, "provider_rejected");
}

function staleVersion(dependencies: RunnerHttpDependencies): Response {
  return runnerErrorResponse(dependencies, "stale_version");
}

function subscriberFailure(
  dependencies: RunnerHttpDependencies,
  decision: Exclude<RunnerSubscriberAuthorization, { kind: "allowed" }>
): Response {
  return decision.kind === "unauthorized"
    ? runnerErrorResponse(dependencies, "unauthorized")
    : runnerErrorResponse(dependencies, "subscription_required");
}

function secretFailure(
  dependencies: RunnerHttpDependencies,
  decision: Exclude<RunnerSecretAuthorization, { kind: "allowed" }>,
  unavailableCode: "diagnostic_unavailable" | "reconcile_unavailable"
): Response {
  return decision.kind === "unavailable"
    ? runnerErrorResponse(dependencies, unavailableCode)
    : runnerErrorResponse(dependencies, "unauthorized", {
        message: "Operator token was rejected.",
      });
}

function abuseFailure(
  dependencies: RunnerHttpDependencies,
  admission: Exclude<AbuseAdmission, { kind: "allowed" }>
): Response {
  if (admission.kind === "denied") {
    const response = runnerErrorResponse(dependencies, "rate_limited");
    response.headers.set("retry-after", String(admission.retryAfterSeconds));
    return response;
  }
  return runnerErrorResponse(dependencies, "abuse_control_unavailable");
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

function isResponse(
  value: Response | RunnerAuthenticatedSubscriber
): value is Response {
  return value instanceof Response;
}

function diagnosticName(dependencies: RunnerHttpDependencies): string {
  return (
    dependencies.createDiagnosticName?.() ??
    `coven-diagnostic-${randomUUID().replaceAll("-", "")}`
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

async function warmAndReconcile(
  service: RunnerService,
  principal: RunnerAuthenticatedSubscriber["principal"],
  agentId: string
): Promise<void> {
  const warm = await service.warmAgent(principal, agentId);
  switch (warm.kind) {
    case "found":
    case "in_progress":
    case "not_found":
    case "provider_rejected":
    case "ready":
    case "stale_version":
    case "unavailable":
    case "unsupported_harness":
      break;
    default:
      unreachableResult(warm);
  }
  await service.reconcileAndDispatch();
}

function reconciliationCounts(
  result: RunnerReconciliationExecutionResult
): RunnerReconciliationExecutionResult {
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
    "terminalLeaseCleaned",
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
  const counts = {
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
    terminalLeaseCleaned: result.terminalLeaseCleaned,
  };
  if (result.execution === "skipped") {
    if (result.reason !== "overlap") {
      throw new RunnerServiceError(
        "reconcile_unavailable",
        "Runner reconciliation returned an invalid skip reason."
      );
    }
    return { ...counts, execution: "skipped", reason: "overlap" };
  }
  if (result.execution !== "executed") {
    throw new RunnerServiceError(
      "reconcile_unavailable",
      "Runner reconciliation returned an invalid execution indicator."
    );
  }
  return { ...counts, execution: "executed" };
}

function serviceFailure(
  dependencies: RunnerHttpDependencies,
  error: unknown
): Response {
  if (error instanceof RunnerServiceError) {
    switch (error.code) {
      case "diagnostic_unavailable":
        return runnerErrorResponse(dependencies, "diagnostic_unavailable");
      case "reconcile_unavailable":
        return runnerErrorResponse(dependencies, "reconcile_unavailable");
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
        return runnerErrorResponse(dependencies, "internal_error");
      }
    }
  }
  dependencies.logger?.error("Runner HTTP request failed.", {
    name: error instanceof Error ? error.name : typeof error,
  });
  return runnerErrorResponse(dependencies, "internal_error");
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
            return runnerErrorResponse(dependencies, "harness_unsupported", {
              message: `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
            });
          case "conflict":
            return runnerErrorResponse(dependencies, "operation_conflict");
          case "unavailable":
            return runnerUnavailable(dependencies);
          case "created":
            schedule(dependencies, async () => {
              await warmAndReconcile(
                service,
                context.principal,
                created.agent.id
              );
            });
            return runnerJsonResponse(
              agentEnvelopeSchema,
              { agent: created.agent },
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
            return runnerErrorResponse(dependencies, "busy");
          case "stale_version":
            return staleVersion(dependencies);
          case "unavailable":
            return deleted.source === "provider"
              ? providerUnavailable(dependencies)
              : runnerUnavailable(dependencies);
          case "provider_rejected":
            return providerRejected(dependencies);
          case "deleted":
            return runnerJsonResponse(okEnvelopeSchema, { ok: true });
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
        return runnerJsonResponse(
          diagnosticResponseSchema,
          await dependencies.diagnoseSandbox(diagnosticName(dependencies))
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
          ? runnerJsonResponse(agentEnvelopeSchema, { agent: result.agent })
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
        return runnerJsonResponse(harnessesEnvelopeSchema, {
          harnesses: await service.listHarnesses(),
        });
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
          ? runnerJsonResponse(runSnapshotEnvelopeSchema, {
              apiVersion: AGENT_RUNNER_API_VERSION,
              run: result.run,
            })
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
        return runnerJsonResponse(agentRunnerHealthSchema, {
          apiVersion: AGENT_RUNNER_API_VERSION,
          capabilities: [...AGENT_RUNNER_CAPABILITIES],
          minimumClientVersion: "1.0.0",
          mode: "cloud",
        });
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
          ? runnerJsonResponse(runListEnvelopeSchema, {
              apiVersion: AGENT_RUNNER_API_VERSION,
              runs: result.runs,
            })
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
        return runnerJsonResponse(agentsEnvelopeSchema, {
          agents: await service.listAgents(context.principal),
        });
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
            return runnerErrorResponse(dependencies, "harness_unsupported", {
              message: `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
            });
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
        const scheduled = admitAndScheduleRunnerRun(result, {
          dispatchClaim: service.dispatchClaim,
          reconcile: service.reconcileAndDispatch,
          schedule: dependencies.after ?? (() => undefined),
        });
        switch (scheduled.kind) {
          case "invalid":
            return invalidRequest(dependencies);
          case "not_found":
            return agentNotFound(dependencies);
          case "unsupported_harness":
            return runnerErrorResponse(dependencies, "harness_unsupported", {
              message: `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
            });
          case "refused":
            switch (scheduled.code) {
              case "operation_conflict":
                return runnerErrorResponse(dependencies, "operation_conflict", {
                  message:
                    "Operation ID was already used for a different request.",
                  retryable: false,
                });
              case "busy":
                return runnerErrorResponse(dependencies, "busy", {
                  message: "The cloud runner is busy. Try again later.",
                });
              case "lifecycle_conflict":
                return runnerErrorResponse(
                  dependencies,
                  "agent_decommissioning"
                );
              case "admission_unavailable":
                return runnerErrorResponse(
                  dependencies,
                  "admission_unavailable"
                );
              default:
                return unreachableResult(scheduled.code);
            }
          case "accepted":
            return runnerJsonResponse(
              runSnapshotEnvelopeSchema,
              {
                apiVersion: AGENT_RUNNER_API_VERSION,
                run: scheduled.run,
              },
              { status: 202 }
            );
          default:
            return unreachableResult(scheduled);
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
            schedule(dependencies, async () => {
              await service.reconcileAndDispatch();
            });
            return runnerJsonResponse(
              runSnapshotEnvelopeSchema,
              {
                apiVersion: AGENT_RUNNER_API_VERSION,
                run: result.run,
              },
              { status: 202 }
            );
          case "stale_version":
            return runnerErrorResponse(dependencies, "stale_version");
          case "unavailable":
            return result.source === "provider"
              ? runnerErrorResponse(dependencies, "provider_unavailable")
              : runnerUnavailable(dependencies);
          case "cleanup_required":
            schedule(dependencies, async () => {
              await service.reconcileAndDispatch();
            });
            return runnerErrorResponse(dependencies, "cleanup_required");
          case "sandbox_reset_required":
            schedule(dependencies, async () => {
              await service.reconcileAndDispatch();
            });
            return runnerErrorResponse(dependencies, "cleanup_required");
          case "stopped":
            schedule(dependencies, async () => {
              await service.reconcileAndDispatch();
            });
            return runnerJsonResponse(runSnapshotEnvelopeSchema, {
              apiVersion: AGENT_RUNNER_API_VERSION,
              run: result.run,
            });
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
          case "busy":
            return runnerErrorResponse(dependencies, "busy");
          case "invalid":
            return invalidRequest(dependencies);
          case "unsupported_harness":
            return runnerErrorResponse(dependencies, "harness_unsupported", {
              message: `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
            });
          case "stale_version":
            return staleVersion(dependencies);
          case "unavailable":
            return runnerUnavailable(dependencies);
          case "updated":
            schedule(dependencies, async () => {
              await warmAndReconcile(
                service,
                context.principal,
                result.agent.id
              );
            });
            return runnerJsonResponse(agentEnvelopeSchema, {
              agent: result.agent,
            });
          default:
            return unreachableResult(result);
        }
      }),
  };
}
