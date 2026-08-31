import type { SubscriptionAuthority } from "./subscription-authority";

export type SubscriptionAuthorityRevision = Readonly<{
  checkedAt: string;
  checkedAtMs: number;
  contextKey: string;
}>;

export function subscriptionAuthorityRevisionContext(
  userId: string | null | undefined,
  authVersion: number | null | undefined
): string {
  return `${userId ?? ""}:${Number.isInteger(authVersion) ? authVersion : ""}`;
}

export function subscriptionAuthorityRevision(
  authority: SubscriptionAuthority | null,
  sessionUserId: string | null | undefined,
  authVersion: number | null | undefined
): SubscriptionAuthorityRevision | null {
  if (!(sessionUserId && authority?.userId === sessionUserId)) {
    return null;
  }
  const checkedAtMs = Date.parse(authority.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return null;
  }
  return {
    checkedAt: authority.checkedAt,
    checkedAtMs,
    contextKey: subscriptionAuthorityRevisionContext(
      sessionUserId,
      authVersion
    ),
  };
}

export type SubscriptionAuthorityInvalidationFence = Readonly<{
  invalidate: (revision: SubscriptionAuthorityRevision) => boolean;
  isPending: (
    revision: SubscriptionAuthorityRevision | null,
    contextKey: string
  ) => boolean;
  reconcile: (
    revision: SubscriptionAuthorityRevision | null,
    contextKey: string
  ) => boolean;
}>;

export function createSubscriptionAuthorityInvalidationFence(): SubscriptionAuthorityInvalidationFence {
  let invalidated: SubscriptionAuthorityRevision | null = null;

  return {
    invalidate: (revision) => {
      if (
        invalidated?.contextKey === revision.contextKey &&
        invalidated.checkedAtMs >= revision.checkedAtMs
      ) {
        return false;
      }
      invalidated = revision;
      return true;
    },
    isPending: (revision, contextKey) =>
      invalidated?.contextKey === contextKey &&
      (!revision || revision.checkedAtMs <= invalidated.checkedAtMs),
    reconcile: (revision, contextKey) => {
      if (!invalidated) {
        return false;
      }
      if (
        invalidated.contextKey !== contextKey ||
        (revision && revision.checkedAtMs > invalidated.checkedAtMs)
      ) {
        invalidated = null;
        return true;
      }
      return false;
    },
  };
}
