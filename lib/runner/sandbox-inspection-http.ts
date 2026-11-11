import "server-only";

import {
  sandboxInspectionRequestSchema,
  sandboxInspectionResultSchema,
} from "@opencoven/agent-contracts";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import type { RunnerAuth, RunnerAuthenticatedSubscriber } from "./auth";
import type { RunnerService } from "./service";
import {
  invalidRunnerId,
  type RunnerTransportDependencies,
  readRunnerJson,
  runnerErrorResponse,
  runnerJsonResponse,
} from "./transport";

const ROUTE = "runner_sandbox_inspect" as const;

export type SandboxInspectionHttpDependencies = RunnerTransportDependencies &
  Readonly<{
    auth: Pick<RunnerAuth, "authorizeBearerOwner">;
    createService: (
      subscriber: RunnerAuthenticatedSubscriber
    ) =>
      | Pick<RunnerService, "inspectSandbox">
      | Promise<Pick<RunnerService, "inspectSandbox">>;
    enforceAbuse: (input: AbuseEnforcementInput) => Promise<AbuseAdmission>;
    ipAddress: (request: Request) => string | null;
  }>;

function jsonMediaType(request: Request): boolean {
  return (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() === "application/json"
  );
}

/**
 * `POST /api/agents/:id/sandbox/inspection`
 *
 * Read-only despite the verb: the expected sandbox ID travels in the body so
 * it stays out of URLs and access logs. The caller is an owner presenting a
 * bearer identity token; cookies and operator secrets are not consulted, so
 * there is no ambient credential for a cross-site request to ride on. Order
 * is media type, then authentication, then abuse control, before the body is
 * read or any service, database, or provider work begins.
 */
export function createSandboxInspectionHandler(
  dependencies: SandboxInspectionHttpDependencies
): (request: Request, agentId: string) => Promise<Response> {
  return async (request, agentId) => {
    try {
      if (!jsonMediaType(request)) {
        return runnerErrorResponse(dependencies, "unsupported_media_type");
      }
      const owner = dependencies.auth.authorizeBearerOwner
        ? await dependencies.auth.authorizeBearerOwner(request)
        : ({ kind: "unavailable" } as const);
      if (owner.kind === "unavailable") {
        return runnerErrorResponse(dependencies, "runner_unavailable");
      }
      if (owner.kind !== "allowed") {
        return runnerErrorResponse(
          dependencies,
          owner.kind === "unauthorized"
            ? "unauthorized"
            : "subscription_required"
        );
      }
      const admission = await dependencies.enforceAbuse({
        failClosed: true,
        ip: dependencies.ipAddress(request),
        route: ROUTE,
        tenant: owner.principal.tenant,
        userId: owner.userId,
      });
      if (admission.kind !== "allowed") {
        if (admission.kind === "denied") {
          const limited = runnerErrorResponse(dependencies, "rate_limited");
          limited.headers.set(
            "retry-after",
            String(admission.retryAfterSeconds)
          );
          return limited;
        }
        return runnerErrorResponse(dependencies, "abuse_control_unavailable");
      }
      const invalid = invalidRunnerId(dependencies, agentId);
      if (invalid) {
        return invalid;
      }
      const body = await readRunnerJson(
        request,
        ROUTE,
        sandboxInspectionRequestSchema,
        dependencies
      );
      if (body.kind !== "ok") {
        return body.response;
      }

      const service = await dependencies.createService(owner);
      const result = await service.inspectSandbox(
        owner.principal,
        agentId,
        body.value
      );
      switch (result.outcome) {
        case "unauthorized":
          // Same response for a missing agent and another tenant's agent.
          return runnerErrorResponse(dependencies, "not_found");
        case "unavailable":
          return runnerErrorResponse(
            dependencies,
            result.source === "provider"
              ? "provider_unavailable"
              : "runner_unavailable"
          );
        default:
          return runnerJsonResponse(sandboxInspectionResultSchema, result, {
            headers: { "cache-control": "no-store" },
          });
      }
    } catch {
      // The original failure can carry a provider URL or database detail.
      return runnerErrorResponse(dependencies, "internal_error");
    }
  };
}
