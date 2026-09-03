import type Stripe from "stripe";
import { z } from "zod";
import { readBoundedJson } from "@/lib/abuse/body";
import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { applicationPath } from "@/lib/application-path";
import { parseCanonicalApplicationOrigin } from "@/lib/auth/application-origin";
import {
  type SessionLike,
  type SubscriberAccessDecision,
  subscriberAccessResponse,
} from "@/lib/auth/subscriber-access";
import type { SubscriptionCheckoutConfig } from "./config";
import {
  MINUTE_PACK_CHECKOUT_KIND,
  MINUTE_PACK_FLOW_VERSION,
  type MinutePack,
  minutePackForPrice,
} from "./minute-packs";

const MAX_BODY_BYTES = 1024;
const bodySchema = z.object({
  priceId: z.string().regex(/^price_[A-Za-z0-9]{1,58}$/u),
});

export type MinutePackCheckoutDependencies = {
  appBasePath: () => string;
  authenticate: () => Promise<SessionLike>;
  authorize: (session: SessionLike) => Promise<SubscriberAccessDecision>;
  checkoutEnabled: () => boolean;
  createCheckoutSession: (
    apiKey: string,
    params: Stripe.Checkout.SessionCreateParams
  ) => Promise<{ url: string | null }>;
  enforceAbuse: typeof enforceAbusePolicy;
  findUser: (
    userId: string
  ) => Promise<{ stripeCustomerId: string | null } | null>;
  getCheckoutConfig: () => SubscriptionCheckoutConfig;
  minutePacks: () => readonly MinutePack[];
  origin: () => string;
};

/**
 * Starts a one-time Checkout for a top-up pack.
 *
 * Deliberately simpler than subscription Checkout: a duplicate session is
 * harmless because only a *paid* session credits minutes, and it credits
 * exactly once per session id, so there is no attempt lease or idempotency
 * store here. What is guarded is who may buy: an active subscriber with the
 * Stripe Customer the subscription created, so the credit can be tied to the
 * account that pays.
 */
export async function minutePackCheckoutResponse(
  request: Request,
  dependencies: MinutePackCheckoutDependencies,
  sourceIp: string | null
): Promise<Response> {
  const session = await dependencies.authenticate();
  const userId = session?.user?.id ?? null;
  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let packs: readonly MinutePack[];
  try {
    packs = dependencies.checkoutEnabled() ? dependencies.minutePacks() : [];
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  if (packs.length === 0) {
    return Response.json(
      { error: "minute_packs_unavailable" },
      { status: 404 }
    );
  }

  const admission = await dependencies.enforceAbuse({
    ip: sourceIp,
    route: "minute_pack_checkout",
    userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const access = await dependencies.authorize(session);
  if (access.kind !== "allowed") {
    return subscriberAccessResponse(access);
  }

  const body = await readBoundedJson(request, MAX_BODY_BYTES, bodySchema);
  if (body.kind !== "ok") {
    return Response.json(
      { error: body.kind === "too_large" ? "body_too_large" : "invalid_body" },
      { status: body.kind === "too_large" ? 413 : 400 }
    );
  }
  const pack = minutePackForPrice(packs, body.value.priceId);
  if (!pack) {
    return Response.json({ error: "minute_pack_unknown" }, { status: 404 });
  }

  let config: SubscriptionCheckoutConfig;
  try {
    config = dependencies.getCheckoutConfig();
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  if (!config.enabled) {
    return Response.json(
      { error: "minute_packs_unavailable" },
      { status: 404 }
    );
  }

  let owner: { stripeCustomerId: string | null } | null;
  try {
    owner = await dependencies.findUser(access.userId);
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  if (!owner?.stripeCustomerId) {
    // A complimentary grant has no Customer to charge; packs are for paying
    // subscribers, whose Customer the subscription Checkout created.
    return Response.json({ error: "customer_required" }, { status: 409 });
  }

  let origin: string;
  try {
    origin = parseCanonicalApplicationOrigin(
      "Checkout application origin",
      dependencies.origin(),
      { allowTrailingSlash: true }
    );
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  const basePath = dependencies.appBasePath();
  const returnUrl = (result: "added" | "cancelled") =>
    new URL(
      applicationPath(`/account?minutes=${result}`, basePath),
      `${origin}/`
    ).href;

  let checkout: { url: string | null };
  try {
    checkout = await dependencies.createCheckoutSession(config.apiKey, {
      cancel_url: returnUrl("cancelled"),
      client_reference_id: access.userId,
      customer: owner.stripeCustomerId,
      line_items: [{ price: pack.priceId, quantity: 1 }],
      metadata: {
        kind: MINUTE_PACK_CHECKOUT_KIND,
        minutePackFlowVersion: MINUTE_PACK_FLOW_VERSION,
        minutes: String(pack.minutes),
        priceId: pack.priceId,
        userId: access.userId,
      },
      mode: "payment",
      success_url: returnUrl("added"),
    });
  } catch {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  if (!checkout.url) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }
  return Response.json(
    { minutes: pack.minutes, url: checkout.url },
    { headers: { "cache-control": "no-store" } }
  );
}
