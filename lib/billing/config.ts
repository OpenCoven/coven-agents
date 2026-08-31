export type SubscriptionCheckoutConfig =
  | { enabled: false }
  | {
      apiKey: string;
      enabled: true;
      priceId: string;
      webhookSecret: string;
    };

const STRIPE_VARIABLES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
] as const;

export function subscriptionCheckoutEnabled(
  env: Pick<NodeJS.ProcessEnv, "SUBSCRIPTION_CHECKOUT_ENABLED">
): boolean {
  return env.SUBSCRIPTION_CHECKOUT_ENABLED === "on";
}

export function subscriptionCheckoutConfig(
  env: NodeJS.ProcessEnv
): SubscriptionCheckoutConfig {
  const configured = env.SUBSCRIPTION_CHECKOUT_ENABLED;
  if (
    configured === undefined ||
    configured.trim() === "" ||
    configured === "off"
  ) {
    return { enabled: false };
  }
  if (
    !subscriptionCheckoutEnabled({
      SUBSCRIPTION_CHECKOUT_ENABLED: configured,
    })
  ) {
    throw new Error(
      'SUBSCRIPTION_CHECKOUT_ENABLED must be exactly "on" or "off" when configured.'
    );
  }

  const missing = STRIPE_VARIABLES.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Subscription Checkout requires nonblank environment variables: ${missing.join(", ")}.`
    );
  }

  return {
    apiKey: env.STRIPE_SECRET_KEY?.trim() ?? "",
    enabled: true,
    priceId: env.STRIPE_PRICE_ID?.trim() ?? "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
  };
}
