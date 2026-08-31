import "server-only";

import { validateSubscriptionCheckoutEnvironment } from "./config-core";

export { subscriptionCheckoutEnabled } from "./config-core";

export type SubscriptionCheckoutConfig =
  | { enabled: false }
  | {
      apiKey: string;
      enabled: true;
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
    priceId: env.STRIPE_PRICE_ID?.trim() ?? "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
  };
}
