import Stripe from "stripe";
import { auth } from "@/app/(auth)/auth";
import { checkoutDecision } from "@/lib/billing/checkout";
import { attachStripeCustomer, findUserById } from "@/lib/db/queries";

/**
 * Opens a Stripe Checkout session.
 *
 * One Customer per user, reused across subscriptions, with `metadata.userId`
 * stamped on it. That metadata is what lets the very first webhook find the
 * user -- since the event that writes `stripeCustomerId` is the same one that
 * would otherwise be needed to look it up.
 */
export async function POST() {
  const session = await auth();
  const userId = session?.user?.id ?? null;

  const secret = process.env.STRIPE_SECRET_KEY;
  const price = process.env.STRIPE_PRICE_ID;

  if (!(secret && price)) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  const stripe = new Stripe(secret);

  const row = userId ? await findUserById(userId) : null;

  const active = row?.stripeCustomerId
    ? (
        await stripe.subscriptions.list({
          customer: row.stripeCustomerId,
          limit: 1,
          status: "active",
        })
      ).data.length > 0
    : false;

  const decision = checkoutDecision({ hasActiveSubscription: active, userId });

  if (decision.kind === "unauthorized") {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (decision.kind === "already_subscribed") {
    return Response.json({ error: "already_subscribed" }, { status: 409 });
  }

  const customer =
    row?.stripeCustomerId ??
    (await stripe.customers.create({ metadata: { userId: decision.userId } }))
      .id;

  if (!row?.stripeCustomerId) {
    await attachStripeCustomer(decision.userId, customer);
  }

  const origin = process.env.APP_ORIGIN ?? "";

  const checkout = await stripe.checkout.sessions.create({
    cancel_url: `${origin}/account`,
    customer,
    line_items: [{ price, quantity: 1 }],
    mode: "subscription",
    success_url: `${origin}/agents`,
  });

  return Response.json({ url: checkout.url });
}
