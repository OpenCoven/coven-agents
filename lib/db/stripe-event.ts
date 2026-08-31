import { and, eq, type SQL } from "drizzle-orm";
import { CHECKOUT_ATTEMPT_OPERATION } from "@/lib/billing/checkout-lease";
import type { StripeEventUpdateInput } from "@/lib/billing/webhook";
import { idempotencyRecord, user } from "./schema";

export function stripeEventOwnerWhere(
  input: StripeEventUpdateInput
): SQL<unknown> {
  return input.userId
    ? eq(user.id, input.userId)
    : eq(user.stripeCustomerId, input.customerId);
}

export function checkoutAttemptProvenanceWhere(input: {
  attemptId: string;
  ownerId: string;
}): SQL<unknown> {
  return and(
    eq(idempotencyRecord.id, input.attemptId),
    eq(idempotencyRecord.operation, CHECKOUT_ATTEMPT_OPERATION),
    eq(idempotencyRecord.ownerId, input.ownerId)
  ) as SQL<unknown>;
}
