import {
  MAX_RUNNER_TOKEN_BYTES,
  verifyRunnerToken,
} from "@opencoven/agent-contracts";
import { z } from "zod";
import { readBoundedJson } from "@/lib/abuse/body";
import { runnerVerificationKeyRingFromEnvironment } from "@/lib/agents/key-ring";
import { authorizeInternalRequest } from "@/lib/auth/internal-service";
import {
  decideRunnerAuthority,
  type RunnerAuthorityInput,
} from "@/lib/auth/runner-authority";
import { findUserById } from "@/lib/db/queries";

const MAX_AUTHORITY_BODY_BYTES = MAX_RUNNER_TOKEN_BYTES + 32;
const runnerAuthorityRequestSchema = z
  .object({
    token: z.string().min(1).max(MAX_RUNNER_TOKEN_BYTES),
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
  if (body.kind === "too_large") {
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  if (body.kind === "invalid") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let verifyKeyRing: Awaited<
    ReturnType<typeof runnerVerificationKeyRingFromEnvironment>
  >;
  try {
    verifyKeyRing = await runnerVerificationKeyRingFromEnvironment();
  } catch {
    return Response.json({ error: "identity_unavailable" }, { status: 503 });
  }

  const claims = await verifyRunnerToken(body.value.token, verifyKeyRing);
  if (!claims) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let owner: Awaited<ReturnType<typeof findUserById>>;
  try {
    owner = await findUserById(claims.sub);
  } catch {
    return Response.json({ error: "authority_unavailable" }, { status: 503 });
  }

  const decision = decideRunnerAuthority(
    claims as RunnerAuthorityInput,
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
