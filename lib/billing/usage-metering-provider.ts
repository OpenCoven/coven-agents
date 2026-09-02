import "server-only";

import Stripe from "stripe";
import { createStripeClient } from "./stripe-client";
import {
  type UsageMeteringProvider,
  UsageMeteringProviderUnauthorizedError,
} from "./usage-metering";

type UsageMeteringStripeClient = Pick<Stripe, "billing">;

/**
 * Keeps Stripe SDK shapes inside this server-only boundary. The reporter
 * only ever learns whether an event was accepted, was refused by credential,
 * or failed for a reason worth retrying later.
 */
export function createUsageMeteringProvider(
  apiKey: string
): UsageMeteringProvider {
  return createUsageMeteringProviderFromClient(createStripeClient(apiKey));
}

export function createUsageMeteringProviderFromClient(
  stripe: UsageMeteringStripeClient
): UsageMeteringProvider {
  return {
    async createMeterEvent(input) {
      try {
        await stripe.billing.meterEvents.create({
          event_name: input.eventName,
          identifier: input.identifier,
          payload: {
            stripe_customer_id: input.customerId,
            value: String(input.value),
          },
          timestamp: Math.floor(input.timestamp.getTime() / 1000),
        });
      } catch (error) {
        if (
          error instanceof Stripe.errors.StripeError &&
          (error.statusCode === 401 || error.statusCode === 403)
        ) {
          // biome-ignore lint/style/useErrorCause: Provider errors can carry request metadata.
          throw new UsageMeteringProviderUnauthorizedError();
        }
        // biome-ignore lint/style/useErrorCause: Provider errors can carry request metadata.
        throw new Error("Stripe meter event could not be created.");
      }
    },
  };
}
