import { ipAddress } from "@vercel/functions";
import { enforceAbusePolicy } from "@/lib/abuse/enforce";
import { createStripeClient } from "@/lib/billing/stripe-client";
import {
  type StripeWebhookDependencies,
  stripeWebhookResponse,
} from "@/lib/billing/webhook";
import {
  applyStripeEventUpdate,
  findUserById,
  findUserByStripeCustomerId,
} from "@/lib/db/queries";

const webhookDependencies: StripeWebhookDependencies = {
  applyEventUpdate: applyStripeEventUpdate,
  createProvider(apiKey) {
    const stripe = createStripeClient(apiKey);
    return {
      constructEvent(raw, signature, secret) {
        return stripe.webhooks.constructEventAsync(raw, signature, secret);
      },
      retrieveCustomer(customerId) {
        return stripe.customers.retrieve(customerId);
      },
    };
  },
  enforceAbuse: enforceAbusePolicy,
  findUserById,
  findUserByStripeCustomerId,
  getConfig() {
    const apiKey = process.env.STRIPE_SECRET_KEY?.trim();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    return apiKey && webhookSecret ? { apiKey, webhookSecret } : null;
  },
};

export function POST(request: Request): Promise<Response> {
  return stripeWebhookResponse(
    request,
    webhookDependencies,
    ipAddress(request) ?? null
  );
}
