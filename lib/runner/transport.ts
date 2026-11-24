import "server-only";

import { randomUUID } from "node:crypto";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_LIMITS,
  agentIdSchema,
  type RunErrorEnvelope,
  runErrorEnvelopeSchema,
} from "@opencoven/agent-contracts";
import { z } from "zod";
import { readBoundedJson } from "@/lib/abuse/body";
import type { AbuseEnforcementInput } from "@/lib/abuse/enforce";
import { abusePolicyFor } from "@/lib/abuse/policy";
import { parseCanonicalApplicationOrigin } from "@/lib/auth/application-origin";

export const RUNNER_ERROR_CODES = [
  "abuse_control_unavailable",
  "admission_unavailable",
  "agent_decommissioning",
  "body_too_large",
  "busy",
  "cleanup_required",
  "diagnostic_unavailable",
  "harness_unsupported",
  "internal_error",
  "invalid_event_cursor",
  "invalid_request",
  "not_found",
  "operation_conflict",
  "origin_rejected",
  "provider_rejected",
  "provider_unavailable",
  "rate_limited",
  "reconcile_unavailable",
  "run_not_found",
  "runner_unavailable",
  "sandbox_binding_refused",
  "sandbox_trust_conflict",
  "stale_version",
  "subscription_required",
  "unauthorized",
  "unsupported_media_type",
] as const;

export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

type RunnerErrorDefinition = Readonly<{
  message: string;
  retryable: boolean;
  status: number;
}>;

const RUNNER_ERROR_DEFINITIONS = {
  abuse_control_unavailable: {
    message: "Please try again later.",
    retryable: true,
    status: 503,
  },
  admission_unavailable: {
    message: "Run admission is temporarily unavailable. Try again later.",
    retryable: true,
    status: 503,
  },
  agent_decommissioning: {
    message: "Agent decommission is still in progress. Try again later.",
    retryable: true,
    status: 409,
  },
  body_too_large: {
    message: "Request body is too large.",
    retryable: false,
    status: 413,
  },
  busy: {
    message: "The agent is busy. Try again later.",
    retryable: true,
    status: 409,
  },
  cleanup_required: {
    message: "Run cancellation is awaiting cleanup. Try again later.",
    retryable: true,
    status: 503,
  },
  diagnostic_unavailable: {
    message: "Please try again later.",
    retryable: true,
    status: 503,
  },
  harness_unsupported: {
    message: "The selected harness runtime is unsupported.",
    retryable: false,
    status: 400,
  },
  internal_error: {
    message: "Runner request failed.",
    retryable: true,
    status: 500,
  },
  invalid_event_cursor: {
    message: "Last-Event-ID must be a non-negative integer.",
    retryable: false,
    status: 400,
  },
  invalid_request: {
    message: "Request validation failed.",
    retryable: false,
    status: 400,
  },
  not_found: {
    message: "Agent was not found.",
    retryable: false,
    status: 404,
  },
  operation_conflict: {
    message: "Agent creation conflicted with a concurrent operation.",
    retryable: true,
    status: 409,
  },
  origin_rejected: {
    message: "Request origin was rejected.",
    retryable: false,
    status: 403,
  },
  provider_rejected: {
    message: "Runner provider rejected the operation.",
    retryable: false,
    status: 422,
  },
  provider_unavailable: {
    message: "Runner provider is temporarily unavailable. Try again later.",
    retryable: true,
    status: 503,
  },
  rate_limited: {
    message: "Too many requests. Try again later.",
    retryable: true,
    status: 429,
  },
  reconcile_unavailable: {
    message: "Please try again later.",
    retryable: true,
    status: 503,
  },
  run_not_found: {
    message: "Run was not found.",
    retryable: false,
    status: 404,
  },
  runner_unavailable: {
    message: "Runner service is temporarily unavailable. Try again later.",
    retryable: true,
    status: 503,
  },
  sandbox_binding_refused: {
    message:
      "The run's sandbox binding did not match the agent's recorded sandbox; nothing was created or changed.",
    retryable: false,
    status: 409,
  },
  sandbox_trust_conflict: {
    message:
      "The sandbox has unrestricted execution history and cannot run this restricted task.",
    retryable: false,
    status: 409,
  },
  stale_version: {
    message: "The agent changed concurrently. Try again.",
    retryable: true,
    status: 409,
  },
  subscription_required: {
    message: "An active subscription is required.",
    retryable: false,
    status: 403,
  },
  unauthorized: {
    message: "Identity was rejected.",
    retryable: false,
    status: 401,
  },
  unsupported_media_type: {
    message: "Request content type must be application/json.",
    retryable: false,
    status: 400,
  },
} as const satisfies Record<RunnerErrorCode, RunnerErrorDefinition>;

export type RunnerTransportDependencies = Readonly<{
  appOrigin?: string | (() => string | null);
  createRequestId?: () => string;
}>;

export type RunnerJsonResult<T> =
  | Readonly<{ kind: "ok"; value: T }>
  | Readonly<{ kind: "response"; response: Response }>;

type RunnerErrorOptions = Readonly<{
  details?: string;
  message?: string;
  retryable?: boolean;
}>;

const emptyObjectSchema = z.object({}).strict();

function canonicalOrigin(value: string): string | null {
  try {
    return parseCanonicalApplicationOrigin("Origin", value);
  } catch {
    return null;
  }
}

function configuredOrigin(
  dependencies: RunnerTransportDependencies
): string | null {
  if (!Object.hasOwn(dependencies, "appOrigin")) {
    return null;
  }
  try {
    const value =
      typeof dependencies.appOrigin === "function"
        ? dependencies.appOrigin()
        : dependencies.appOrigin;
    return value ? canonicalOrigin(value) : null;
  } catch {
    return null;
  }
}

function requestId(dependencies: RunnerTransportDependencies): string {
  const candidate = dependencies.createRequestId?.() ?? randomUUID();
  const normalized =
    typeof candidate === "string"
      ? candidate.trim().slice(0, AGENT_RUNNER_LIMITS.maxRequestIdLength)
      : "";
  return normalized || randomUUID();
}

export function runnerErrorResponse(
  dependencies: RunnerTransportDependencies,
  code: RunnerErrorCode,
  options: RunnerErrorOptions = {}
): Response {
  const definition = RUNNER_ERROR_DEFINITIONS[code];
  const body: RunErrorEnvelope = runErrorEnvelopeSchema.parse({
    apiVersion: AGENT_RUNNER_API_VERSION,
    error: {
      code,
      ...(options.details ? { details: options.details } : {}),
      message: options.message ?? definition.message,
      retryable: options.retryable ?? definition.retryable,
    },
    requestId: requestId(dependencies),
  });
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status: definition.status,
  });
}

export function runnerJsonResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  init?: ResponseInit
): Response {
  return Response.json(schema.parse(value), init);
}

export function validateRunnerMutationRequest(
  request: Request,
  dependencies: RunnerTransportDependencies,
  options: Readonly<{ jsonBody: boolean }>
): Response | null {
  const requestOrigin = canonicalOrigin(new URL(request.url).origin);
  const suppliedOrigin = request.headers.get("origin");
  const origin = suppliedOrigin ? canonicalOrigin(suppliedOrigin) : null;
  const expectedOrigin = Object.hasOwn(dependencies, "appOrigin")
    ? configuredOrigin(dependencies)
    : requestOrigin;

  if (
    requestOrigin === null ||
    expectedOrigin === null ||
    origin === null ||
    origin !== requestOrigin ||
    requestOrigin !== expectedOrigin
  ) {
    return runnerErrorResponse(dependencies, "origin_rejected");
  }

  if (options.jsonBody) {
    const mediaType = request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      return runnerErrorResponse(dependencies, "unsupported_media_type");
    }
  }

  return null;
}

export function invalidRunnerId(
  dependencies: RunnerTransportDependencies,
  value: string
): Response | null {
  return agentIdSchema.safeParse(value).success
    ? null
    : runnerErrorResponse(dependencies, "invalid_request");
}

export async function readRunnerJson<T>(
  request: Request,
  route: AbuseEnforcementInput["route"],
  schema: z.ZodType<T>,
  dependencies: RunnerTransportDependencies,
  options?: { emptyBody?: unknown }
): Promise<RunnerJsonResult<T>> {
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
    response: runnerErrorResponse(
      dependencies,
      body.kind === "too_large" ? "body_too_large" : "invalid_request"
    ),
  };
}

export function readEmptyRunnerJson(
  request: Request,
  route: AbuseEnforcementInput["route"],
  dependencies: RunnerTransportDependencies
): Promise<RunnerJsonResult<Record<string, never>>> {
  return readRunnerJson(request, route, emptyObjectSchema, dependencies, {
    emptyBody: {},
  });
}

export function parseRunnerEventCursor(
  request: Request,
  dependencies: RunnerTransportDependencies
): number | Response {
  const raw = request.headers.get("last-event-id");
  if (raw === null) {
    return 0;
  }
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) {
    return runnerErrorResponse(dependencies, "invalid_event_cursor");
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed)
    ? parsed
    : runnerErrorResponse(dependencies, "invalid_event_cursor");
}

export function unreachableRunnerResult(value: never): never {
  throw new Error(
    `Runner HTTP adapter received an unsupported result: ${JSON.stringify(value)}`
  );
}
