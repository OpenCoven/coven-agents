import { ipAddress } from "@vercel/functions";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { minutePacksFromEnv } from "@/lib/billing/minute-packs";
import { createStripeClient } from "@/lib/billing/stripe-client";
import {
  type StripeWebhookDependencies,
  stripeWebhookResponse,
} from "@/lib/billing/webhook";
import {
  applyStripeEventUpdate,
  creditMinutePack,
  findCheckoutAttemptState,
  findUserByStripeCustomerId,
  recordStripeReconciliation,
} from "@/lib/db/queries";

const webhookDependencies: StripeWebhookDependencies = {
  applyEventUpdate: applyStripeEventUpdate,
  createProvider(apiKey) {
    const stripe = createStripeClient(apiKey);
    return {
      constructEvent(raw, signature, secret) {
        return stripe.webhooks.constructEventAsync(
          Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength),
          signature,
          secret
        );
      },
      listInvoiceLines(invoiceId, startingAfter) {
        return stripe.invoices.listLineItems(invoiceId, {
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
        });
      },
      retrieveCustomer(customerId) {
        return stripe.customers.retrieve(customerId);
      },
    };
  },
  creditMinutePack,
  enforceAbuse: enforceAbusePolicy,
  findCheckoutAttemptState,
  findUserByStripeCustomerId,
  getConfig() {
    const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
    const priceId = process.env.STRIPE_PRICE_ID?.trim();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    return apiKey && priceId && webhookSecret
      ? {
          apiKey,
          minutePacks: minutePacksFromEnv(process.env),
          priceId,
          webhookSecret,
        }
      : null;
  },
  recordManualReconciliation: recordStripeReconciliation,
  reportManualReconciliation(alert) {
    console.error(alert);
  },
};

export function POST(request: Request): Promise<Response> {
  return stripeWebhookResponse(
    request,
    webhookDependencies,
    ipAddress(request) ?? null
  );
}
