export type SubscriptionAuthority = Readonly<{
  authorityExpiresAt?: string | null;
  isSubscriber: boolean;
  subscribedUntil: string | null;
  userId: string;
}> | null;

export type EffectiveSubscriptionAuthority = Readonly<{
  isSubscriber: boolean;
  subscribedUntil: string | null;
}>;

type SubscriptionAuthoritySession = Readonly<{
  user?: Readonly<{
    id?: string | null;
    subscriptionAuthorityExpiresAt?: string | null;
    type?: string | null;
  }> | null;
}>;

const INACTIVE_AUTHORITY: EffectiveSubscriptionAuthority = {
  isSubscriber: false,
  subscribedUntil: null,
};

export function storageUnavailableSubscriptionAuthority(
  session: SubscriptionAuthoritySession,
  now: Date
): SubscriptionAuthority {
  const userId = session.user?.id;
  if (!userId) {
    return null;
  }
  const subscribedUntil = session.user?.subscriptionAuthorityExpiresAt;
  const boundary =
    typeof subscribedUntil === "string"
      ? Date.parse(subscribedUntil)
      : Number.NaN;
  const isSubscriber =
    session.user?.type === "subscriber" &&
    Number.isFinite(boundary) &&
    boundary > now.getTime();
  return {
    authorityExpiresAt: isSubscriber ? subscribedUntil : null,
    isSubscriber,
    subscribedUntil: null,
    userId,
  };
}

export function subscriptionAuthorityExpiryBoundary(
  authority: SubscriptionAuthority,
  sessionUserId: string | null | undefined
): string | null {
  if (!(sessionUserId && authority?.userId === sessionUserId)) {
    return null;
  }
  return authority.subscribedUntil ?? authority.authorityExpiresAt ?? null;
}

export function effectiveSubscriptionAuthority(
  authority: SubscriptionAuthority,
  sessionUserId: string | null | undefined,
  authorityPending = false
): EffectiveSubscriptionAuthority {
  if (
    authorityPending ||
    !(sessionUserId && authority?.userId === sessionUserId)
  ) {
    return INACTIVE_AUTHORITY;
  }
  return {
    isSubscriber: authority.isSubscriber,
    subscribedUntil: authority.isSubscriber ? authority.subscribedUntil : null,
  };
}
