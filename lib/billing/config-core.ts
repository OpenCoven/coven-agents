const STRIPE_VARIABLES = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
  "STRIPE_METERED_PRICE_ID",
  "STRIPE_METER_EVENT_NAME",
] as const;

type SubscriptionCheckoutState = { enabled: false } | { enabled: true };

export function subscriptionCheckoutEnabled(
  env: Pick<NodeJS.ProcessEnv, "SUBSCRIPTION_CHECKOUT_ENABLED">
): boolean {
  const configured = env.SUBSCRIPTION_CHECKOUT_ENABLED;
  if (
    configured === undefined ||
    configured.trim() === "" ||
    configured === "off"
  ) {
    return false;
  }
  if (configured === "on") {
    return true;
  }
  throw new Error(
    'SUBSCRIPTION_CHECKOUT_ENABLED must be exactly "on" or "off" when configured.'
  );
}

export function validateSubscriptionCheckoutEnvironment(
  env: NodeJS.ProcessEnv
): SubscriptionCheckoutState {
  const enabled = subscriptionCheckoutEnabled({
    SUBSCRIPTION_CHECKOUT_ENABLED: env.SUBSCRIPTION_CHECKOUT_ENABLED,
  });
  if (!enabled) {
    return { enabled: false };
  }

  const missing = STRIPE_VARIABLES.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `Subscription Checkout requires nonblank environment variables: ${missing.join(", ")}.`
    );
  }

  return { enabled: true };
}
