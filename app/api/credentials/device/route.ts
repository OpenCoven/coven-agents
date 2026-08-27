import "server-only";

import { ipAddress } from "@vercel/functions";
import { z } from "zod";
import { auth } from "@/app/(auth)/auth";
import { readBoundedJson } from "@/lib/abuse/body";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import {
  type IdempotencyResponse,
  idempotencyResultResponse,
  runIdempotentOperation,
} from "@/lib/abuse/idempotency";
import { encryptedIdempotencyResponseStorage } from "@/lib/abuse/idempotency-response";
import { abusePolicyFor } from "@/lib/abuse/policy";
import { subscriberAccessResponse } from "@/lib/auth/subscriber-access";
import { authorizeSubscriberAccess } from "@/lib/auth/subscriber-authorization.server";
import {
  exchangeDeviceCode,
  startDeviceFlow,
} from "@/lib/credentials/github-device";
import { credentialKek, credentialKekVersion } from "@/lib/credentials/kek";
import { serializeCredential } from "@/lib/credentials/shape";
import { putCredential } from "@/lib/credentials/store";
import { databaseIdempotencyStore } from "@/lib/db/queries";

const devicePollSchema = z.object({
  deviceCode: z.string().min(1),
});

const DEVICE_RESULT_RETENTION_MS = 15 * 60_000;
const deviceStartResponseStorage = encryptedIdempotencyResponseStorage(
  credentialKek,
  credentialKekVersion
);

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
function clientId(): string | null {
  return process.env.AUTH_GITHUB_ID ?? null;
}

export async function POST(request: Request) {
  const access = await authorizeSubscriberAccess(await auth());
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "credential_device_start",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const result = await runIdempotentOperation({
    idempotencyKey: request.headers.get("idempotency-key"),
    operation: "credential_device_start",
    ownerId: access.userId,
    perform: async (): Promise<IdempotencyResponse> => {
      const id = clientId();
      if (!id) {
        return {
          body: { error: "github_unconfigured" },
          status: 503,
        };
      }

      const started = await startDeviceFlow(id);
      return started
        ? { body: { ...started }, status: 200 }
        : { body: { error: "device_flow_failed" }, status: 502 };
    },
    request: {},
    responseStorage: deviceStartResponseStorage,
    retentionMs: DEVICE_RESULT_RETENTION_MS,
    store: databaseIdempotencyStore,
  });

  return idempotencyResultResponse(result);
}

export async function PUT(request: Request) {
  const access = await authorizeSubscriberAccess(await auth());
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "credential_device_poll",
    userId: access.userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const id = clientId();

  if (!id) {
    return Response.json({ error: "github_unconfigured" }, { status: 503 });
  }

  const body = await readBoundedJson(
    request,
    abusePolicyFor("credential_device_poll").bodyBytes,
    devicePollSchema
  );
  if (body.kind === "too_large") {
    return Response.json({ error: "request_too_large" }, { status: 413 });
  }
  if (body.kind === "invalid") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await exchangeDeviceCode(
    { clientId: id, deviceCode: body.value.deviceCode },
    Date.now()
  );

  if (result.kind !== "authorized") {
    return Response.json({ status: result.kind });
  }

  await putCredential(
    access.session,
    "copilot",
    serializeCredential(result.credential)
  );

  return Response.json({ status: "authorized" });
}
