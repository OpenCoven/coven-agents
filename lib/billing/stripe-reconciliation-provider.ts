import "server-only";

import Stripe from "stripe";
import { createStripeClient } from "./stripe-client";
import type {
  StripeInvoiceLineObservation,
  StripeInvoiceObservation,
  StripeReconciliationPage,
  StripeReconciliationProvider,
  StripeSubscriptionObservation,
} from "./stripe-reconciliation";
import { StripeReconciliationProviderUnauthorizedError } from "./stripe-reconciliation";

type StripeReconciliationStripeClient = Pick<
  Stripe,
  "invoices" | "subscriptions"
>;

/**
 * Keeps Stripe SDK shapes in this server-only boundary. Reconciliation itself
 * receives only the small normalized observations it needs to make a
 * conservative entitlement decision.
 */
export function createStripeReconciliationProvider(
  apiKey: string
): StripeReconciliationProvider {
  return createStripeReconciliationProviderFromClient(
    createStripeClient(apiKey)
  );
}

export function createStripeReconciliationProviderFromClient(
  stripe: StripeReconciliationStripeClient
): StripeReconciliationProvider {
  return {
    async listInvoiceLines(invoiceId, input) {
      try {
        const page = await stripe.invoices.listLineItems(invoiceId, {
          limit: input.limit,
          starting_after: input.startingAfter,
        });
        return invoiceLinePage(page);
      } catch (error) {
        throwProviderFailure(error);
      }
    },
    async listSubscriptions(customerId, input) {
      try {
        const page = await stripe.subscriptions.list({
          customer: customerId,
          limit: input.limit,
          ...(input.startingAfter
            ? { starting_after: input.startingAfter }
            : {}),
          status: "all",
        });
        return {
          data: page.data.map(subscriptionObservation),
          hasMore: page.has_more,
        };
      } catch (error) {
        throwProviderFailure(error);
      }
    },
    async retrieveInvoice(invoiceId) {
      try {
        return invoiceObservation(await stripe.invoices.retrieve(invoiceId));
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throwProviderFailure(error);
      }
    },
    async retrieveSubscription(subscriptionId) {
      try {
        return subscriptionObservation(
          await stripe.subscriptions.retrieve(subscriptionId)
        );
      } catch (error) {
        if (isNotFound(error)) {
          return null;
        }
        throwProviderFailure(error);
      }
    },
  };
}

function subscriptionObservation(
  subscription: Stripe.Subscription
): StripeSubscriptionObservation {
  return {
    customerId: stripeId(subscription.customer, "cus_"),
    id: subscription.id,
    latestInvoiceId: stripeId(subscription.latest_invoice, "in_"),
    priceIds: subscription.items.data.flatMap((item) => {
      const id = stripeId(item.price, "price_");
      return id ? [id] : [];
    }),
    status: subscription.status,
  };
}

function invoiceObservation(invoice: Stripe.Invoice): StripeInvoiceObservation {
  return {
    billingReason:
      typeof invoice.billing_reason === "string"
        ? invoice.billing_reason
        : null,
    customerId: stripeId(invoice.customer, "cus_"),
    evidenceCreatedAt: dateFromStripeSeconds(invoice.created),
    id: invoice.id,
    lines: invoiceLinePage(invoice.lines),
    paid: invoice.status === "paid",
    stripeSubscriptionId: stripeId(
      invoice.parent?.subscription_details?.subscription,
      "sub_"
    ),
  };
}

function invoiceLinePage(
  page: Stripe.ApiList<Stripe.InvoiceLineItem>
): StripeReconciliationPage<StripeInvoiceLineObservation> {
  return {
    data: page.data.map(invoiceLineObservation),
    hasMore: page.has_more,
  };
}

function invoiceLineObservation(
  line: Stripe.InvoiceLineItem
): StripeInvoiceLineObservation {
  const details =
    line.parent?.type === "subscription_item_details"
      ? line.parent.subscription_item_details
      : null;
  const lineSubscriptionId = stripeId(line.subscription, "sub_");
  const itemSubscriptionId = stripeId(details?.subscription, "sub_");
  return {
    id: line.id,
    invalidSubscriptionReference:
      (line.subscription !== null &&
        line.subscription !== undefined &&
        !lineSubscriptionId) ||
      (details?.subscription !== null &&
        details?.subscription !== undefined &&
        !itemSubscriptionId),
    periodEnd: dateFromStripeSeconds(line.period.end),
    periodStart: dateFromStripeSeconds(line.period.start),
    priceId: invoiceLinePriceId(line),
    proration: details?.proration === true,
    stripeSubscriptionId: lineSubscriptionId,
    subscriptionItem: details !== null,
    subscriptionItemSubscriptionId: itemSubscriptionId,
  };
}

function invoiceLinePriceId(line: Stripe.InvoiceLineItem): string | null {
  if (line.pricing?.type !== "price_details") {
    return null;
  }
  return stripeId(line.pricing.price_details?.price, "price_");
}

function stripeId(
  resource: unknown,
  prefix: "cus_" | "in_" | "price_" | "sub_"
): string | null {
  const id =
    typeof resource === "string"
      ? resource
      : resource &&
          typeof resource === "object" &&
          !("deleted" in resource && resource.deleted === true) &&
          "id" in resource &&
          typeof resource.id === "string"
        ? resource.id
        : null;
  return id?.startsWith(prefix) && id.length > prefix.length && id.length <= 64
    ? id
    : null;
}

function dateFromStripeSeconds(seconds: number): Date | null {
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < 0 ||
    seconds > Math.floor(Date.parse("9999-12-31T23:59:59.999Z") / 1000)
  ) {
    return null;
  }
  const value = new Date(seconds * 1000);
  return Number.isNaN(value.getTime()) ? null : value;
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Stripe.errors.StripeInvalidRequestError &&
    error.statusCode === 404
  );
}

function throwProviderFailure(error: unknown): never {
  if (
    error instanceof Stripe.errors.StripeError &&
    (error.statusCode === 401 || error.statusCode === 403)
  ) {
    throw new StripeReconciliationProviderUnauthorizedError();
  }
  throw error;
}
