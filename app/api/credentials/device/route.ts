import "server-only";

import { auth } from "@/app/(auth)/auth";
import {
  exchangeDeviceCode,
  startDeviceFlow,
} from "@/lib/credentials/github-device";
import { serializeCredential } from "@/lib/credentials/shape";
import { putCredential } from "@/lib/credentials/store";
import { isSubscriber, toSession } from "@/lib/session";

/**
 * Connects Copilot without the tenant ever seeing a token.
 *
 * POST starts a device authorization and returns the code to show. PUT polls
 * for the result and stores the credential once the person approves.
 *
 * The device code is returned to the browser deliberately. It is single-use,
 * short-lived, and useless without this app's client id — GitHub's own CLIs
 * hold it client-side for the same reason. What is never returned is the
 * access or refresh token: those go straight into encrypted storage.
 */
async function subscriberSession() {
  const session = await auth();

  if (!session?.user?.id) {
    return null;
  }

  const resolved = toSession({
    id: session.user.id,
    type: session.user.type,
  });

  return isSubscriber(resolved) ? resolved : null;
}

function clientId(): string | null {
  return process.env.AUTH_GITHUB_ID ?? null;
}

export async function POST() {
  const session = await subscriberSession();

  if (!session) {
    return Response.json({ error: "subscription_required" }, { status: 403 });
  }

  const id = clientId();

  if (!id) {
    return Response.json({ error: "github_unconfigured" }, { status: 503 });
  }

  const started = await startDeviceFlow(id);

  if (!started) {
    return Response.json({ error: "device_flow_failed" }, { status: 502 });
  }

  return Response.json(started, {
    headers: { "cache-control": "no-store" },
  });
}

export async function PUT(request: Request) {
  const session = await subscriberSession();

  if (!session) {
    return Response.json({ error: "subscription_required" }, { status: 403 });
  }

  const id = clientId();

  if (!id) {
    return Response.json({ error: "github_unconfigured" }, { status: 503 });
  }

  const body = (await request.json().catch(() => null)) as {
    deviceCode?: unknown;
  } | null;

  if (typeof body?.deviceCode !== "string" || !body.deviceCode) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await exchangeDeviceCode(
    { clientId: id, deviceCode: body.deviceCode },
    Date.now()
  );

  if (result.kind !== "authorized") {
    return Response.json({ status: result.kind });
  }

  await putCredential(
    session,
    "copilot",
    serializeCredential(result.credential)
  );

  return Response.json({ status: "authorized" });
}
