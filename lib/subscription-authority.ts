export type SubscriptionAuthority = Readonly<{
  authorityExpiresAt?: string | null;
  authVersion: number | null;
  checkedAt: string;
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
    authVersion?: number | null;
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
  const authVersion = session.user?.authVersion;
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
    authVersion: Number.isInteger(authVersion) ? (authVersion ?? null) : null,
    checkedAt: now.toISOString(),
    isSubscriber,
    subscribedUntil: null,
    userId,
  };
}

export function subscriptionAuthorityExpiryBoundary(
  authority: SubscriptionAuthority,
  sessionUserId: string | null | undefined,
  sessionAuthVersion: number | null | undefined
): string | null {
  if (
    !(
      sessionUserId &&
      authority?.userId === sessionUserId &&
      authority.authVersion === sessionAuthVersion
    )
  ) {
    return null;
  }
  return authority.subscribedUntil ?? authority.authorityExpiresAt ?? null;
}

export function effectiveSubscriptionAuthority(
  authority: SubscriptionAuthority,
  sessionUserId: string | null | undefined,
  sessionAuthVersion: number | null | undefined,
  authorityPending = false
): EffectiveSubscriptionAuthority {
  if (
    authorityPending ||
    !(
      sessionUserId &&
      authority?.userId === sessionUserId &&
      authority.authVersion === sessionAuthVersion
    )
  ) {
    return INACTIVE_AUTHORITY;
  }
  return {
    isSubscriber: authority.isSubscriber,
    subscribedUntil: authority.isSubscriber ? authority.subscribedUntil : null,
  };
}
