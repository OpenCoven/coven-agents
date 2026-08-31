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
  createDeviceFlowBinding,
  verifyDeviceFlowBinding,
} from "@/lib/credentials/device-flow-binding";
import { runCredentialDevicePoll } from "@/lib/credentials/device-poll";
import {
  exchangeDeviceCode,
  startDeviceFlow,
} from "@/lib/credentials/github-device";
import { credentialKek, credentialKekVersion } from "@/lib/credentials/kek";
import { serializeCredential } from "@/lib/credentials/shape";
import { prepareCredentialWrite } from "@/lib/credentials/store";
import {
  databaseCredentialDevicePollStore,
  databaseIdempotencyStore,
} from "@/lib/db/queries";

const devicePollSchema = z.object({
  binding: z.string().min(1).max(128),
  deviceCode: z.string().min(1).max(2048),
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

function bindingSecret(): string | null {
  return process.env.AUTH_SECRET ?? null;
}

export async function POST(request: Request) {
  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
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
      const secret = bindingSecret();
      if (!(id && secret)) {
        return {
          body: { error: "github_unconfigured" },
          status: 503,
        };
      }

      const started = await startDeviceFlow(id);
      if (!started) {
        return { body: { error: "device_flow_failed" }, status: 502 };
      }
      const currentAccess = await authorizeSubscriberAccess(session);
      if (
        currentAccess.kind !== "allowed" ||
        currentAccess.userId !== access.userId ||
        currentAccess.authVersion !== access.authVersion
      ) {
        return {
          body: { error: "subscription_required" },
          status: 403,
        };
      }
      return {
        body: {
          ...started,
          binding: await createDeviceFlowBinding(
            secret,
            access.userId,
            started.deviceCode
          ),
        },
        status: 200,
      };
    },
    request: {},
    responseStorage: deviceStartResponseStorage,
    retentionMs: DEVICE_RESULT_RETENTION_MS,
    store: databaseIdempotencyStore,
  });

  return idempotencyResultResponse(result);
}

export async function PUT(request: Request) {
  const session = await auth();
  const access = await authorizeSubscriberAccess(session);
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

  const secret = bindingSecret();
  if (!secret) {
    return Response.json({ error: "github_unconfigured" }, { status: 503 });
  }
  const ownsStart = await verifyDeviceFlowBinding(
    secret,
    access.userId,
    body.value.deviceCode,
    body.value.binding
  );
  if (!ownsStart) {
    return Response.json({ status: "owner_changed" }, { status: 409 });
  }

  const id = clientId();
  const result = await runCredentialDevicePoll({
    authVersion: access.authVersion,
    deviceCode: body.value.deviceCode,
    exchange: () =>
      id
        ? exchangeDeviceCode(
            { clientId: id, deviceCode: body.value.deviceCode },
            Date.now()
          )
        : Promise.resolve({ kind: "unavailable" }),
    idempotencyKey: request.headers.get("idempotency-key"),
    ownerId: access.userId,
    prepareCredential: (credential) =>
      prepareCredentialWrite(
        access.session,
        "copilot",
        serializeCredential(credential)
      ),
    revalidateAuthority: async () => {
      const currentAccess = await authorizeSubscriberAccess(session);
      return (
        currentAccess.kind === "allowed" &&
        currentAccess.userId === access.userId &&
        currentAccess.authVersion === access.authVersion
      );
    },
    store: databaseCredentialDevicePollStore,
  });

  return idempotencyResultResponse(result);
}
