export type SubscriptionAuthority = Readonly<{
  authVersion: number | null;
  checkedAt: string;
  isSubscriber: boolean;
  resolutionId: string;
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
  authVersion,
  checkedAt,
  isSubscriber,
  resolutionId,
  subscribedUntil,
  userId,
}: {
  authVersion: number | null | undefined;
  checkedAt: Date;
  isSubscriber: boolean;
  resolutionId: string;
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
    authVersion:
      Number.isInteger(authVersion) && (authVersion ?? -1) >= 0
        ? (authVersion ?? null)
        : null,
    checkedAt: checkedAtIso,
    isSubscriber: activeUntil !== null,
    resolutionId,
    subscribedUntil: activeUntil,
    userId,
  };
}

export function effectiveSubscriptionAuthority(
  authority: SubscriptionAuthority | null,
  sessionUserId: string | null | undefined,
  sessionAuthVersion: number | null | undefined,
  authorityPending = false,
  nowMs = Date.now()
): EffectiveSubscriptionAuthority {
  if (
    authorityPending ||
    !(
      sessionUserId &&
      authority?.userId === sessionUserId &&
      Number.isInteger(sessionAuthVersion) &&
      authority.authVersion === sessionAuthVersion
    ) ||
    !Number.isFinite(Date.parse(authority.checkedAt)) ||
    !authority.isSubscriber ||
    typeof authority.resolutionId !== "string" ||
    authority.resolutionId.length === 0
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
