import { ipAddress } from "@vercel/functions";
import Stripe from "stripe";
import { auth } from "@/app/(auth)/auth";
import {
  abuseAdmissionResponse,
  enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import {
  idempotencyResultResponse,
  runIdempotentOperation,
  type StoredIdempotencyResponse,
} from "@/lib/abuse/idempotency";
import { checkoutDecision } from "@/lib/billing/checkout";
import {
  attachStripeCustomer,
  databaseIdempotencyStore,
  findUserById,
} from "@/lib/db/queries";

const CHECKOUT_RESULT_RETENTION_MS = 24 * 60 * 60_000;

/**
 * Opens a Stripe Checkout session.
 *
 * One Customer per user, reused across subscriptions, with `metadata.userId`
 * stamped on it. That metadata is what lets the very first webhook find the
 * user -- since the event that writes `stripeCustomerId` is the same one that
 * would otherwise be needed to look it up.
 */
export async function POST(request: Request) {
  const session = await auth();
  const userId = session?.user?.id ?? null;

  if (!userId) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const admission = await enforceAbusePolicy({
    ip: ipAddress(request) ?? null,
    route: "checkout",
    userId,
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const result = await runIdempotentOperation({
    idempotencyKey: request.headers.get("idempotency-key"),
    operation: "checkout",
    ownerId: userId,
    perform: async ({
      providerIdempotencyKey,
    }): Promise<StoredIdempotencyResponse> => {
      const secret = process.env.STRIPE_SECRET_KEY;
      const price = process.env.STRIPE_PRICE_ID;

      if (!(secret && price)) {
        return { body: { error: "billing_unavailable" }, status: 503 };
      }

      const stripe = new Stripe(secret);
      const row = await findUserById(userId);
      const active = row?.stripeCustomerId
        ? (
            await stripe.subscriptions.list({
              customer: row.stripeCustomerId,
              limit: 1,
              status: "active",
            })
          ).data.length > 0
        : false;
      const decision = checkoutDecision({
        hasActiveSubscription: active,
        userId,
      });

      if (decision.kind === "unauthorized") {
        return { body: { error: "unauthorized" }, status: 401 };
      }
      if (decision.kind === "already_subscribed") {
        return { body: { error: "already_subscribed" }, status: 409 };
      }

      const customer =
        row?.stripeCustomerId ??
        (
          await stripe.customers.create(
            { metadata: { userId: decision.userId } },
            { idempotencyKey: `${providerIdempotencyKey}:customer` }
          )
        ).id;

      if (!row?.stripeCustomerId) {
        await attachStripeCustomer(decision.userId, customer);
      }

      const origin = process.env.APP_ORIGIN ?? "";
      const checkout = await stripe.checkout.sessions.create(
        {
          cancel_url: `${origin}/account`,
          customer,
          line_items: [{ price, quantity: 1 }],
          mode: "subscription",
          success_url: `${origin}/agents`,
        },
        { idempotencyKey: `${providerIdempotencyKey}:session` }
      );

      return { body: { url: checkout.url }, status: 200 };
    },
    request: {},
    retentionMs: CHECKOUT_RESULT_RETENTION_MS,
    store: databaseIdempotencyStore,
  });

  return idempotencyResultResponse(result);
}
