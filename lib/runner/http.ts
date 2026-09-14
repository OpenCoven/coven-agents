import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  agentEnvelopeSchema,
  agentRunnerHealthSchema,
  agentsEnvelopeSchema,
  createAgentInputSchema,
  okEnvelopeSchema,
  runErrorEnvelopeSchema,
  runListEnvelopeSchema,
  runLiveViewEnvelopeSchema,
  runSnapshotEnvelopeSchema,
  startRunInputSchema,
  updateAgentInputSchema,
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
import {
  type IdempotencyResult,
  type IdempotencyStore,
  type JsonValue,
  runIdempotentOperation,
} from "@/lib/abuse/idempotency";
import { admitAndScheduleRunnerRun } from "./admit-and-schedule";
import type { RunnerReconciliationExecutionResult } from "./attempt-reconcile";
import type {
  RunnerAuth,
  RunnerAuthenticatedSubscriber,
  RunnerSecretAuthorization,
  RunnerSubscriberAuthorization,
} from "./auth";
import {
  DAYTONA_MAX_SNAPSHOT_NAME_LENGTH,
  isDaytonaVersionedSnapshotName,
} from "./daytona/snapshot-name";
import { RunnerServiceError } from "./errors";
import type {
  RunnerDiagnosticResult,
  RunnerInventoryResourcesResult,
  RunnerRepairResourcesResult,
  RunnerService,
} from "./service";
import { createRunEventStream } from "./sse";
import {
  readRunnerJson as boundedJson,
  readEmptyRunnerJson as emptyBody,
  invalidRunnerId as invalidId,
  parseRunnerEventCursor as parseLastEventId,
  runnerErrorResponse,
  runnerJsonResponse,
  unreachableRunnerResult as unreachableResult,
  validateRunnerMutationRequest,
} from "./transport";

const diagnosticResponseSchema = z
  .object({
    exitCode: z.number().int().min(0).max(255),
    ok: z.boolean(),
    output: z.string().max(1024),
    snapshot: z
      .object({
        name: z
          .string()
          .max(DAYTONA_MAX_SNAPSHOT_NAME_LENGTH)
          .refine(isDaytonaVersionedSnapshotName),
        resources: z
          .object({
            cpu: z.number().int().positive(),
            disk: z.number().int().positive(),
            memory: z.number().int().positive(),
          })
          .strict(),
        target: z.enum(["eu", "us"]),
      })
      .strict(),
  })
  .strict();
const resourceInventoryResponseSchema = z
  .object({
    ambiguityReasons: z
      .object({
        configurationDrift: z.number().int().nonnegative(),
        databaseBounded: z.number().int().nonnegative(),
        duplicateIdentity: z.number().int().nonnegative(),
        duplicateProviderId: z.number().int().nonnegative(),
        multipleMappings: z.number().int().nonnegative(),
        pendingLifecycle: z.number().int().nonnegative(),
        unresolved: z.number().int().nonnegative(),
      })
      .strict(),
    ambiguous: z.number().int().nonnegative(),
    appOwnedMappings: z.number().int().nonnegative(),
    configurationDrift: z.array(
      z
        .object({
          count: z.number().int().positive(),
          field: z.enum([
            "autoArchiveInterval",
            "autoDeleteInterval",
            "autoDestroyAt",
            "autoPauseInterval",
            "autoStopInterval",
            "cpu",
            "disk",
            "domainAllowList",
            "labels",
            "linkedSandbox",
            "memory",
            "name",
            "public",
            "snapshot",
            "target",
            "volumes",
            "warmPool",
          ]),
          relation: z.enum(["above", "below", "different"]),
        })
        .strict()
    ),
    databaseCapped: z.boolean(),
    examined: z.number().int().nonnegative(),
    matched: z.number().int().nonnegative(),
    providerCapped: z.boolean(),
    states: z
      .object({
        active: z.number().int().nonnegative(),
        archived: z.number().int().nonnegative(),
        other: z.number().int().nonnegative(),
        stopped: z.number().int().nonnegative(),
      })
      .strict(),
    status: z.enum(["bounded", "complete"]),
    unowned: z.number().int().nonnegative(),
    version: z.literal(1),
  })
  .strict();
const AGENT_CREATE_RETENTION_MS = 24 * 60 * 60_000;
const resourceRepairResponseSchema = z
  .object({
    appOwnedMappings: z.number().int().nonnegative(),
    batchCapped: z.boolean(),
    databaseCapped: z.boolean(),
    deferred: z.number().int().nonnegative(),
    eligible: z.number().int().nonnegative(),
    examined: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    providerCapped: z.boolean(),
    refused: z.number().int().nonnegative(),
    repaired: z.number().int().nonnegative(),
    status: z.enum(["bounded", "complete"]),
    unchanged: z.number().int().nonnegative(),
    version: z.literal(1),
  })
  .strict();

type RunnerHttpLogger = Readonly<{
  error: (
    message: string,
    details: Readonly<{ name: "runner_service" | "unknown" }>
  ) => void;
}>;

type AfterTask = Promise<unknown> | (() => void | Promise<void>);

type After = (task: AfterTask) => void;

export type RunnerHttpDependencies = Readonly<{
  after?: After;
  /**
   * How often an open event stream nudges reconciliation while its run is
   * still live, so a watching console sees steps at that cadence rather than
   * the cron's. Zero disables the nudge. Defaults from
   * `RUNNER_LIVE_TAIL_MS`, then to ten seconds.
   */
  liveTailMs?: number;
  now?: () => number;
  appOrigin?: string | (() => string | null);
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
  idempotencyStore?: IdempotencyStore;
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
  getRunLiveView: (request: Request, runId: string) => Promise<Response>;
  health: (request: Request) => Promise<Response>;
  listAgentRuns: (request: Request, agentId: string) => Promise<Response>;
  listAgents: (request: Request) => Promise<Response>;
  inventoryResources: (request: Request) => Promise<Response>;
  prewarmTenant: (request: Request) => Promise<Response>;
  reconcile: (request: Request) => Promise<Response>;
  repairResources: (request: Request) => Promise<Response>;
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

function agentCreateOperation(tenant: string): string {
  const tenantScope = createHash("sha256")
    .update(tenant, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `runner_agent_create:${tenantScope}`;
}

function agentCreateIdempotencyResponse(
  dependencies: RunnerHttpDependencies,
  result: IdempotencyResult
): Response {
  if (result.kind !== "response") {
    if (result.kind === "conflict") {
      return runnerErrorResponse(dependencies, "operation_conflict");
    }
    if (result.kind === "in_progress") {
      return runnerErrorResponse(dependencies, "runner_unavailable", {
        message: "Agent creation is already in progress.",
        retryable: true,
      });
    }
    return invalidRequest(dependencies);
  }

  const headers = new Headers({ "cache-control": "no-store" });
  if (result.replayed) {
    headers.set("idempotency-replayed", "true");
  }
  return Response.json(result.response.body, {
    headers,
    status: result.response.status,
  });
}

async function idempotencyResponseBody(response: Response): Promise<JsonValue> {
  const body: unknown = await response.json();
  return response.ok
    ? agentEnvelopeSchema.parse(body)
    : runErrorEnvelopeSchema.parse(body);
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

/**
 * Cookie mutations deliberately run origin/media type → auth → abuse before
 * any body read, service construction, provider call, or scheduled work.
 */
async function authorizeSubscriber(
  request: Request,
  route: AbuseEnforcementInput["route"],
  dependencies: RunnerHttpDependencies,
  mutation?: "empty" | "json"
): Promise<Response | RunnerAuthenticatedSubscriber> {
  if (mutation) {
    const rejected = validateRunnerMutationRequest(request, dependencies, {
      jsonBody: mutation === "json",
    });
    if (rejected) {
      return rejected;
    }
  }
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

function scheduleLiveRunReconciliation(
  dependencies: RunnerHttpDependencies,
  service: RunnerService,
  live: boolean
): void {
  if (!live) {
    return;
  }
  schedule(dependencies, async () => {
    await service.reconcileAndDispatch();
  });
}

export const DEFAULT_LIVE_TAIL_MS = 10_000;
const MIN_LIVE_TAIL_MS = 2000;
const MAX_LIVE_TAIL_MS = 5 * 60_000;

export function liveTailMsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): number {
  const raw = environment.RUNNER_LIVE_TAIL_MS?.trim();
  if (!raw) {
    return DEFAULT_LIVE_TAIL_MS;
  }
  const parsed = Number(raw);
  if (parsed === 0) {
    return 0;
  }
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_LIVE_TAIL_MS ||
    parsed > MAX_LIVE_TAIL_MS
  ) {
    throw new Error(
      `RUNNER_LIVE_TAIL_MS must be 0 or an integer between ${MIN_LIVE_TAIL_MS} and ${MAX_LIVE_TAIL_MS} milliseconds.`
    );
  }
  return parsed;
}

function startRetainedReconciliation(
  dependencies: RunnerHttpDependencies,
  service: RunnerService
): Promise<void> {
  const logger = dependencies.logger ?? console;
  let canStart = false;
  // Register the hot promise before taking leases, not a callback that waits
  // for the stream to close. Failed registration must not orphan active work.
  const task = Promise.resolve()
    .then(async () => {
      if (canStart) {
        await service.reconcileAndDispatch();
      }
    })
    .catch((error: unknown) => {
      logger.error("Runner live reconciliation failed.", {
        name:
          error instanceof RunnerServiceError ? "runner_service" : "unknown",
      });
    });
  try {
    dependencies.after?.(task);
    canStart = true;
  } catch {
    logger.error("Runner live reconciliation could not be retained.", {
      name: "unknown",
    });
  }
  return task;
}

/**
 * Turns an open event stream into a heartbeat for its run.
 *
 * The harness writes to a sandbox log that only reconciliation reads, so
 * without this a watcher sees a new burst of steps once a minute, when cron
 * fires. Each nudge is a full leased `reconcileAndDispatch`; the lease makes
 * concurrent watchers and cron collapse into one pass, and the attempt lease
 * (`RUNNER_ATTEMPT_LEASE_MS`) decides whether a pass re-reads the sandbox.
 * Each nudge starts eagerly and is retained independently of stream closure.
 * A failure here never disturbs the stream.
 */
function liveTail(
  dependencies: RunnerHttpDependencies,
  service: RunnerService
): (terminal: boolean) => void {
  const interval = dependencies.liveTailMs ?? liveTailMsFromEnvironment();
  if (interval <= 0) {
    return () => undefined;
  }
  const now = dependencies.now ?? Date.now;
  let last = now();
  let inFlight = false;
  return (terminal) => {
    if (terminal || inFlight || now() - last < interval) {
      return;
    }
    last = now();
    inFlight = true;
    startRetainedReconciliation(dependencies, service).finally(() => {
      inFlight = false;
    });
  };
}

function startLiveRunReconciliation(
  dependencies: RunnerHttpDependencies,
  service: RunnerService,
  live: boolean
): void {
  if (!dependencies.after || !live) {
    return;
  }
  startRetainedReconciliation(dependencies, service);
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

function resourceInventoryCounts(
  result: Exclude<RunnerInventoryResourcesResult, { kind: "unavailable" }>
) {
  const { kind: _kind, ...counts } = result;
  return resourceInventoryResponseSchema.parse(counts);
}

function resourceRepairCounts(
  result: Exclude<RunnerRepairResourcesResult, { kind: "unavailable" }>
) {
  const { kind: _kind, ...counts } = result;
  return resourceRepairResponseSchema.parse(counts);
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
        dependencies.logger?.error(
          "Runner service error code is unsupported.",
          {
            name: "runner_service",
          }
        );
        return runnerErrorResponse(dependencies, "internal_error");
      }
    }
  }
  dependencies.logger?.error("Runner HTTP request failed.", {
    name: "unknown",
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
          dependencies,
          "json"
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
        const createAgentResponse = async (
          providerIdempotencyKey?: string
        ): Promise<Response> => {
          const service = await dependencies.createService(context);
          const created = await service.createAgent(
            context.principal,
            body.value,
            providerIdempotencyKey
          );
          switch (created.kind) {
            case "invalid":
              return invalidRequest(dependencies);
            case "unsupported_harness":
              return runnerErrorResponse(dependencies, "harness_unsupported", {
                message: `Daytona agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
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
        };

        const idempotencyKey = request.headers.get("idempotency-key");
        if (idempotencyKey === null) {
          return createAgentResponse();
        }
        if (!dependencies.idempotencyStore) {
          return runnerUnavailable(dependencies);
        }
        const result = await runIdempotentOperation({
          idempotencyKey,
          operation: agentCreateOperation(context.principal.tenant),
          ownerId: context.userId,
          perform: async ({ providerIdempotencyKey }) => {
            const response = await createAgentResponse(providerIdempotencyKey);
            return {
              body: await idempotencyResponseBody(response),
              status: response.status,
            };
          },
          request: body.value,
          retentionMs: AGENT_CREATE_RETENTION_MS,
          store: dependencies.idempotencyStore,
        });
        return agentCreateIdempotencyResponse(dependencies, result);
      }),

    deleteAgent: (request, agentId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_write",
          dependencies,
          "empty"
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
        if (result.kind !== "found") {
          return runNotFound(dependencies);
        }
        scheduleLiveRunReconciliation(
          dependencies,
          service,
          result.run.status === "queued" || result.run.status === "running"
        );
        return runnerJsonResponse(runSnapshotEnvelopeSchema, {
          apiVersion: AGENT_RUNNER_API_VERSION,
          run: result.run,
        });
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
        startLiveRunReconciliation(dependencies, service, !initial.terminal);
        const nudge = liveTail(dependencies, service);
        const stream = eventStream({
          lastEventId,
          read: async (cursor) => {
            const page = await service.readRunEvents(
              context.principal,
              runId,
              cursor
            );
            if (page.kind !== "found") {
              return null;
            }
            nudge(page.terminal);
            return { events: page.events, terminal: page.terminal };
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

    getRunLiveView: (request, runId) =>
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
        const result = await service.getRunLiveView(context.principal, runId);
        if (result.kind === "not_found") {
          return runNotFound(dependencies);
        }
        return runnerJsonResponse(
          runLiveViewEnvelopeSchema,
          { apiVersion: AGENT_RUNNER_API_VERSION, view: result },
          { headers: { "cache-control": "no-store" } }
        );
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

    inventoryResources: (request) =>
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
        const result = await service.inventoryResources();
        if (result.kind === "unavailable") {
          return result.source === "provider"
            ? providerUnavailable(dependencies)
            : runnerUnavailable(dependencies);
        }
        return Response.json(resourceInventoryCounts(result), {
          headers: { "cache-control": "no-store" },
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
        if (result.kind !== "found") {
          return agentNotFound(dependencies);
        }
        scheduleLiveRunReconciliation(
          dependencies,
          service,
          result.runs.some(
            (run) => run.status === "queued" || run.status === "running"
          )
        );
        return runnerJsonResponse(runListEnvelopeSchema, {
          apiVersion: AGENT_RUNNER_API_VERSION,
          runs: result.runs,
        });
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
          dependencies,
          "empty"
        );
        if (isResponse(context)) {
          return context;
        }
        const body = await emptyBody(request, "runner_write", dependencies);
        if (body.kind !== "ok") {
          return body.response;
        }
        const service = await dependencies.createService(context);
        const result = await service.prewarmMostRecent(context.principal, {
          signal: request.signal,
        });
        switch (result.kind) {
          case "none":
          case "not_found":
            return new Response(null, { status: 204 });
          case "unsupported_harness":
            return runnerErrorResponse(dependencies, "harness_unsupported", {
              message: `Daytona agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
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

    repairResources: (request) =>
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
        const result = await service.repairResources({
          deadline: Date.now() + 240_000,
        });
        if (result.kind === "unavailable") {
          return result.source === "provider"
            ? providerUnavailable(dependencies)
            : runnerUnavailable(dependencies);
        }
        return Response.json(resourceRepairCounts(result), {
          headers: { "cache-control": "no-store" },
        });
      }),

    startAgentRun: (request, agentId) =>
      safely(dependencies, async () => {
        const context = await authorizeSubscriber(
          request,
          "runner_run_start",
          dependencies,
          "json"
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
              message: `Daytona agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
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
                  message: "Daytona execution is busy. Try again later.",
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
          dependencies,
          "empty"
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
          dependencies,
          "json"
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
          updateAgentInputSchema,
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
              message: `Daytona agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
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
