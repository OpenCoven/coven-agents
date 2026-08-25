import { auth } from "@/app/(auth)/auth";
import { connectionDecision } from "@/lib/agents/connection-access";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";

/**
 * Serves the cloud runner connection to a signed-in subscriber.
 *
 * This exists so the console never asks a human to paste a deployment token.
 * That step was pure friction and a standing outage: rotating the token broke
 * every browser at once, and the only symptom was "Runner token was rejected"
 * with nothing to indicate the value had simply gone stale.
 *
 * The decision lives in `connectionDecision` because it governs who may reach
 * the owner's worker, and a route handler is unreachable from a unit test.
 */
export async function GET() {
  const access = await authorizeSubscriberAccess(await auth());
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const decision = connectionDecision({
    controlToken: process.env.AGENT_CONTROL_TOKEN,
    endpoint:
      process.env.NEXT_PUBLIC_CLOUD_RUNNER_URL ?? process.env.CLOUD_RUNNER_URL,
    plan: access.session.kind,
  });

  switch (decision.kind) {
    case "allowed":
      return Response.json(
        { endpoint: decision.endpoint, token: decision.token },
        // Never cached: it is a credential, and a shared cache would serve one
        // user's connection to the next caller.
        { headers: { "cache-control": "no-store" } }
      );
    case "forbidden":
      return Response.json({ error: "subscription_required" }, { status: 403 });
    case "unconfigured":
      return Response.json({ error: "runner_unconfigured" }, { status: 503 });
    default:
      return Response.json({ error: "unauthorized" }, { status: 401 });
  }
}
