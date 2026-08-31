import type { SubscriptionAuthority } from "./subscription-authority";

export type SubscriptionAuthorityRevision = Readonly<{
  authorityKey: string;
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
  authority: SubscriptionAuthority,
  sessionUserId: string | null | undefined,
  authVersion: number | null | undefined
): SubscriptionAuthorityRevision | null {
  if (
    !(
      sessionUserId &&
      authority?.userId === sessionUserId &&
      Number.isInteger(authVersion) &&
      authority.authVersion === authVersion
    )
  ) {
    return null;
  }
  const checkedAtMs = Date.parse(authority.checkedAt);
  if (!Number.isFinite(checkedAtMs)) {
    return null;
  }
  return {
    authorityKey: JSON.stringify([
      authority.authVersion,
      authority.isSubscriber,
      authority.subscribedUntil,
      authority.authorityExpiresAt ?? null,
    ]),
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
  let incident: {
    authorityKey: string;
    contextKey: string;
    retried: boolean;
  } | null = null;

  return {
    invalidate: (revision) => {
      if (
        invalidated?.contextKey === revision.contextKey &&
        invalidated.checkedAtMs >= revision.checkedAtMs
      ) {
        return false;
      }
      const sameIncident =
        incident?.contextKey === revision.contextKey &&
        incident.authorityKey === revision.authorityKey;
      if (
        incident &&
        sameIncident &&
        invalidated &&
        revision.checkedAtMs > invalidated.checkedAtMs
      ) {
        incident.retried = true;
      }
      if (incident && sameIncident && incident.retried) {
        invalidated = revision;
        return false;
      }
      incident = {
        authorityKey: revision.authorityKey,
        contextKey: revision.contextKey,
        retried: false,
      };
      invalidated = revision;
      return true;
    },
    isPending: (revision, contextKey) => {
      if (invalidated?.contextKey !== contextKey) {
        return false;
      }
      if (!revision) {
        return true;
      }
      if (revision.authorityKey !== invalidated.authorityKey) {
        return false;
      }
      if (
        incident?.contextKey === contextKey &&
        incident.authorityKey === revision.authorityKey &&
        incident.retried
      ) {
        return true;
      }
      return revision.checkedAtMs <= invalidated.checkedAtMs;
    },
    reconcile: (revision, contextKey) => {
      if (!invalidated) {
        return false;
      }
      if (
        invalidated.contextKey !== contextKey ||
        (revision && revision.authorityKey !== invalidated.authorityKey)
      ) {
        invalidated = null;
        incident = null;
        return true;
      }
      if (revision && revision.checkedAtMs > invalidated.checkedAtMs) {
        if (incident?.retried) {
          return false;
        }
        if (incident) {
          incident.retried = true;
        }
        invalidated = null;
        return true;
      }
      return false;
    },
  };
}
