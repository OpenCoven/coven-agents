import type Stripe from "stripe";
import { readBoundedBytes } from "@/lib/abuse/body";
import {
  abuseAdmissionResponse,
  type enforceAbusePolicy,
} from "@/lib/abuse/enforce";
import { abusePolicyFor } from "@/lib/abuse/policy";
import { isCanonicalUuid } from "@/lib/session";
import {
  CHECKOUT_ATTEMPT_METADATA_KEY,
  CHECKOUT_FLOW_VERSION,
  stableIntegrationIdentifier,
} from "./checkout";
import {
  type CheckoutAttemptState,
  checkoutAttemptProvesCustomer,
  checkoutAttemptProvesResources,
  checkoutProviderIdempotencyKey,
} from "./checkout-lease";
import { graceExtension } from "./grace";
import {
  type PaidInvoiceDecision,
  type PaidInvoiceMutation,
  type PaidInvoiceUser,
  paidInvoiceMutation,
} from "./paid-invoice";
import type {
  StripeReconciliationReason,
  StripeReconciliationRecord,
} from "./stripe-reconciliation";

export type StripeWebhookManualReconciliationRecord =
  StripeReconciliationRecord;

export type StripeEventWriteResult =
  | "applied"
  | "duplicate"
  | {
      kind: "manual_reconciliation";
      record: StripeWebhookManualReconciliationRecord;
    };

export type StripeManualReconciliationWriteResult = Exclude<
  StripeEventWriteResult,
  "applied"
>;

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
  eventCreatedAt: Date;
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

export type WebhookUser = PaidInvoiceUser & {
  id: string;
};

export type StripeUserMutation = PaidInvoiceMutation;

export type StripeEventMutationDecision =
  | PaidInvoiceDecision
  | {
      kind: "manual_reconciliation";
      reason: StripeWebhookManualReconciliationReason;
    };

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
  findCheckoutAttemptState: (input: {
    attemptId: string;
    ownerId: string;
  }) => Promise<CheckoutAttemptState | null>;
  findUserByStripeCustomerId: (
    customerId: string
  ) => Promise<WebhookUser | null>;
  getConfig: () => {
    apiKey: string;
    priceId: string;
    webhookSecret: string;
  } | null;
  recordManualReconciliation: (
    record: StripeWebhookManualReconciliationRecord
  ) => Promise<StripeManualReconciliationWriteResult>;
  reportManualReconciliation: (
    record: StripeWebhookManualReconciliationRecord
  ) => void;
};

type StripeWebhookManualReconciliationReason = StripeReconciliationReason;

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
    return input.periodEnd && input.periodStart
      ? {
          billingPeriodStart: input.periodStart,
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
    return extended && input.currentPeriodStart
      ? {
          billingPeriodStart: input.currentPeriodStart,
          subscribedUntil: extended,
        }
      : null;
  }

  return null;
}

/**
 * Decide a webhook mutation from the User state held under `FOR UPDATE`.
 *
 * Same-subscription paid authority advances as an exact interval. A different
 * subscription must begin after the backed interval or is routed to durable
 * reconciliation. Checkout events only fill missing references.
 */
export function stripeEventMutation(
  current: WebhookUser,
  input: StripeEventUpdateInput
): StripeEventMutationDecision {
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

  if (hasActiveSubscriptionOverride(current)) {
    return null;
  }
  return failedInvoiceMutation(current, input);
}

function hasActiveSubscriptionOverride(current: WebhookUser): boolean {
  return Boolean(
    current.subscriptionOverrideAction || current.subscriptionOverrideAt
  );
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
    if (result.kind === "manual_reconciliation") {
      const write = await dependencies.recordManualReconciliation({
        eventId: event.id,
        eventType: reconciliationEventType(event.type),
        reason: result.reason,
        status: "pending",
      });
      return manualReconciliationResponse(write, dependencies);
    }
    if (result.write === "duplicate") {
      return Response.json({ deduped: true });
    }
    if (
      typeof result.write === "object" &&
      result.write.kind === "manual_reconciliation"
    ) {
      return manualReconciliationResponse(result.write, dependencies);
    }
    return Response.json({ received: true });
  } catch {
    return retryableWebhookResponse();
  }
}

type WebhookEventResult =
  | {
      kind: "ignored";
      reason:
        | "checkout_unrelated"
        | "invoice_no_entitlement"
        | "invoice_unrelated_customer"
        | "invoice_unsupported_billing_reason"
        | "unsupported";
    }
  | {
      kind: "manual_reconciliation";
      reason: StripeWebhookManualReconciliationReason;
    }
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
      return await applyCheckoutEvent(event, dependencies, priceId);
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
  dependencies: StripeWebhookDependencies,
  priceId: string
): Promise<WebhookEventResult> {
  const session = event.data.object;
  const userId = checkoutUserId(session);
  const attemptId = session.metadata?.[CHECKOUT_ATTEMPT_METADATA_KEY] ?? null;
  const customerId = stripeResourceId(session.customer, "customer", "cus_");
  const stripeSubscriptionId = stripeResourceId(
    session.subscription,
    "subscription",
    "sub_"
  );
  if (
    session.mode !== "subscription" ||
    session.payment_status !== "paid" ||
    !userId ||
    !attemptId ||
    !isCanonicalUuid(attemptId) ||
    session.metadata?.checkoutFlowVersion !== CHECKOUT_FLOW_VERSION ||
    session.metadata?.priceId !== priceId ||
    session.integration_identifier !==
      stableIntegrationIdentifier(
        checkoutProviderIdempotencyKey(userId, attemptId)
      ) ||
    !customerId ||
    !stripeSubscriptionId
  ) {
    return { kind: "ignored", reason: "checkout_unrelated" };
  }
  const attemptState = await dependencies.findCheckoutAttemptState({
    attemptId,
    ownerId: userId,
  });
  if (
    !checkoutAttemptProvesResources(attemptState, {
      customerId,
      sessionId: session.id,
    })
  ) {
    return { kind: "ignored", reason: "checkout_unrelated" };
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
  const eventCreatedAt = dateFromStripeSeconds(event.created);
  if (!eventCreatedAt) {
    return {
      kind: "manual_reconciliation",
      reason: "invoice_invalid_period",
    };
  }
  const billingReason = supportedBillingReason(invoice.billing_reason);
  if (!billingReason) {
    return {
      kind: "ignored",
      reason: "invoice_unsupported_billing_reason",
    };
  }

  const entitlementResult = await invoiceEntitlementLine(
    invoice,
    provider,
    priceId
  );
  if (entitlementResult.kind !== "accepted") {
    return entitlementResult;
  }
  const { entitlement } = entitlementResult;
  const parentSubscription = stripeResourceReference(
    invoice.parent?.subscription_details?.subscription,
    "subscription",
    "sub_"
  );
  if (parentSubscription.kind === "invalid") {
    return {
      kind: "manual_reconciliation",
      reason: "invoice_invalid_reference",
    };
  }
  if (
    parentSubscription.kind === "valid" &&
    parentSubscription.id !== entitlement.stripeSubscriptionId
  ) {
    return {
      kind: "manual_reconciliation",
      reason: "invoice_contradictory_subscription",
    };
  }

  const customer = stripeResourceReference(
    invoice.customer,
    "customer",
    "cus_"
  );
  if (customer.kind !== "valid") {
    return {
      kind: "manual_reconciliation",
      reason: "invoice_invalid_reference",
    };
  }

  const owner = await invoiceOwner(
    invoice.customer,
    customer.id,
    provider,
    dependencies
  );
  if (owner.kind === "ignored") {
    return owner;
  }
  return {
    kind: "written",
    write: await dependencies.applyEventUpdate({
      billingReason,
      customerId: customer.id,
      eventCreatedAt,
      eventId: event.id,
      eventType:
        event.type === "invoice.paid"
          ? "invoice_paid"
          : "invoice_payment_failed",
      periodEnd: entitlement.end,
      periodStart: entitlement.start,
      stripeSubscriptionId: entitlement.stripeSubscriptionId,
      ...(owner.kind === "attempt_provenance" ? { userId: owner.userId } : {}),
    }),
  };
}

type EntitlementLine = {
  end: Date;
  start: Date;
  stripeSubscriptionId: string;
};

type EntitlementLineDisposition =
  | { entitlement: EntitlementLine; kind: "accepted" }
  | { kind: "ignored"; reason: "invoice_no_entitlement" }
  | {
      kind: "manual_reconciliation";
      reason: StripeWebhookManualReconciliationReason;
    };

async function invoiceEntitlementLine(
  invoice: Stripe.Invoice,
  provider: StripeWebhookProvider,
  priceId: string
): Promise<EntitlementLineDisposition> {
  const embedded = entitlementLines(invoice.lines.data, priceId);
  if (!invoice.lines.has_more) {
    return entitlementLineDisposition(embedded);
  }

  const supported: EntitlementLine[] = [];
  let startingAfter: string | undefined;
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: Stripe pages are cursor-dependent.
    const page = await provider.listInvoiceLines(invoice.id, startingAfter);
    const inspected = entitlementLines(page.data, priceId);
    if (inspected.manualReason) {
      return {
        kind: "manual_reconciliation",
        reason: inspected.manualReason,
      };
    }
    supported.push(...inspected.supported);
    if (supported.length > 1) {
      return {
        kind: "manual_reconciliation",
        reason: "invoice_ambiguous_entitlement",
      };
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

  return entitlementLineDisposition({ manualReason: null, supported });
}

function entitlementLines(
  lines: Stripe.InvoiceLineItem[],
  priceId: string
): {
  manualReason: StripeWebhookManualReconciliationReason | null;
  supported: EntitlementLine[];
} {
  const supported: EntitlementLine[] = [];

  for (const line of lines) {
    const details =
      line.parent?.type === "subscription_item_details"
        ? line.parent.subscription_item_details
        : null;
    if (!details || invoiceLinePriceId(line) !== priceId) {
      continue;
    }
    if (details.proration) {
      continue;
    }

    const lineSubscription = stripeResourceReference(
      line.subscription,
      "subscription",
      "sub_"
    );
    const detailSubscription = stripeResourceReference(
      details.subscription,
      "subscription",
      "sub_"
    );
    if (
      lineSubscription.kind === "invalid" ||
      detailSubscription.kind === "invalid"
    ) {
      return { manualReason: "invoice_invalid_reference", supported };
    }
    if (
      lineSubscription.kind === "valid" &&
      detailSubscription.kind === "valid" &&
      lineSubscription.id !== detailSubscription.id
    ) {
      return {
        manualReason: "invoice_contradictory_subscription",
        supported,
      };
    }
    const stripeSubscriptionId =
      lineSubscription.kind === "valid"
        ? lineSubscription.id
        : detailSubscription.kind === "valid"
          ? detailSubscription.id
          : null;
    if (!stripeSubscriptionId) {
      return { manualReason: "invoice_invalid_reference", supported };
    }

    const start = dateFromStripeSeconds(line.period.start);
    const end = dateFromStripeSeconds(line.period.end);
    if (!(start && end && end > start)) {
      return { manualReason: "invoice_invalid_period", supported };
    }
    supported.push({ end, start, stripeSubscriptionId });
  }

  return { manualReason: null, supported };
}

function entitlementLineDisposition(input: {
  manualReason: StripeWebhookManualReconciliationReason | null;
  supported: EntitlementLine[];
}): EntitlementLineDisposition {
  if (input.manualReason) {
    return { kind: "manual_reconciliation", reason: input.manualReason };
  }
  if (input.supported.length > 1) {
    return {
      kind: "manual_reconciliation",
      reason: "invoice_ambiguous_entitlement",
    };
  }
  const [entitlement] = input.supported;
  return entitlement
    ? { entitlement, kind: "accepted" }
    : { kind: "ignored", reason: "invoice_no_entitlement" };
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

type InvoiceOwner =
  | { kind: "attempt_provenance"; userId: string }
  | { kind: "ignored"; reason: "invoice_unrelated_customer" }
  | { kind: "persisted_customer" };

async function invoiceOwner(
  customer: Stripe.Invoice["customer"],
  customerId: string,
  provider: StripeWebhookProvider,
  dependencies: StripeWebhookDependencies
): Promise<InvoiceOwner> {
  const persisted = await dependencies.findUserByStripeCustomerId(customerId);
  if (persisted) {
    if (persisted.stripeCustomerId !== customerId) {
      throw new Error("Persisted Stripe Customer lookup did not match.");
    }
    return { kind: "persisted_customer" };
  }

  const retrieved =
    customer && typeof customer !== "string"
      ? customer
      : await provider.retrieveCustomer(customerId);
  if (retrieved.id !== customerId) {
    throw new Error("Webhook Customer lookup did not match.");
  }
  const markers = checkoutCustomerMarkers(retrieved);
  if (!markers) {
    return { kind: "ignored", reason: "invoice_unrelated_customer" };
  }
  const attemptState = await dependencies.findCheckoutAttemptState({
    attemptId: markers.attemptId,
    ownerId: markers.userId,
  });
  if (!checkoutAttemptProvesCustomer(attemptState, customerId)) {
    if (
      attemptState?.kind === "fresh" ||
      attemptState?.kind === "create_uncertain"
    ) {
      throw new Error("Checkout Customer ownership may still converge.");
    }
    return { kind: "ignored", reason: "invoice_unrelated_customer" };
  }
  return { kind: "attempt_provenance", userId: markers.userId };
}

function checkoutUserId(session: Stripe.Checkout.Session): string | null {
  const clientReferenceId = session.client_reference_id;
  const metadataUserId = session.metadata?.userId;
  return clientReferenceId &&
    metadataUserId &&
    clientReferenceId === metadataUserId &&
    isCanonicalUuid(clientReferenceId)
    ? clientReferenceId
    : null;
}

function checkoutCustomerMarkers(
  customer: Stripe.Customer | Stripe.DeletedCustomer
): { attemptId: string; userId: string } | null {
  if (customer.deleted) {
    return null;
  }
  const attemptId =
    customer.metadata[CHECKOUT_ATTEMPT_METADATA_KEY] ?? undefined;
  const { userId } = customer.metadata;
  return attemptId &&
    userId &&
    isCanonicalUuid(attemptId) &&
    isCanonicalUuid(userId) &&
    customer.metadata.checkoutFlowVersion === CHECKOUT_FLOW_VERSION
    ? { attemptId, userId }
    : null;
}

type StripeResourceReference =
  | { kind: "invalid" }
  | { kind: "missing" }
  | { id: string; kind: "valid" };

function stripeResourceReference(
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
): StripeResourceReference {
  if (resource === null || resource === undefined) {
    return { kind: "missing" };
  }
  const id =
    typeof resource === "string"
      ? validStripeId(resource, prefix)
      : resource.object === expectedObject
        ? validStripeId(resource.id, prefix)
        : null;
  return id ? { id, kind: "valid" } : { kind: "invalid" };
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
  const reference = stripeResourceReference(resource, expectedObject, prefix);
  return reference.kind === "valid" ? reference.id : null;
}

function validStripeId(
  id: string,
  prefix: "cus_" | "price_" | "sub_"
): string | null {
  return id.startsWith(prefix) && id.length > prefix.length && id.length <= 64
    ? id
    : null;
}

function supportedBillingReason(
  reason: Stripe.Invoice["billing_reason"]
): "subscription_create" | "subscription_cycle" | "subscription_update" | null {
  switch (reason) {
    case "subscription_create":
      return "subscription_create";
    case "subscription_cycle":
      return "subscription_cycle";
    case "subscription_update":
      return "subscription_update";
    default:
      return null;
  }
}

function failedInvoiceMutation(
  current: WebhookUser,
  input: Extract<
    StripeEventUpdateInput,
    { eventType: "invoice_payment_failed" }
  >
): StripeUserMutation | null {
  if (input.billingReason === "subscription_create") {
    if (current.billingPeriodStart || current.subscribedUntil) {
      return null;
    }
    return nonEmptyMutation(customerMutation(current, input.customerId));
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

function reconciliationEventType(
  eventType: Stripe.Event["type"]
): "invoice.paid" | "invoice.payment_failed" {
  if (eventType === "invoice.paid" || eventType === "invoice.payment_failed") {
    return eventType;
  }
  throw new Error("Unsupported reconciliation event type.");
}

function manualReconciliationResponse(
  write: StripeManualReconciliationWriteResult,
  dependencies: StripeWebhookDependencies
): Response {
  if (write === "duplicate") {
    return Response.json({ deduped: true });
  }
  try {
    dependencies.reportManualReconciliation(write.record);
  } catch {
    // Durable evidence has committed; logging cannot make it retryable.
  }
  return Response.json({
    reason: write.record.reason,
    reconciliation: true,
  });
}

function retryableWebhookResponse(): Response {
  return Response.json({ error: "webhook_retry" }, { status: 503 });
}
