import { and, eq, type SQL } from "drizzle-orm";
import { user } from "./schema";

export function subscriptionOverrideOwnerWhere(userId: string): SQL<unknown> {
  return eq(user.id, userId);
}

export function subscriptionOverrideWriteFenceWhere(input: {
  expectedAuthVersion: number;
  userId: string;
}): SQL<unknown> {
  return and(
    eq(user.id, input.userId),
    eq(user.authVersion, input.expectedAuthVersion)
  ) as SQL<unknown>;
}
