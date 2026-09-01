import { and, eq, type SQL, sql } from "drizzle-orm";
import { user } from "./schema";

export function subscriptionOverrideOwnerWhere(userId: string): SQL<unknown> {
  return eq(user.id, userId);
}

export function subscriptionOverrideWriteFenceWhere(input: {
  expectedAuthVersion: number;
  expectedBillingPeriodStart: Date | null;
  expectedSubscribedUntil: Date | null;
  userId: string;
}): SQL<unknown> {
  return and(
    eq(user.id, input.userId),
    eq(user.authVersion, input.expectedAuthVersion),
    sql`${user.billingPeriodStart} is not distinct from ${input.expectedBillingPeriodStart}`,
    sql`${user.subscribedUntil} is not distinct from ${input.expectedSubscribedUntil}`
  ) as SQL<unknown>;
}
