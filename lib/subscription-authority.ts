export type SubscriptionAuthority = Readonly<{
  isSubscriber: boolean;
  subscribedUntil: string | null;
  userId: string;
}> | null;

export type EffectiveSubscriptionAuthority = Readonly<{
  isSubscriber: boolean;
  subscribedUntil: string | null;
}>;

const INACTIVE_AUTHORITY: EffectiveSubscriptionAuthority = {
  isSubscriber: false,
  subscribedUntil: null,
};

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
