export type SubscriptionAuthority = Readonly<{
  checkedAt: string;
  isSubscriber: boolean;
  subscribedUntil: string | null;
  userId: string | null;
}>;

export type EffectiveSubscriptionAuthority = Readonly<{
  isSubscriber: boolean;
  subscribedUntil: string | null;
}>;

const INACTIVE_AUTHORITY: EffectiveSubscriptionAuthority = {
  isSubscriber: false,
  subscribedUntil: null,
};

function finiteFutureTimestamp(
  value: Date | string | null | undefined,
  nowMs: number
): string | null {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(timestamp) && timestamp > nowMs
    ? new Date(timestamp).toISOString()
    : null;
}

export function serializeSubscriptionAuthority({
  checkedAt,
  isSubscriber,
  subscribedUntil,
  userId,
}: {
  checkedAt: Date;
  isSubscriber: boolean;
  subscribedUntil: Date | string | null | undefined;
  userId: string | null;
}): SubscriptionAuthority {
  const checkedAtMs = checkedAt.getTime();
  const checkedAtIso = Number.isFinite(checkedAtMs)
    ? checkedAt.toISOString()
    : "";
  const activeUntil =
    isSubscriber && Number.isFinite(checkedAtMs)
      ? finiteFutureTimestamp(subscribedUntil, checkedAtMs)
      : null;

  return {
    checkedAt: checkedAtIso,
    isSubscriber: activeUntil !== null,
    subscribedUntil: activeUntil,
    userId,
  };
}

export function effectiveSubscriptionAuthority(
  authority: SubscriptionAuthority | null,
  sessionUserId: string | null | undefined,
  authorityPending = false,
  nowMs = Date.now()
): EffectiveSubscriptionAuthority {
  if (
    authorityPending ||
    !(sessionUserId && authority?.userId === sessionUserId) ||
    !Number.isFinite(Date.parse(authority.checkedAt)) ||
    !authority.isSubscriber
  ) {
    return INACTIVE_AUTHORITY;
  }

  const activeUntil = finiteFutureTimestamp(authority.subscribedUntil, nowMs);
  if (!activeUntil) {
    return INACTIVE_AUTHORITY;
  }

  return {
    isSubscriber: true,
    subscribedUntil: activeUntil,
  };
}
