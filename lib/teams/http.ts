import "server-only";

import { createHash, randomUUID } from "node:crypto";
import {
  AGENT_RUNNER_LIMITS,
  createSkillInputSchema,
  createTeamInputSchema,
  expectedVersionInputSchema,
  okEnvelopeSchema,
  skillEnvelopeSchema,
  skillIdSchema,
  skillsEnvelopeSchema,
  teamEnvelopeSchema,
  teamIdSchema,
  teamsEnvelopeSchema,
  updateSkillInputSchema,
  updateTeamInputSchema,
} from "@opencoven/agent-contracts";
import { z } from "zod";
import { readBoundedJson } from "@/lib/abuse/body";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import {
  type IdempotencyResponse,
  type IdempotencyResult,
  type IdempotencyStore,
  runIdempotentOperation,
} from "@/lib/abuse/idempotency";
import { abusePolicyFor } from "@/lib/abuse/policy";
import { parseCanonicalApplicationOrigin } from "@/lib/auth/application-origin";
import type {
  RunnerAuth,
  RunnerAuthenticatedSubscriber,
  RunnerSubscriberAuthorization,
} from "@/lib/runner/auth";
import type { TeamService } from "./service";

export const TEAM_ERROR_CODES = [
  "abuse_control_unavailable",
  "body_too_large",
  "idempotency_conflict",
  "idempotency_key_required",
  "invalid_request",
  "invalid_idempotency_key",
  "not_found",
  "origin_rejected",
  "rate_limited",
  "request_in_progress",
  "resource_conflict",
  "resource_in_use",
  "stale_version",
  "subscription_required",
  "unauthorized",
  "unsupported_media_type",
] as const;

export type TeamErrorCode = (typeof TEAM_ERROR_CODES)[number];

type ErrorDefinition = Readonly<{
  message: string;
  retryable: boolean;
  status: number;
}>;

const ERROR_DEFINITIONS = {
  abuse_control_unavailable: {
    message: "Please try again later.",
    retryable: true,
    status: 503,
  },
  body_too_large: {
    message: "Request body is too large.",
    retryable: false,
    status: 413,
  },
  idempotency_conflict: {
    message: "Idempotency key was already used for a different request.",
    retryable: false,
    status: 409,
  },
  idempotency_key_required: {
    message: "Idempotency-Key header is required.",
    retryable: false,
    status: 400,
  },
  invalid_idempotency_key: {
    message: "Idempotency-Key header is invalid.",
    retryable: false,
    status: 400,
  },
  invalid_request: {
    message: "Request validation failed.",
    retryable: false,
    status: 400,
  },
  not_found: {
    message: "Resource was not found.",
    retryable: false,
    status: 404,
  },
  origin_rejected: {
    message: "Request origin was rejected.",
    retryable: false,
    status: 403,
  },
  rate_limited: {
    message: "Too many requests. Try again later.",
    retryable: true,
    status: 429,
  },
  request_in_progress: {
    message: "A request with this idempotency key is still in progress.",
    retryable: true,
    status: 409,
  },
  resource_conflict: {
    message: "Resource creation conflicted with another operation.",
    retryable: true,
    status: 409,
  },
  resource_in_use: {
    message: "Resource is still referenced and cannot be deleted.",
    retryable: false,
    status: 409,
  },
  stale_version: {
    message: "The resource changed concurrently. Try again.",
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
} as const satisfies Record<TeamErrorCode, ErrorDefinition>;

const CREATE_RETENTION_MS = 24 * 60 * 60_000;
const emptyObjectSchema = z.object({}).strict();

function idempotencyOperation(
  operation: "skill_create" | "team_create",
  tenant: string
): string {
  const tenantScope = createHash("sha256")
    .update(tenant, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `${operation}:${tenantScope}`;
}

export type TeamHttpDependencies = Readonly<{
  appOrigin?: string | (() => string | null);
  auth: RunnerAuth;
  createRequestId?: () => string;
  createService: (
    subscriber: RunnerAuthenticatedSubscriber
  ) => TeamService | Promise<TeamService>;
  enforceAbuse: (input: AbuseEnforcementInput) => Promise<AbuseAdmission>;
  idempotencyStore: IdempotencyStore;
  ipAddress: (request: Request) => string | null;
}>;

export type TeamHttpHandlers = Readonly<{
  createSkill: (request: Request) => Promise<Response>;
  createTeam: (request: Request) => Promise<Response>;
  deleteSkill: (request: Request, id: string) => Promise<Response>;
  deleteTeam: (request: Request, id: string) => Promise<Response>;
  getSkill: (request: Request, id: string) => Promise<Response>;
  getTeam: (request: Request, id: string) => Promise<Response>;
  listSkills: (request: Request) => Promise<Response>;
  listTeams: (request: Request) => Promise<Response>;
  updateSkill: (request: Request, id: string) => Promise<Response>;
  updateTeam: (request: Request, id: string) => Promise<Response>;
}>;

function canonicalOrigin(value: string): string | null {
  try {
    return parseCanonicalApplicationOrigin("Origin", value);
  } catch {
    return null;
  }
}

function configuredOrigin(dependencies: TeamHttpDependencies): string | null {
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

function requestId(dependencies: TeamHttpDependencies): string {
  const candidate = dependencies.createRequestId?.() ?? randomUUID();
  const normalized =
    typeof candidate === "string"
      ? candidate.trim().slice(0, AGENT_RUNNER_LIMITS.maxRequestIdLength)
      : "";
  return normalized || randomUUID();
}

function errorResponse(
  dependencies: TeamHttpDependencies,
  code: TeamErrorCode
): Response {
  const definition = ERROR_DEFINITIONS[code];
  return Response.json(errorEnvelope(dependencies, code), {
    headers: { "cache-control": "no-store" },
    status: definition.status,
  });
}

function errorEnvelope(
  dependencies: TeamHttpDependencies,
  code: TeamErrorCode
) {
  const definition = ERROR_DEFINITIONS[code];
  return {
    error: {
      code,
      message: definition.message,
      retryable: definition.retryable,
    },
    requestId: requestId(dependencies),
  };
}

function jsonResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  status = 200
): Response {
  return Response.json(schema.parse(value), {
    headers: { "cache-control": "no-store" },
    status,
  });
}

function idempotencyFailure(
  dependencies: TeamHttpDependencies,
  code: TeamErrorCode
): IdempotencyResponse {
  return {
    body: errorEnvelope(dependencies, code),
    status: ERROR_DEFINITIONS[code].status,
  };
}

function createResponse<T>(
  dependencies: TeamHttpDependencies,
  result: IdempotencyResult,
  schema: z.ZodType<T>
): Response {
  if (result.kind !== "response") {
    const codeByKind = {
      conflict: "idempotency_conflict",
      in_progress: "request_in_progress",
      invalid_key: "invalid_idempotency_key",
      missing_key: "idempotency_key_required",
    } as const;
    return errorResponse(dependencies, codeByKind[result.kind]);
  }

  const headers = new Headers({ "cache-control": "no-store" });
  if (result.replayed) {
    headers.set("idempotency-replayed", "true");
  }
  const body =
    result.response.status >= 200 && result.response.status < 300
      ? schema.parse(result.response.body)
      : result.response.body;
  return Response.json(body, {
    headers,
    status: result.response.status,
  });
}

function validateMutation(
  request: Request,
  dependencies: TeamHttpDependencies,
  jsonBody: boolean
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
    return errorResponse(dependencies, "origin_rejected");
  }

  if (jsonBody) {
    const mediaType = request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      return errorResponse(dependencies, "unsupported_media_type");
    }
  }
  return null;
}

function subscriberFailure(
  dependencies: TeamHttpDependencies,
  decision: Exclude<RunnerSubscriberAuthorization, { kind: "allowed" }>
): Response {
  return errorResponse(
    dependencies,
    decision.kind === "unauthorized" ? "unauthorized" : "subscription_required"
  );
}

function abuseFailure(
  dependencies: TeamHttpDependencies,
  admission: Exclude<AbuseAdmission, { kind: "allowed" }>
): Response {
  if (admission.kind === "denied") {
    const response = errorResponse(dependencies, "rate_limited");
    response.headers.set("retry-after", String(admission.retryAfterSeconds));
    return response;
  }
  return errorResponse(dependencies, "abuse_control_unavailable");
}

async function authorize(
  request: Request,
  route: AbuseEnforcementInput["route"],
  dependencies: TeamHttpDependencies,
  mutation?: "json" | "without_body"
): Promise<Response | RunnerAuthenticatedSubscriber> {
  if (mutation) {
    const rejected = validateMutation(
      request,
      dependencies,
      mutation === "json"
    );
    if (rejected) {
      return rejected;
    }
  }
  const subscriber = await dependencies.auth.authorizeSubscriber();
  if (subscriber.kind !== "allowed") {
    return subscriberFailure(dependencies, subscriber);
  }
  const admission = await dependencies.enforceAbuse({
    failClosed: true,
    ip: dependencies.ipAddress(request),
    route,
    tenant: subscriber.principal.tenant,
    userId: subscriber.userId,
  });
  return admission.kind === "allowed"
    ? subscriber
    : abuseFailure(dependencies, admission);
}

function isResponse(
  value: Response | RunnerAuthenticatedSubscriber
): value is Response {
  return value instanceof Response;
}

async function readJson<T>(
  request: Request,
  route: AbuseEnforcementInput["route"],
  schema: z.ZodType<T>,
  dependencies: TeamHttpDependencies
): Promise<T | Response> {
  const body = await readBoundedJson(
    request,
    abusePolicyFor(route).bodyBytes,
    schema
  );
  if (body.kind === "ok") {
    return body.value;
  }
  return errorResponse(
    dependencies,
    body.kind === "too_large" ? "body_too_large" : "invalid_request"
  );
}

async function readEmptyBody(
  request: Request,
  route: "skill_delete" | "team_delete",
  dependencies: TeamHttpDependencies
): Promise<Response | null> {
  const body = await readBoundedJson(
    request,
    abusePolicyFor(route).bodyBytes,
    emptyObjectSchema,
    { emptyBody: {} }
  );
  if (body.kind === "ok") {
    return null;
  }
  return errorResponse(
    dependencies,
    body.kind === "too_large" ? "body_too_large" : "invalid_request"
  );
}

function invalidId(
  dependencies: TeamHttpDependencies,
  schema: typeof skillIdSchema | typeof teamIdSchema,
  id: string
): Response | null {
  return schema.safeParse(id).success
    ? null
    : errorResponse(dependencies, "invalid_request");
}

function deleteVersion(
  request: Request,
  dependencies: TeamHttpDependencies
): number | Response {
  const entries = [...new URL(request.url).searchParams.entries()];
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "expectedVersion" ||
    !/^(?:0|[1-9]\d*)$/u.test(entries[0][1])
  ) {
    return errorResponse(dependencies, "invalid_request");
  }
  const expectedVersion = Number(entries[0][1]);
  const parsed = expectedVersionInputSchema.safeParse({ expectedVersion });
  return parsed.success
    ? parsed.data.expectedVersion
    : errorResponse(dependencies, "invalid_request");
}

function safely(
  _dependencies: TeamHttpDependencies,
  handler: () => Promise<Response>
): Promise<Response> {
  return handler();
}

export function createTeamHttpHandlers(
  dependencies: TeamHttpDependencies
): TeamHttpHandlers {
  return {
    createSkill: (request) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(
          request,
          "skill_write",
          dependencies,
          "json"
        );
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const body = await readJson(
          request,
          "skill_write",
          createSkillInputSchema,
          dependencies
        );
        if (body instanceof Response) {
          return body;
        }
        const result = await runIdempotentOperation({
          idempotencyKey: request.headers.get("idempotency-key"),
          operation: idempotencyOperation(
            "skill_create",
            subscriber.principal.tenant
          ),
          ownerId: subscriber.userId,
          perform: async () => {
            const service = await dependencies.createService(subscriber);
            const serviceResult = await service.createSkill(
              subscriber.principal,
              body
            );
            switch (serviceResult.kind) {
              case "created":
                return {
                  body: skillEnvelopeSchema.parse({
                    skill: serviceResult.skill,
                  }),
                  status: 201,
                };
              case "conflict":
                return idempotencyFailure(dependencies, "resource_conflict");
              case "invalid":
                return idempotencyFailure(dependencies, "invalid_request");
              default:
                return unreachable(serviceResult);
            }
          },
          request: body,
          retentionMs: CREATE_RETENTION_MS,
          store: dependencies.idempotencyStore,
        });
        return createResponse(dependencies, result, skillEnvelopeSchema);
      }),

    createTeam: (request) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(
          request,
          "team_write",
          dependencies,
          "json"
        );
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const body = await readJson(
          request,
          "team_write",
          createTeamInputSchema,
          dependencies
        );
        if (body instanceof Response) {
          return body;
        }
        const result = await runIdempotentOperation({
          idempotencyKey: request.headers.get("idempotency-key"),
          operation: idempotencyOperation(
            "team_create",
            subscriber.principal.tenant
          ),
          ownerId: subscriber.userId,
          perform: async () => {
            const service = await dependencies.createService(subscriber);
            const serviceResult = await service.createTeam(
              subscriber.principal,
              body
            );
            switch (serviceResult.kind) {
              case "created":
                return {
                  body: teamEnvelopeSchema.parse({
                    team: serviceResult.team,
                  }),
                  status: 201,
                };
              case "conflict":
                return idempotencyFailure(dependencies, "resource_conflict");
              case "not_found":
                return idempotencyFailure(dependencies, "not_found");
              case "invalid":
                return idempotencyFailure(dependencies, "invalid_request");
              default:
                return unreachable(serviceResult);
            }
          },
          request: body,
          retentionMs: CREATE_RETENTION_MS,
          store: dependencies.idempotencyStore,
        });
        return createResponse(dependencies, result, teamEnvelopeSchema);
      }),

    deleteSkill: (request, id) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(
          request,
          "skill_delete",
          dependencies,
          "without_body"
        );
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const rejectedBody = await readEmptyBody(
          request,
          "skill_delete",
          dependencies
        );
        if (rejectedBody) {
          return rejectedBody;
        }
        const invalid = invalidId(dependencies, skillIdSchema, id);
        if (invalid) {
          return invalid;
        }
        const expectedVersion = deleteVersion(request, dependencies);
        if (expectedVersion instanceof Response) {
          return expectedVersion;
        }
        const service = await dependencies.createService(subscriber);
        const result = await service.deleteSkill(
          subscriber.principal,
          id,
          expectedVersion
        );
        return deleteResponse(dependencies, result);
      }),

    deleteTeam: (request, id) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(
          request,
          "team_delete",
          dependencies,
          "without_body"
        );
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const rejectedBody = await readEmptyBody(
          request,
          "team_delete",
          dependencies
        );
        if (rejectedBody) {
          return rejectedBody;
        }
        const invalid = invalidId(dependencies, teamIdSchema, id);
        if (invalid) {
          return invalid;
        }
        const expectedVersion = deleteVersion(request, dependencies);
        if (expectedVersion instanceof Response) {
          return expectedVersion;
        }
        const service = await dependencies.createService(subscriber);
        const result = await service.deleteTeam(
          subscriber.principal,
          id,
          expectedVersion
        );
        return deleteResponse(dependencies, result);
      }),

    getSkill: (request, id) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(request, "skill_read", dependencies);
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const invalid = invalidId(dependencies, skillIdSchema, id);
        if (invalid) {
          return invalid;
        }
        const service = await dependencies.createService(subscriber);
        const result = await service.getSkill(subscriber.principal, id);
        return result.kind === "found"
          ? jsonResponse(skillEnvelopeSchema, { skill: result.skill })
          : errorResponse(dependencies, "not_found");
      }),

    getTeam: (request, id) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(request, "team_read", dependencies);
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const invalid = invalidId(dependencies, teamIdSchema, id);
        if (invalid) {
          return invalid;
        }
        const service = await dependencies.createService(subscriber);
        const result = await service.getTeam(subscriber.principal, id);
        return result.kind === "found"
          ? jsonResponse(teamEnvelopeSchema, { team: result.team })
          : errorResponse(dependencies, "not_found");
      }),

    listSkills: (request) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(request, "skill_read", dependencies);
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const service = await dependencies.createService(subscriber);
        return jsonResponse(skillsEnvelopeSchema, {
          skills: await service.listSkills(subscriber.principal),
        });
      }),

    listTeams: (request) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(request, "team_read", dependencies);
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const service = await dependencies.createService(subscriber);
        return jsonResponse(teamsEnvelopeSchema, {
          teams: await service.listTeams(subscriber.principal),
        });
      }),

    updateSkill: (request, id) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(
          request,
          "skill_write",
          dependencies,
          "json"
        );
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const invalid = invalidId(dependencies, skillIdSchema, id);
        if (invalid) {
          return invalid;
        }
        const body = await readJson(
          request,
          "skill_write",
          updateSkillInputSchema,
          dependencies
        );
        if (body instanceof Response) {
          return body;
        }
        const service = await dependencies.createService(subscriber);
        const result = await service.updateSkill(
          subscriber.principal,
          id,
          body
        );
        switch (result.kind) {
          case "updated":
            return jsonResponse(skillEnvelopeSchema, { skill: result.skill });
          case "not_found":
            return errorResponse(dependencies, "not_found");
          case "stale_version":
            return errorResponse(dependencies, "stale_version");
          case "invalid":
            return errorResponse(dependencies, "invalid_request");
          default:
            return unreachable(result);
        }
      }),

    updateTeam: (request, id) =>
      safely(dependencies, async () => {
        const subscriber = await authorize(
          request,
          "team_write",
          dependencies,
          "json"
        );
        if (isResponse(subscriber)) {
          return subscriber;
        }
        const invalid = invalidId(dependencies, teamIdSchema, id);
        if (invalid) {
          return invalid;
        }
        const body = await readJson(
          request,
          "team_write",
          updateTeamInputSchema,
          dependencies
        );
        if (body instanceof Response) {
          return body;
        }
        const service = await dependencies.createService(subscriber);
        const result = await service.updateTeam(subscriber.principal, id, body);
        switch (result.kind) {
          case "updated":
            return jsonResponse(teamEnvelopeSchema, { team: result.team });
          case "not_found":
            return errorResponse(dependencies, "not_found");
          case "stale_version":
            return errorResponse(dependencies, "stale_version");
          case "invalid":
            return errorResponse(dependencies, "invalid_request");
          default:
            return unreachable(result);
        }
      }),
  };
}

function deleteResponse(
  dependencies: TeamHttpDependencies,
  result: Awaited<ReturnType<TeamService["deleteSkill"]>>
): Response {
  switch (result.kind) {
    case "deleted":
      return jsonResponse(okEnvelopeSchema, { ok: true });
    case "conflict":
      return errorResponse(dependencies, "resource_in_use");
    case "not_found":
      return errorResponse(dependencies, "not_found");
    case "stale_version":
      return errorResponse(dependencies, "stale_version");
    case "invalid":
      return errorResponse(dependencies, "invalid_request");
    default:
      return unreachable(result);
  }
}

function unreachable(value: never): never {
  throw new Error(
    `Team HTTP adapter received an unsupported result: ${JSON.stringify(value)}`
  );
}
