import { eq, type SQL } from "drizzle-orm";
import type { StripeEventUpdateInput } from "@/lib/billing/webhook";
import { user } from "./schema";

export function stripeEventOwnerWhere(
  input: StripeEventUpdateInput
): SQL<unknown> {
  return input.userId
    ? eq(user.id, input.userId)
    : eq(user.stripeCustomerId, input.customerId);
}
