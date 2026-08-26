import { isSubscribedAt } from "@/lib/subscription";
import {
  decideSubscriberAccess,
  type SessionLike,
  type SubscriberAccessDecision,
} from "./subscriber-access";

type SubscriptionRecord = {
  subscribedUntil?: Date | null;
};

type SubscriptionLookup = (
  userId: string
) => Promise<SubscriptionRecord | null>;

export async function revalidateSubscriberAccess(
  session: SessionLike,
  lookup: SubscriptionLookup,
  now = new Date()
): Promise<SubscriberAccessDecision> {
  const decision = decideSubscriberAccess(session);
  if (decision.kind !== "allowed") {
    return decision;
  }

  const user = await lookup(decision.userId);
  if (!user || !isSubscribedAt(user, now)) {
    return { kind: "subscription_required" };
  }

  return decision;
}
