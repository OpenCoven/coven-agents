import { auth } from "@/app/(auth)/auth";
import { claimsForUser, mintRunnerToken } from "@/lib/agents/runner-token";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";

export async function POST() {
  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const privateKey = process.env.RUNNER_SIGNING_KEY;
  if (!privateKey) {
    return Response.json({ error: "signing_unavailable" }, { status: 503 });
  }

  const token = await mintRunnerToken(
    claimsForUser({ id: access.userId, type: access.session.kind }),
    privateKey
  );

  return Response.json({ token });
}
