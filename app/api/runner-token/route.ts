import { runnerRunScopeSchema } from "@opencoven/agent-contracts";
import { ipAddress } from "@vercel/functions";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { readBoundedJson } from "@/lib/abuse/body";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import {
  type RunnerKeyRing,
  runnerKeyRingFromEnvironment,
} from "@/lib/agents/key-ring";
import { runScopedIdentityWritesEnabled } from "@/lib/agents/run-scope-rollout";
import { claimsForUser, mintRunnerToken } from "@/lib/agents/runner-token";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";

const runnerTokenRequestSchema = z
  .object({ run: runnerRunScopeSchema.optional() })
  .strict();

export async function POST(request: Request) {
  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "runner_token",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  /**
   * A body-less POST is the common case — the console's background mint
   * sends none — and it must not be mistaken for a malformed one. Branching
   * on `request.body` was that mistake: in the deployed Node runtime an
   * empty POST arrives as a non-null empty stream, the strict reader calls
   * zero bytes invalid, and every plain mint 400s — observed in production
   * as "Could not obtain a runner identity (400)" on a signed-in console
   * that had done nothing wrong. The route-specific empty-body value preserves
   * strict validation for malformed, unknown-field, oversized, and run-scoped
   * JSON while treating an actual zero-byte stream as an unscoped request.
   */
  let run: z.infer<typeof runnerRunScopeSchema> | undefined;
  if (request.body) {
    const body = await readBoundedJson(
      request,
      1024,
      runnerTokenRequestSchema,
      {
        emptyBody: {},
      }
    );
    if (body.kind === "too_large") {
      return Response.json({ error: "request_too_large" }, { status: 413 });
    }
    if (body.kind === "invalid") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    run = runScopedIdentityWritesEnabled(
      process.env.RUN_SCOPED_IDENTITY_WRITES_ENABLED
    )
      ? body.value.run
      : undefined;
  }

  let keyRing: RunnerKeyRing;
  try {
    keyRing = await runnerKeyRingFromEnvironment();
  } catch {
    return Response.json({ error: "signing_unavailable" }, { status: 503 });
  }

  let token: string;
  try {
    token = await mintRunnerToken(
      claimsForUser(
        {
          authVersion: access.authVersion,
          id: access.userId,
          type: access.session.kind,
        },
        run
      ),
      keyRing
    );
  } catch {
    return Response.json({ error: "signing_unavailable" }, { status: 503 });
  }

  return Response.json({ token });
}
