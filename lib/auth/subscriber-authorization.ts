import { sessionAuthorityMatches } from "./session-revocation";
import {
  decideSubscriberAccess,
  type SessionLike,
  type SubscriberAccessDecision,
} from "./subscriber-access";

type SubscriptionRecord = {
  campaignExpiresAt?: Date | null;
  campaignGrantedAt?: Date | null;
  authVersion?: number | null;
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

  let user: SubscriptionRecord | null;
  try {
    user = await lookup(decision.userId);
  } catch {
    return { kind: "subscription_required" };
  }
  if (
    !user ||
    !sessionAuthorityMatches({
      database: {
        authVersion: user.authVersion ?? Number.NaN,
        campaignExpiresAt: user.campaignExpiresAt,
        campaignGrantedAt: user.campaignGrantedAt,
        subscribedUntil: user.subscribedUntil ?? null,
      },
      now,
      tokenAuthVersion: session?.user?.authVersion ?? Number.NaN,
    })
  ) {
    return { kind: "subscription_required" };
  }

  return decision;
}
