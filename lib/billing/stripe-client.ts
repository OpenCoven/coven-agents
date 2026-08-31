import "server-only";

import Stripe from "stripe";

export function createStripeClient(apiKey: string): Stripe {
  return new Stripe(apiKey, { apiVersion: "2026-07-29.dahlia" });
}
