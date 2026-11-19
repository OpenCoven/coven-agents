import { ipAddress } from "@vercel/functions";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { configuredApplicationOrigin } from "@/lib/auth/application-origin";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import {
  issueOwnerCredential,
  listOwnerCredentials,
  revokeOwnerCredential,
} from "@/lib/db/owner-credentials";
import { ownerCredentialScopes } from "@/lib/runner/owner-credential";
import {
  invalidRunnerId,
  readRunnerJson,
  runnerErrorResponse,
  validateRunnerMutationRequest,
} from "@/lib/runner/transport";

type Context = { params: Promise<{ id: string }> };
const transport = { appOrigin: () => configuredApplicationOrigin(process.env) };
const issuance = z.strictObject({
  scopes: z
    .array(z.enum(ownerCredentialScopes))
    .min(1)
    .max(ownerCredentialScopes.length)
    .refine((scopes) => new Set(scopes).size === scopes.length),
});
const revocation = z.strictObject({ id: z.uuid() });

async function manage(request: Request, context: Context) {
  if (request.headers.has("authorization")) {
    return runnerErrorResponse(transport, "unauthorized");
  }
  const write = request.method !== "GET";
  if (write) {
    const rejected = validateRunnerMutationRequest(request, transport, {
      jsonBody: true,
    });
    if (rejected) {
      return rejected;
    }
  }
  const access = await authorizeSubscriberAccess(await auth());
  if (access.kind !== "allowed") {
    return runnerErrorResponse(transport, access.kind);
  }
  const owner = {
    authVersion: access.authVersion,
    tenant: access.session.tenant,
    userId: access.userId,
  };
  const route = write ? "runner_write" : "runner_read";
  const budget = await enforceAbusePolicy({
    failClosed: true,
    ip: ipAddress(request) ?? null,
    route,
    tenant: owner.tenant,
    userId: owner.userId,
  });
  if (budget.kind !== "allowed") {
    const response = runnerErrorResponse(
      transport,
      budget.kind === "denied" ? "rate_limited" : "abuse_control_unavailable"
    );
    if (budget.kind === "denied") {
      response.headers.set("retry-after", String(budget.retryAfterSeconds));
    }
    return response;
  }
  const { id } = await context.params;
  const invalid = invalidRunnerId(transport, id);
  if (invalid) {
    return invalid;
  }
  const headers = { "cache-control": "no-store" };
  if (!write) {
    return Response.json(
      { credentials: await listOwnerCredentials(owner, id) },
      { headers }
    );
  }
  if (request.method === "DELETE") {
    const body = await readRunnerJson(request, route, revocation, transport);
    if (body.kind !== "ok") {
      return body.response;
    }
    return (await revokeOwnerCredential(owner, id, body.value.id))
      ? new Response(null, { headers, status: 204 })
      : runnerErrorResponse(transport, "not_found");
  }
  const body = await readRunnerJson(request, route, issuance, transport);
  if (body.kind !== "ok") {
    return body.response;
  }
  const result = await issueOwnerCredential(owner, id, body.value.scopes);
  return result
    ? Response.json(result, { headers, status: 201 })
    : runnerErrorResponse(transport, "not_found");
}

export { manage as DELETE, manage as GET, manage as POST };
