import { runnerClaimsSchema } from "@opencoven/agent-contracts";
import { readBoundedJson } from "@/lib/abuse/body";
import { authorizeInternalRequest } from "@/lib/auth/internal-service";
import {
  decideRunnerAuthority,
  type RunnerAuthorityInput,
} from "@/lib/auth/runner-authority";
import { findUserById } from "@/lib/db/queries";

const MAX_AUTHORITY_BODY_BYTES = 1024;
const runnerAuthorityRequestSchema = runnerClaimsSchema
  .pick({
    authVersion: true,
    plan: true,
    sub: true,
    tenant: true,
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  if (
    !authorizeInternalRequest(request, process.env.RUNNER_SERVICE_TOKEN ?? "")
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await readBoundedJson(
    request,
    MAX_AUTHORITY_BODY_BYTES,
    runnerAuthorityRequestSchema
  );
  if (body.kind !== "ok") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let owner: Awaited<ReturnType<typeof findUserById>>;
  try {
    owner = await findUserById(body.value.sub);
  } catch {
    return Response.json({ error: "authority_unavailable" }, { status: 503 });
  }

  const decision = decideRunnerAuthority(
    body.value as RunnerAuthorityInput,
    owner
      ? {
          authVersion: owner.authVersion,
          id: owner.id,
          subscribedUntil: owner.subscribedUntil,
        }
      : null,
    new Date()
  );

  if (decision.kind === "allowed") {
    return Response.json({ allowed: true });
  }
  if (decision.kind === "subscription_required") {
    return Response.json({ error: "subscription_required" }, { status: 403 });
  }
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
