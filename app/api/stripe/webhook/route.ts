import Stripe from "stripe";
import { subscriptionUpdate } from "@/lib/billing/webhook";
import {
  applySubscriptionUpdate,
  claimStripeEvent,
  findUserById,
  findUserByStripeCustomerId,
} from "@/lib/db/queries";

/**
 * Stripe's webhook endpoint.
 *
 * Two things matter more than the rest. The signature is verified, because an
 * unverified endpoint that writes `subscribedUntil` is a free subscription for
 * anyone who can POST to it. And the event id is inserted as a primary key
 * before anything is written, so a redelivery — which Stripe does routinely —
 * conflicts instead of extending a subscription twice.
 */
export async function POST(request: Request) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!(secret && webhookSecret)) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return Response.json({ error: "unsigned" }, { status: 400 });
  }

  // The raw body, not the parsed one: the signature covers the exact bytes.
  const raw = await request.text();
  const stripe = new Stripe(secret);

  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      raw,
      signature,
      webhookSecret
    );
  } catch {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }

  // The insert IS the idempotency check. A lookup-then-write would race a
  // concurrent redelivery of the same event.
  if (!(await claimStripeEvent(event.id))) {
    return Response.json({ deduped: true });
  }

  const object = event.data.object as {
    billing_reason?: string | null;
    customer?: string | null;
    lines?: { data?: { period?: { end?: number; start?: number } }[] };
  };

  const customerId =
    typeof object.customer === "string" ? object.customer : null;

  if (!customerId) {
    return Response.json({ ignored: true });
  }

  const byCustomer = await findUserByStripeCustomerId(customerId);

  // The first event of a new subscription is the one that writes
  // `stripeCustomerId`, so it cannot be found by it. Checkout stamps
  // `metadata.userId` on the Customer for exactly this moment.
  const owner = byCustomer ?? (await ownerFromMetadata(stripe, customerId));

  if (!owner) {
    return Response.json({ ignored: true });
  }

  const periodEndSeconds = object.lines?.data?.[0]?.period?.end;
  const periodStartSeconds = object.lines?.data?.[0]?.period?.start;

  const update = subscriptionUpdate({
    billingReason: object.billing_reason ?? "",
    current: owner.subscribedUntil ?? null,
    currentPeriodStart: owner.billingPeriodStart ?? null,
    periodEnd: periodEndSeconds ? new Date(periodEndSeconds * 1000) : null,
    periodStart: periodStartSeconds
      ? new Date(periodStartSeconds * 1000)
      : null,
    type: event.type,
  });

  if (update) {
    await applySubscriptionUpdate({
      billingPeriodStart: update.billingPeriodStart,
      customerId,
      subscribedUntil: update.subscribedUntil,
      userId: owner.id,
    });
  }

  return Response.json({ received: true });
}

async function ownerFromMetadata(stripe: Stripe, customerId: string) {
  const customer = await stripe.customers.retrieve(customerId);
  const userId = "metadata" in customer ? customer.metadata?.userId : undefined;

  if (!userId) {
    return null;
  }

  return await findUserById(userId);
}
