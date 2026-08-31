import type Stripe from "stripe";
import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { isCanonicalUuid } from "@/lib/session";
import { graceExtension } from "./grace";
import { periodStart } from "./period";

export type StripeEventWriteResult = "applied" | "duplicate";

export type StripeEventUpdateInput = {
  billingPeriodStart?: Date;
  customerId: string;
  eventId: string;
  stripeSubscriptionId?: string;
  subscribedUntil?: Date;
  userId: string;
};

export type WebhookUser = {
  billingPeriodStart: Date | null;
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscribedUntil: Date | null;
};

export type StripeWebhookProvider = {
  constructEvent: (
    raw: string,
    signature: string,
    secret: string
  ) => Promise<Stripe.Event>;
  retrieveCustomer: (
    customerId: string
  ) => Promise<Stripe.Customer | Stripe.DeletedCustomer>;
};

export type StripeWebhookDependencies = {
  applyEventUpdate: (
    input: StripeEventUpdateInput
  ) => Promise<StripeEventWriteResult>;
  createProvider: (apiKey: string) => StripeWebhookProvider;
  enforceAbuse: typeof enforceAbusePolicy;
  findUserById: (userId: string) => Promise<WebhookUser | null>;
  findUserByStripeCustomerId: (
    customerId: string
  ) => Promise<WebhookUser | null>;
  getConfig: () => {
    apiKey: string;
    webhookSecret: string;
  } | null;
};

export type SubscriptionUpdate = {
  billingPeriodStart: Date;
  subscribedUntil: Date;
} | null;

/**
 * What a Stripe event changes about `subscribedUntil`, if anything.
 *
 * Pure, so the decision that grants paid access is testable without a webhook
 * delivery. Allow-listed on event type: an event Stripe adds later defaults to
 * changing nothing rather than falling into a branch it was never considered
 * for.
 *
 * A cancellation deliberately revokes nothing. The period is already paid for,
 * and access ends when the date passes.
 */
export function subscriptionUpdate(input: {
  billingReason: string;
  current: Date | null;
  currentPeriodStart?: Date | null;
  periodEnd: Date | null;
  periodStart?: Date | null;
  type: string;
}): SubscriptionUpdate {
  if (input.type === "invoice.paid") {
    // No date means nothing to grant. Defaulting to "now plus a month" would
    // invent a subscription the invoice never described.
    const billingPeriodStart =
      input.periodStart ?? periodStart(input.periodEnd);
    return input.periodEnd && billingPeriodStart
      ? {
          billingPeriodStart,
          subscribedUntil: input.periodEnd,
        }
      : null;
  }

  if (input.type === "invoice.payment_failed") {
    const extended = graceExtension({
      billingReason: input.billingReason,
      // A renewal invoice starts where the paid period ended. After grace is
      // applied, current authority is beyond that boundary, so later failed
      // attempts cannot compound it.
      graceAlreadyApplied: Boolean(
        input.current && input.periodStart && input.current > input.periodStart
      ),
      subscribedUntil: input.current,
    });

    const billingPeriodStart =
      input.currentPeriodStart ?? periodStart(input.current);
    return extended && billingPeriodStart
      ? { billingPeriodStart, subscribedUntil: extended }
      : null;
  }

  return null;
}

export async function stripeWebhookResponse(
  request: Request,
  dependencies: StripeWebhookDependencies,
  sourceIp: string | null
): Promise<Response> {
  const admission = await dependencies.enforceAbuse({
    ip: sourceIp,
    route: "stripe_webhook",
  });
  if (admission.kind !== "allowed") {
    return abuseAdmissionResponse(admission);
  }

  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return Response.json({ error: "unsigned" }, { status: 400 });
  }

  const config = dependencies.getConfig();
  if (!config) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return retryableWebhookResponse();
  }

  let provider: StripeWebhookProvider;
  try {
    provider = dependencies.createProvider(config.apiKey);
  } catch {
    return retryableWebhookResponse();
  }

  let event: Stripe.Event;
  try {
    event = await provider.constructEvent(raw, signature, config.webhookSecret);
  } catch {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }

  try {
    const result = await applyWebhookEvent(event, provider, dependencies);
    if (result.kind === "ignored") {
      return Response.json({ ignored: true, reason: result.reason });
    }
    if (result.write === "duplicate") {
      return Response.json({ deduped: true });
    }
    return Response.json({ received: true });
  } catch {
    return retryableWebhookResponse();
  }
}

type WebhookEventResult =
  | { kind: "ignored"; reason: "unpaid" | "unsupported" }
  | { kind: "written"; write: StripeEventWriteResult };

async function applyWebhookEvent(
  event: Stripe.Event,
  provider: StripeWebhookProvider,
  dependencies: StripeWebhookDependencies
): Promise<WebhookEventResult> {
  switch (event.type) {
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.completed":
      return await applyCheckoutEvent(event, dependencies);
    case "invoice.paid":
    case "invoice.payment_failed":
      return await applyInvoiceEvent(event, provider, dependencies);
    default:
      return { kind: "ignored", reason: "unsupported" };
  }
}

async function applyCheckoutEvent(
  event:
    | Stripe.CheckoutSessionAsyncPaymentSucceededEvent
    | Stripe.CheckoutSessionCompletedEvent,
  dependencies: StripeWebhookDependencies
): Promise<WebhookEventResult> {
  const session = event.data.object;
  if (session.payment_status !== "paid") {
    return { kind: "ignored", reason: "unpaid" };
  }

  const customerId = stripeResourceId(session.customer, "customer", "cus_");
  const stripeSubscriptionId = stripeResourceId(
    session.subscription,
    "subscription",
    "sub_"
  );
  const userId = checkoutUserId(session);
  if (!(customerId && stripeSubscriptionId && userId)) {
    throw new Error("Webhook owner is unresolved.");
  }

  const owner = await dependencies.findUserById(userId);
  if (!owner) {
    throw new Error("Webhook owner is unresolved.");
  }

  return {
    kind: "written",
    write: await dependencies.applyEventUpdate({
      customerId,
      eventId: event.id,
      stripeSubscriptionId,
      userId: owner.id,
    }),
  };
}

async function applyInvoiceEvent(
  event: Stripe.InvoicePaidEvent | Stripe.InvoicePaymentFailedEvent,
  provider: StripeWebhookProvider,
  dependencies: StripeWebhookDependencies
): Promise<WebhookEventResult> {
  const invoice = event.data.object;
  const customerId = stripeResourceId(invoice.customer, "customer", "cus_");
  if (!customerId) {
    throw new Error("Webhook owner is unresolved.");
  }

  const owner =
    (await dependencies.findUserByStripeCustomerId(customerId)) ??
    (await invoiceOwnerFromMetadata(
      invoice.customer,
      customerId,
      provider,
      dependencies
    ));
  if (!owner) {
    throw new Error("Webhook owner is unresolved.");
  }

  const stripeSubscriptionId = invoiceSubscriptionId(invoice);
  let update: SubscriptionUpdate = null;
  if (stripeSubscriptionId) {
    const period = invoiceSubscriptionPeriod(invoice, stripeSubscriptionId);
    if (!period) {
      throw new Error("Webhook invoice period is invalid.");
    }
    update = subscriptionUpdate({
      billingReason: invoice.billing_reason ?? "",
      current: owner.subscribedUntil,
      currentPeriodStart: owner.billingPeriodStart,
      periodEnd: period.end,
      periodStart: period.start,
      type: event.type,
    });
  }

  return {
    kind: "written",
    write: await dependencies.applyEventUpdate({
      customerId,
      eventId: event.id,
      ...(stripeSubscriptionId ? { stripeSubscriptionId } : {}),
      ...(update ?? {}),
      userId: owner.id,
    }),
  };
}

async function invoiceOwnerFromMetadata(
  customer: Stripe.Invoice["customer"],
  customerId: string,
  provider: StripeWebhookProvider,
  dependencies: StripeWebhookDependencies
): Promise<WebhookUser | null> {
  const expandedUserId = userIdFromCustomer(customer);
  const userId =
    expandedUserId ??
    userIdFromCustomer(await provider.retrieveCustomer(customerId));
  return userId ? await dependencies.findUserById(userId) : null;
}

function checkoutUserId(session: Stripe.Checkout.Session): string | null {
  const candidates = [
    session.client_reference_id,
    session.metadata?.userId ?? null,
  ].filter((value): value is string => Boolean(value));

  if (
    candidates.length === 0 ||
    candidates.some((candidate) => !isCanonicalUuid(candidate))
  ) {
    return null;
  }

  const [first] = candidates;
  return candidates.every((candidate) => candidate === first) ? first : null;
}

function userIdFromCustomer(
  customer:
    | Stripe.Checkout.Session["customer"]
    | Stripe.Invoice["customer"]
    | Stripe.Customer
    | Stripe.DeletedCustomer
): string | null {
  if (!customer || typeof customer === "string" || customer.deleted) {
    return null;
  }
  const { userId } = customer.metadata;
  return userId && isCanonicalUuid(userId) ? userId : null;
}

function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parentSubscription = stripeResourceId(
    invoice.parent?.subscription_details?.subscription,
    "subscription",
    "sub_"
  );
  if (parentSubscription) {
    return parentSubscription;
  }

  for (const line of invoice.lines.data) {
    const lineSubscription = stripeResourceId(
      line.subscription,
      "subscription",
      "sub_"
    );
    if (lineSubscription) {
      return lineSubscription;
    }
  }
  return null;
}

function invoiceSubscriptionPeriod(
  invoice: Stripe.Invoice,
  stripeSubscriptionId: string
): { end: Date; start: Date } | null {
  const matchingLines = invoice.lines.data.filter(
    (line) => invoiceLineSubscriptionId(line) === stripeSubscriptionId
  );
  const selectedLine =
    matchingLines.find((candidate) => {
      const details =
        candidate.parent?.subscription_item_details ??
        candidate.parent?.invoice_item_details;
      return details?.proration === false;
    }) ?? matchingLines[0];
  if (!selectedLine) {
    return null;
  }

  const start = dateFromStripeSeconds(selectedLine.period.start);
  const end = dateFromStripeSeconds(selectedLine.period.end);
  return start && end && end >= start ? { end, start } : null;
}

function invoiceLineSubscriptionId(
  line: Stripe.Invoice["lines"]["data"][number]
): string | null {
  return (
    stripeResourceId(line.subscription, "subscription", "sub_") ??
    stripeResourceId(
      line.parent?.subscription_item_details?.subscription ??
        line.parent?.invoice_item_details?.subscription,
      "subscription",
      "sub_"
    )
  );
}

function stripeResourceId(
  resource:
    | string
    | {
        id: string;
        object: string;
      }
    | null
    | undefined,
  expectedObject: "customer" | "subscription",
  prefix: "cus_" | "sub_"
): string | null {
  const id =
    typeof resource === "string"
      ? resource
      : resource?.object === expectedObject
        ? resource.id
        : null;
  return id?.startsWith(prefix) && id.length <= 64 ? id : null;
}

function dateFromStripeSeconds(seconds: number): Date | null {
  if (
    !(Number.isFinite(seconds) && Number.isInteger(seconds) && seconds >= 0)
  ) {
    return null;
  }
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function retryableWebhookResponse(): Response {
  return Response.json({ error: "webhook_retry" }, { status: 503 });
}
