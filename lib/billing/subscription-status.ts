import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import {
  authVersionMatches,
  validAuthVersion,
} from "@/lib/auth/session-revocation";
import type { VerifiedJwtIdentity } from "@/lib/auth/verified-jwt";
import { isCanonicalUuid } from "@/lib/session";
import { isSubscribedAt } from "@/lib/subscription";

export type SubscriptionStatusResponse = {
  active: boolean;
  checkoutEnabled: boolean;
  subscribedUntil: string | null;
};

export type SubscriptionStatusDependencies = {
  authenticate: (request: Request) => Promise<VerifiedJwtIdentity | null>;
  checkoutEnabled: () => boolean;
  enforceAbuse: typeof enforceAbusePolicy;
  findUser: (
    userId: string
  ) => Promise<{ authVersion: number; subscribedUntil: Date | null } | null>;
  now: () => Date;
};

export async function subscriptionResponse(
  request: Request,
  dependencies: SubscriptionStatusDependencies,
  sourceIp: string | null
): Promise<Response> {
  const ipAdmission = await dependencies.enforceAbuse({
    ip: sourceIp,
    route: "subscription_read_ip",
  });
  if (ipAdmission.kind !== "allowed") {
    return abuseAdmissionResponse(ipAdmission);
  }

  let identity: VerifiedJwtIdentity | null;
  try {
    identity = await dependencies.authenticate(request);
  } catch {
    return noStoreJson({ error: "subscription_unavailable" }, 503);
  }
  const userId = identity?.userId;
  const tokenAuthVersion = identity?.authVersion;

  if (
    !(userId && isCanonicalUuid(userId)) ||
    !validAuthVersion(tokenAuthVersion)
  ) {
    return noStoreJson({ error: "unauthorized" }, 401);
  }

  const admission = await dependencies.enforceAbuse({
    ip: null,
    route: "subscription_read",
    userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  let owner: {
    authVersion: number;
    subscribedUntil: Date | null;
  } | null;
  try {
    owner = await dependencies.findUser(userId);
  } catch {
    return noStoreJson({ error: "subscription_unavailable" }, 503);
  }
  if (!owner || !authVersionMatches(owner.authVersion, tokenAuthVersion)) {
    return noStoreJson({ error: "unauthorized" }, 401);
  }

  const now = dependencies.now();
  let checkoutEnabled: boolean;
  try {
    checkoutEnabled = dependencies.checkoutEnabled();
  } catch {
    return noStoreJson({ error: "billing_configuration_invalid" }, 500);
  }

  return noStoreJson(subscriptionStatusFor(owner, checkoutEnabled, now));
}

export function subscriptionStatusFor(
  user: { subscribedUntil: Date | null },
  checkoutEnabled: boolean,
  now: Date
): SubscriptionStatusResponse {
  return {
    active: isSubscribedAt(user, now),
    checkoutEnabled,
    subscribedUntil: user.subscribedUntil?.toISOString() ?? null,
  };
}

function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    headers: { "cache-control": "no-store" },
    status,
  });
}
