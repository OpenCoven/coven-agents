import assert from "node:assert/strict";
import test from "node:test";
import {
  subscriptionCheckoutConfig,
  subscriptionCheckoutEnabled,
} from "./config";

function environment(overrides: Partial<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ...overrides,
  };
}

test("subscription checkout is disabled unless the flag is exactly on", () => {
  for (const value of [undefined, "", "  ", "off", "true", "1", "ON", "on "]) {
    assert.equal(
      subscriptionCheckoutEnabled({
        SUBSCRIPTION_CHECKOUT_ENABLED: value,
      }),
      false
    );
  }

  assert.equal(
    subscriptionCheckoutEnabled({
      SUBSCRIPTION_CHECKOUT_ENABLED: "on",
    }),
    true
  );
});

test("disabled checkout does not require Stripe configuration", () => {
  for (const value of [undefined, "", "  ", "off"]) {
    assert.deepEqual(
      subscriptionCheckoutConfig(
        environment({
          SUBSCRIPTION_CHECKOUT_ENABLED: value,
        })
      ),
      { enabled: false }
    );
  }
});

test("enabled checkout returns nonblank Stripe configuration", () => {
  assert.deepEqual(
    subscriptionCheckoutConfig(
      environment({
        STRIPE_PRICE_ID: " price_test ",
        STRIPE_SECRET_KEY: " sk_test ",
        STRIPE_WEBHOOK_SECRET: " whsec_test ",
        SUBSCRIPTION_CHECKOUT_ENABLED: "on",
      })
    ),
    {
      apiKey: "sk_test",
      enabled: true,
      priceId: "price_test",
      webhookSecret: "whsec_test",
    }
  );
});

test("enabled checkout names every missing Stripe variable", () => {
  assert.throws(
    () =>
      subscriptionCheckoutConfig(
        environment({
          STRIPE_PRICE_ID: " ",
          STRIPE_SECRET_KEY: undefined,
          STRIPE_WEBHOOK_SECRET: "",
          SUBSCRIPTION_CHECKOUT_ENABLED: "on",
        })
      ),
    new Error(
      "Subscription Checkout requires nonblank environment variables: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID."
    )
  );
});

test("checkout configuration rejects invalid configured flag values", () => {
  for (const value of ["true", "1", "ON", "on ", "disabled"]) {
    assert.throws(
      () =>
        subscriptionCheckoutConfig(
          environment({
            SUBSCRIPTION_CHECKOUT_ENABLED: value,
          })
        ),
      new Error(
        'SUBSCRIPTION_CHECKOUT_ENABLED must be exactly "on" or "off" when configured.'
      )
    );
  }
});
