import { ipAddress } from "@vercel/functions";
import { auth } from "@/app/(auth)/auth";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import {
  type RunnerKeyRing,
  runnerKeyRingFromEnvironment,
} from "@/lib/agents/key-ring";
import { claimsForUser, mintRunnerToken } from "@/lib/agents/runner-token";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";

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

  let keyRing: RunnerKeyRing;
  try {
    keyRing = await runnerKeyRingFromEnvironment();
  } catch {
    return Response.json({ error: "signing_unavailable" }, { status: 503 });
  }

  let token: string;
  try {
    token = await mintRunnerToken(
      claimsForUser({
        authVersion: access.authVersion,
        id: access.userId,
        type: access.session.kind,
      }),
      keyRing
    );
  } catch {
    return Response.json({ error: "signing_unavailable" }, { status: 503 });
  }

  return Response.json({ token });
}
