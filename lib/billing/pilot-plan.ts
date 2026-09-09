import type Stripe from "stripe";
import {
  DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS,
  DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS,
} from "../runner/daytona/resource-policy";
import { MONTHLY_MINUTE_CAP, RUN_MINUTE_RESERVATION } from "./limits";

export const CLOUD_PILOT_PLAN = Object.freeze({
  billingManagementPath: "/account?billing=managed",
  includedMinutes: MONTHLY_MINUTE_CAP,
  inference: "customer_supplied" as const,
  interval: "month" as const,
  maximumRunMinutes: RUN_MINUTE_RESERVATION,
  overage: "none" as const,
  sandboxPolicy: Object.freeze({
    caps: DAYTONA_SANDBOX_RESOURCE_POLICY_CAPS,
    defaults: DAYTONA_SANDBOX_RESOURCE_POLICY_DEFAULTS,
  }),
  usagePath: "/api/usage",
});

export type PilotSubscriptionPrice = Pick<
  Stripe.Price,
  | "active"
  | "billing_scheme"
  | "currency"
  | "custom_unit_amount"
  | "id"
  | "transform_quantity"
  | "type"
  | "unit_amount"
> & {
  recurring: Pick<
    NonNullable<Stripe.Price["recurring"]>,
    "interval" | "interval_count" | "trial_period_days" | "usage_type"
  > | null;
  unit_amount_decimal: string | null;
};

export function assertPilotSubscriptionPrice(
  price: PilotSubscriptionPrice,
  expectedPriceId: string
): void {
  if (
    price.id !== expectedPriceId ||
    !price.active ||
    price.type !== "recurring" ||
    price.billing_scheme !== "per_unit" ||
    price.recurring?.interval !== CLOUD_PILOT_PLAN.interval ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed" ||
    (price.recurring.trial_period_days ?? 0) !== 0 ||
    price.custom_unit_amount !== null ||
    price.transform_quantity !== null ||
    !/^[a-z]{3}$/.test(price.currency) ||
    price.unit_amount === null ||
    !Number.isSafeInteger(price.unit_amount) ||
    price.unit_amount <= 0 ||
    price.unit_amount_decimal === null ||
    !/^(?:0|[1-9]\d*)(?:\.0+)?$/.test(price.unit_amount_decimal) ||
    price.unit_amount_decimal.split(".")[0] !== String(price.unit_amount)
  ) {
    throw new Error(
      "The configured Price does not match the monthly cloud pilot."
    );
  }
}
