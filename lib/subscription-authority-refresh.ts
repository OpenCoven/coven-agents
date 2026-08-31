import type { SubscriptionAuthority } from "./subscription-authority";

export type SubscriptionAuthorityRevision = Readonly<{
  authorityKey: string;
  checkedAt: string;
  contextKey: string;
  resolutionId: string;
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
  if (
    !Number.isFinite(checkedAtMs) ||
    typeof authority.resolutionId !== "string" ||
    authority.resolutionId.length === 0
  ) {
    return null;
  }
  return {
    authorityKey: JSON.stringify([
      authority.authVersion,
      authority.isSubscriber,
      authority.subscribedUntil,
    ]),
    checkedAt: authority.checkedAt,
    contextKey: subscriptionAuthorityRevisionContext(
      sessionUserId,
      authVersion
    ),
    resolutionId: authority.resolutionId,
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
        invalidated.resolutionId === revision.resolutionId
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
        revision.resolutionId !== invalidated.resolutionId
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
      return revision.resolutionId === invalidated.resolutionId;
    },
    reconcile: (revision, contextKey) => {
      if (
        incident &&
        (incident.contextKey !== contextKey ||
          (revision && revision.authorityKey !== incident.authorityKey))
      ) {
        incident = null;
      }
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
      if (revision && revision.resolutionId !== invalidated.resolutionId) {
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
