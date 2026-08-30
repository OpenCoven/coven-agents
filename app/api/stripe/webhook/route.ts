import Stripe from "stripe";
import {
  applyStripeEntitlementEvent,
  recordIgnoredStripeEvent,
} from "@/lib/db/stripe-events";
import {
  findUserById,
  findUserByStripeCustomerId,
} from "@/lib/db/queries";

const ENTITLEMENT_EVENT_TYPES = new Set([
  "invoice.paid",
  "invoice.payment_failed",
]);

/**
 * Authenticated, retry-safe Stripe entitlement ingestion.
 *
 * Signature verification happens before any durable receipt. For entitlement
 * events, the provider event id and normalized user entitlement commit in the
 * same database transaction, so a crash cannot leave a claimed-but-unapplied
 * event that every later Stripe retry falsely deduplicates.
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

  try {
    if (!ENTITLEMENT_EVENT_TYPES.has(event.type)) {
      return receiptResponse(await recordIgnoredStripeEvent(event.id));
    }

    const object = event.data.object as {
      billing_reason?: string | null;
      customer?: unknown;
      lines?: { data?: { period?: { end?: number; start?: number } }[] };
    };
    const customerId = stripeCustomerId(object.customer);

    if (!customerId) {
      return receiptResponse(await recordIgnoredStripeEvent(event.id));
    }

    const byCustomer = await findUserByStripeCustomerId(customerId);
    // The first event for a new subscription cannot yet be found by the locally
    // stored customer id. Checkout stamps server-owned userId metadata on the
    // Stripe Customer for this bounded bootstrap only.
    const owner = byCustomer ?? (await ownerFromMetadata(stripe, customerId));

    if (!owner) {
      // No receipt was written, so Stripe can safely redeliver after checkout
      // metadata/account propagation converges.
      return Response.json(
        { error: "billing_owner_unavailable" },
        { headers: { "retry-after": "5" }, status: 500 }
      );
    }

    const period = object.lines?.data?.[0]?.period;
    const state = await applyStripeEntitlementEvent({
      billingReason: object.billing_reason ?? "",
      customerId,
      eventId: event.id,
      eventType: event.type,
      periodEnd: dateFromUnixSeconds(period?.end),
      periodStart: dateFromUnixSeconds(period?.start),
      userId: owner.id,
    });

    if (state === "rejected") {
      // Stop provider retry without granting access. The event id remains a
      // durable terminal receipt; no customer id or payment detail is exposed.
      return Response.json({ received: true, state });
    }
    return receiptResponse(state);
  } catch {
    // The transaction rolls back both receipt and entitlement mutation. A
    // non-2xx response therefore asks Stripe to retry rather than losing the
    // event behind a false duplicate receipt.
    return Response.json(
      { error: "billing_processing_unavailable" },
      { headers: { "retry-after": "5" }, status: 500 }
    );
  }
}

async function ownerFromMetadata(stripe: Stripe, customerId: string) {
  const customer = await stripe.customers.retrieve(customerId);
  const userId = "metadata" in customer ? customer.metadata?.userId : undefined;

  if (!userId) {
    return null;
  }
  return await findUserById(userId);
}

function receiptResponse(state: "applied" | "deduped" | "ignored") {
  return Response.json(
    state === "deduped"
      ? { deduped: true, state }
      : { received: true, state }
  );
}

function stripeCustomerId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (
    value &&
    typeof value === "object" &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    return value.id;
  }
  return null;
}

function dateFromUnixSeconds(value: number | undefined): Date | null {
  if (!(typeof value === "number" && Number.isFinite(value) && value > 0)) {
    return null;
  }
  return new Date(value * 1000);
}
