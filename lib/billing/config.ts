import "server-only";

import { validateSubscriptionCheckoutEnvironment } from "./config-core";

export { subscriptionCheckoutEnabled } from "./config-core";

export type SubscriptionCheckoutConfig =
  | { enabled: false }
  | {
      apiKey: string;
      enabled: true;
      /** Name of the Stripe Billing Meter that settled run minutes report to. */
      meterEventName: string;
      /** The metered per-minute Price attached alongside the base Price. */
      meteredPriceId: string;
      /** The recurring base Price; entitlement is decided from this one. */
      priceId: string;
      webhookSecret: string;
    };

export function subscriptionCheckoutConfig(
  env: NodeJS.ProcessEnv
): SubscriptionCheckoutConfig {
  const state = validateSubscriptionCheckoutEnvironment(env);
  if (!state.enabled) {
    return state;
  }

  return {
    apiKey: env.STRIPE_SECRET_KEY?.trim() ?? "",
    enabled: true,
    meterEventName: env.STRIPE_METER_EVENT_NAME?.trim() ?? "",
    meteredPriceId: env.STRIPE_METERED_PRICE_ID?.trim() ?? "",
    priceId: env.STRIPE_PRICE_ID?.trim() ?? "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
  };
}
