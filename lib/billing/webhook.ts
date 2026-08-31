import type Stripe from "stripe";
import { readBoundedBytes } from "@/lib/abuse/body";
import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { abusePolicyFor } from "@/lib/abuse/policy";
import { isCanonicalUuid } from "@/lib/session";
import { graceExtension } from "./grace";
import { periodStart } from "./period";

export type StripeEventWriteResult = "applied" | "duplicate";

type StripeEventUpdateBase = {
  customerId: string;
  eventId: string;
  stripeSubscriptionId: string;
  userId?: string;
};

type StripeInvoiceEventUpdateBase = StripeEventUpdateBase & {
  billingReason:
    | "subscription_create"
    | "subscription_cycle"
    | "subscription_update";
  periodEnd: Date;
  periodStart: Date;
};

export type StripeEventUpdateInput =
  | (StripeEventUpdateBase & {
      eventType: "checkout_reference";
      userId: string;
    })
  | (StripeInvoiceEventUpdateBase & { eventType: "invoice_paid" })
  | (StripeInvoiceEventUpdateBase & {
      eventType: "invoice_payment_failed";
    });

export type WebhookUser = {
  billingPeriodStart: Date | null;
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  subscribedUntil: Date | null;
};

export type StripeUserMutation = Partial<
  Pick<
    WebhookUser,
    | "billingPeriodStart"
    | "stripeCustomerId"
    | "stripeSubscriptionId"
    | "subscribedUntil"
  >
>;

export type StripeWebhookProvider = {
  constructEvent: (
    raw: Uint8Array,
    signature: string,
    secret: string
  ) => Promise<Stripe.Event>;
  listInvoiceLines: (
    invoiceId: string,
    startingAfter?: string
  ) => Promise<Stripe.ApiList<Stripe.InvoiceLineItem>>;
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
  getConfig: () => {
    apiKey: string;
    priceId: string;
    webhookSecret: string;
  } | null;
};

export type SubscriptionUpdate = {
  billingPeriodStart: Date;
  subscribedUntil: Date;
} | null;

/**
 * Legacy pure entitlement helper retained for callers that only need the date
 * calculation. Transactional webhook writes use `stripeEventMutation`, which
 * evaluates the same outcome against the locked User row.
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

/**
 * Decide a webhook mutation from the User state held under `FOR UPDATE`.
 *
 * Paid authority is monotonic by billing-period start and period end. Events
 * that cannot prove they are newer are claimed but change nothing. Checkout
 * events only fill missing references and never replace a conflicting one.
 */
export function stripeEventMutation(
  current: WebhookUser,
  input: StripeEventUpdateInput
): StripeUserMutation | null {
  if (input.userId && current.id !== input.userId) {
    throw new Error("Stripe webhook owner does not match.");
  }
  if (
    current.stripeCustomerId &&
    current.stripeCustomerId !== input.customerId
  ) {
    throw new Error("Stripe Customer owner does not match.");
  }

  if (input.eventType === "checkout_reference") {
    const mutation = customerMutation(current, input.customerId);
    if (!current.stripeSubscriptionId) {
      mutation.stripeSubscriptionId = input.stripeSubscriptionId;
    }
    return nonEmptyMutation(mutation);
  }

  if (input.eventType === "invoice_paid") {
    return paidInvoiceMutation(current, input);
  }

  return failedInvoiceMutation(current, input);
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

  const raw = await readBoundedBytes(
    request,
    abusePolicyFor("stripe_webhook").bodyBytes
  );
  if (raw.kind === "too_large") {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  if (raw.kind === "invalid") {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }
  if (raw.kind === "read_error") {
    return retryableWebhookResponse();
  }

  let config: ReturnType<StripeWebhookDependencies["getConfig"]>;
  try {
    config = dependencies.getConfig();
  } catch {
    return retryableWebhookResponse();
  }
  if (!config) {
    return Response.json({ error: "billing_unavailable" }, { status: 503 });
  }

  let provider: StripeWebhookProvider;
  try {
    provider = dependencies.createProvider(config.apiKey);
  } catch {
    return retryableWebhookResponse();
  }

  let event: Stripe.Event;
  try {
    event = await provider.constructEvent(
      raw.value,
      signature,
      config.webhookSecret
    );
  } catch {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }

  try {
    const result = await applyWebhookEvent(
      event,
      provider,
      dependencies,
      config.priceId
    );
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
  dependencies: StripeWebhookDependencies,
  priceId: string
): Promise<WebhookEventResult> {
  switch (event.type) {
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.completed":
      return await applyCheckoutEvent(event, dependencies);
    case "invoice.paid":
    case "invoice.payment_failed":
      return await applyInvoiceEvent(event, provider, dependencies, priceId);
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

  return {
    kind: "written",
    write: await dependencies.applyEventUpdate({
      customerId,
      eventId: event.id,
      eventType: "checkout_reference",
      stripeSubscriptionId,
      userId,
    }),
  };
}

async function applyInvoiceEvent(
  event: Stripe.InvoicePaidEvent | Stripe.InvoicePaymentFailedEvent,
  provider: StripeWebhookProvider,
  dependencies: StripeWebhookDependencies,
  priceId: string
): Promise<WebhookEventResult> {
  const invoice = event.data.object;
  const customerId = stripeResourceId(invoice.customer, "customer", "cus_");
  if (!customerId) {
    throw new Error("Webhook owner is unresolved.");
  }

  const billingReason = supportedBillingReason(invoice.billing_reason);
  if (!billingReason) {
    throw new Error("Webhook invoice billing reason is unsupported.");
  }

  const entitlement = await invoiceEntitlementLine(invoice, provider, priceId);
  const parentSubscription = optionalStripeResourceId(
    invoice.parent?.subscription_details?.subscription,
    "subscription",
    "sub_"
  );
  if (
    parentSubscription &&
    parentSubscription !== entitlement.stripeSubscriptionId
  ) {
    throw new Error("Webhook invoice subscription is ambiguous.");
  }

  const userId = await invoiceUserId(invoice.customer, customerId, provider);
  return {
    kind: "written",
    write: await dependencies.applyEventUpdate({
      billingReason,
      customerId,
      eventId: event.id,
      eventType:
        event.type === "invoice.paid"
          ? "invoice_paid"
          : "invoice_payment_failed",
      periodEnd: entitlement.end,
      periodStart: entitlement.start,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      ...(userId ? { userId } : {}),
    }),
  };
}

type EntitlementLine = {
  end: Date;
  start: Date;
  stripeSubscriptionId: string;
};

async function invoiceEntitlementLine(
  invoice: Stripe.Invoice,
  provider: StripeWebhookProvider,
  priceId: string
): Promise<EntitlementLine> {
  const embedded = entitlementLines(invoice.lines.data, priceId);
  if (!invoice.lines.has_more && embedded.supported.length === 1) {
    return embedded.supported[0] as EntitlementLine;
  }
  if (!invoice.lines.has_more && embedded.supported.length > 1) {
    throw new Error("Webhook invoice entitlement line is ambiguous.");
  }

  const supported: EntitlementLine[] = [];
  let matchingProrations = 0;
  let startingAfter: string | undefined;
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: Stripe pages are cursor-dependent.
    const page = await provider.listInvoiceLines(invoice.id, startingAfter);
    const inspected = entitlementLines(page.data, priceId);
    supported.push(...inspected.supported);
    matchingProrations += inspected.matchingProrations;
    if (supported.length > 1) {
      throw new Error("Webhook invoice entitlement line is ambiguous.");
    }
    if (!page.has_more) {
      break;
    }
    const lastId = page.data.at(-1)?.id;
    if (!lastId || lastId === startingAfter) {
      throw new Error("Webhook invoice line pagination did not advance.");
    }
    startingAfter = lastId;
  }

  if (supported.length === 1) {
    return supported[0] as EntitlementLine;
  }
  if (matchingProrations > 0) {
    throw new Error("Webhook invoice contains only proration entitlement.");
  }
  throw new Error("Webhook invoice entitlement line is missing.");
}

function entitlementLines(
  lines: Stripe.InvoiceLineItem[],
  priceId: string
): { matchingProrations: number; supported: EntitlementLine[] } {
  const supported: EntitlementLine[] = [];
  let matchingProrations = 0;

  for (const line of lines) {
    const details =
      line.parent?.type === "subscription_item_details"
        ? line.parent.subscription_item_details
        : null;
    if (!details || invoiceLinePriceId(line) !== priceId) {
      continue;
    }
    if (details.proration) {
      matchingProrations += 1;
      continue;
    }

    const lineSubscription = optionalStripeResourceId(
      line.subscription,
      "subscription",
      "sub_"
    );
    const detailSubscription = optionalStripeResourceId(
      details.subscription,
      "subscription",
      "sub_"
    );
    if (
      lineSubscription &&
      detailSubscription &&
      lineSubscription !== detailSubscription
    ) {
      throw new Error("Webhook invoice line subscription is ambiguous.");
    }
    const stripeSubscriptionId = lineSubscription ?? detailSubscription;
    if (!stripeSubscriptionId) {
      throw new Error("Webhook invoice line subscription is invalid.");
    }

    const start = dateFromStripeSeconds(line.period.start);
    const end = dateFromStripeSeconds(line.period.end);
    if (!(start && end && end > start)) {
      throw new Error("Webhook invoice period is invalid.");
    }
    supported.push({ end, start, stripeSubscriptionId });
  }

  return { matchingProrations, supported };
}

function invoiceLinePriceId(line: Stripe.InvoiceLineItem): string | null {
  if (line.pricing?.type !== "price_details") {
    return null;
  }
  const price = line.pricing.price_details?.price;
  if (!price) {
    return null;
  }
  return typeof price === "string"
    ? validStripeId(price, "price_")
    : price.object === "price"
      ? validStripeId(price.id, "price_")
      : null;
}

async function invoiceUserId(
  customer: Stripe.Invoice["customer"],
  customerId: string,
  provider: StripeWebhookProvider
): Promise<string | null> {
  if (customer && typeof customer !== "string") {
    return userIdFromCustomer(customer);
  }
  const retrieved = await provider.retrieveCustomer(customerId);
  if (retrieved.id !== customerId) {
    throw new Error("Webhook Customer lookup did not match.");
  }
  return userIdFromCustomer(retrieved);
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

function optionalStripeResourceId(
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
  if (resource === null || resource === undefined) {
    return null;
  }
  const id = stripeResourceId(resource, expectedObject, prefix);
  if (!id) {
    throw new Error(`Webhook ${expectedObject} reference is invalid.`);
  }
  return id;
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
  return id ? validStripeId(id, prefix) : null;
}

function validStripeId(
  id: string,
  prefix: "cus_" | "price_" | "sub_"
): string | null {
  return id.startsWith(prefix) && id.length <= 64 ? id : null;
}

function supportedBillingReason(
  reason: Stripe.Invoice["billing_reason"]
): "subscription_create" | "subscription_cycle" | "subscription_update" | null {
  switch (reason) {
    case "subscription_create":
    case "subscription_cycle":
    case "subscription_update":
      return reason;
    default:
      return null;
  }
}

function paidInvoiceMutation(
  current: WebhookUser,
  input: Extract<StripeEventUpdateInput, { eventType: "invoice_paid" }>
): StripeUserMutation | null {
  const currentStart = current.billingPeriodStart?.getTime() ?? null;
  const incomingStart = input.periodStart.getTime();
  const incomingEnd = input.periodEnd.getTime();
  const currentEnd = current.subscribedUntil?.getTime() ?? null;

  if (currentStart !== null && currentStart > incomingStart) {
    return null;
  }
  if (
    currentStart === incomingStart &&
    current.stripeSubscriptionId &&
    current.stripeSubscriptionId !== input.stripeSubscriptionId
  ) {
    return null;
  }
  if (
    currentStart === null &&
    current.stripeSubscriptionId &&
    current.stripeSubscriptionId !== input.stripeSubscriptionId
  ) {
    return null;
  }
  if (
    currentStart === null &&
    currentEnd !== null &&
    currentEnd > incomingEnd
  ) {
    return null;
  }

  const mutation = customerMutation(current, input.customerId);
  if (currentStart !== incomingStart) {
    mutation.billingPeriodStart = input.periodStart;
  }
  if (current.stripeSubscriptionId !== input.stripeSubscriptionId) {
    mutation.stripeSubscriptionId = input.stripeSubscriptionId;
  }
  if (currentEnd === null || incomingEnd > currentEnd) {
    mutation.subscribedUntil = input.periodEnd;
  }
  return nonEmptyMutation(mutation);
}

function failedInvoiceMutation(
  current: WebhookUser,
  input: Extract<
    StripeEventUpdateInput,
    { eventType: "invoice_payment_failed" }
  >
): StripeUserMutation | null {
  if (input.billingReason === "subscription_create") {
    if (
      current.billingPeriodStart ||
      current.subscribedUntil ||
      (current.stripeSubscriptionId &&
        current.stripeSubscriptionId !== input.stripeSubscriptionId)
    ) {
      return null;
    }
    const mutation = customerMutation(current, input.customerId);
    if (!current.stripeSubscriptionId) {
      mutation.stripeSubscriptionId = input.stripeSubscriptionId;
    }
    return nonEmptyMutation(mutation);
  }

  if (
    input.billingReason !== "subscription_cycle" ||
    current.stripeSubscriptionId !== input.stripeSubscriptionId ||
    !current.billingPeriodStart ||
    !current.subscribedUntil ||
    current.billingPeriodStart >= input.periodStart ||
    current.subscribedUntil.getTime() !== input.periodStart.getTime()
  ) {
    return null;
  }

  const subscribedUntil = graceExtension({
    billingReason: input.billingReason,
    graceAlreadyApplied: false,
    subscribedUntil: current.subscribedUntil,
  });
  if (!subscribedUntil) {
    return null;
  }
  return {
    ...customerMutation(current, input.customerId),
    subscribedUntil,
  };
}

function customerMutation(
  current: WebhookUser,
  customerId: string
): StripeUserMutation {
  return current.stripeCustomerId ? {} : { stripeCustomerId: customerId };
}

function nonEmptyMutation(
  mutation: StripeUserMutation
): StripeUserMutation | null {
  return Object.keys(mutation).length > 0 ? mutation : null;
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
