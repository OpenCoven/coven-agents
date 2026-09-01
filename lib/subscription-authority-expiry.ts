import type { SubscriptionAuthority } from "./subscription-authority";

export const MAX_AUTHORITY_TIMEOUT_MS = 2_147_483_647;

export type SubscriptionAuthorityBoundaryRevision = Readonly<{
  boundaryMs: number;
  checkedAt: string;
  checkedAtMs: number;
  contextKey: string;
  key: string;
  subscribedUntil: string;
}>;

export type SubscriptionAuthorityExpiryState = Readonly<{
  current: SubscriptionAuthorityBoundaryRevision | null;
  pendingKey: string | null;
  refreshed: SubscriptionAuthorityBoundaryRevision | null;
  settledExpiredKey: string | null;
}>;

type SubscriptionAuthorityExpiryEvent =
  | Readonly<{
      nowMs: number;
      revision: SubscriptionAuthorityBoundaryRevision | null;
      type: "reconcile";
    }>
  | Readonly<{
      revision: SubscriptionAuthorityBoundaryRevision;
      type: "boundary" | "refresh_requested";
    }>;

export const INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE: SubscriptionAuthorityExpiryState =
  {
    current: null,
    pendingKey: null,
    refreshed: null,
    settledExpiredKey: null,
  };

type AuthorityExpiryClock = {
  clearTimeout: (timer: unknown) => void;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
};

const SYSTEM_CLOCK: AuthorityExpiryClock = {
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
};

function finiteTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function subscriptionAuthorityBoundaryRevision(
  authority: Pick<
    SubscriptionAuthority,
    "checkedAt" | "subscribedUntil" | "userId"
  > | null,
  sessionUserId: string | null | undefined
): SubscriptionAuthorityBoundaryRevision | null {
  if (!(sessionUserId && authority?.userId === sessionUserId)) {
    return null;
  }
  const checkedAtMs = finiteTimestamp(authority.checkedAt);
  const boundaryMs = finiteTimestamp(authority.subscribedUntil);
  if (checkedAtMs === null || boundaryMs === null) {
    return null;
  }
  const checkedAt = new Date(checkedAtMs).toISOString();
  const subscribedUntil = new Date(boundaryMs).toISOString();
  return {
    boundaryMs,
    checkedAt,
    checkedAtMs,
    contextKey: sessionUserId,
    key: `${sessionUserId}:${checkedAt}:${subscribedUntil}`,
    subscribedUntil,
  };
}

export function reduceSubscriptionAuthorityExpiry(
  state: SubscriptionAuthorityExpiryState,
  event: SubscriptionAuthorityExpiryEvent
): SubscriptionAuthorityExpiryState {
  if (event.type === "reconcile") {
    const { revision } = event;
    if (!revision) {
      return state.current === null
        ? state
        : INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE;
    }
    if (state.current?.key === revision.key) {
      return state;
    }

    const sameContext =
      state.current?.contextKey === revision.contextKey &&
      state.refreshed?.contextKey === revision.contextKey;
    const futureBoundary = revision.boundaryMs > event.nowMs;
    const newerExpiredResolution =
      !futureBoundary &&
      sameContext &&
      state.refreshed !== null &&
      revision.checkedAtMs > state.refreshed.checkedAtMs;

    return {
      current: revision,
      pendingKey: null,
      refreshed: futureBoundary
        ? null
        : newerExpiredResolution
          ? revision
          : sameContext
            ? state.refreshed
            : null,
      settledExpiredKey: newerExpiredResolution ? revision.key : null,
    };
  }

  if (state.current?.key !== event.revision.key) {
    return state;
  }

  if (event.type === "boundary") {
    if (
      state.pendingKey === event.revision.key ||
      state.settledExpiredKey === event.revision.key
    ) {
      return state;
    }
    return {
      ...state,
      pendingKey: event.revision.key,
    };
  }

  if (state.pendingKey !== event.revision.key) {
    return state;
  }
  return {
    ...state,
    refreshed: event.revision,
  };
}

export function subscriptionAuthorityBoundaryPending(
  state: SubscriptionAuthorityExpiryState,
  revision: SubscriptionAuthorityBoundaryRevision | null
): boolean {
  return revision !== null && state.pendingKey === revision.key;
}

export function subscriptionAuthorityBoundaryRefreshRequired(
  state: SubscriptionAuthorityExpiryState,
  revision: SubscriptionAuthorityBoundaryRevision | null
): boolean {
  return (
    subscriptionAuthorityBoundaryPending(state, revision) &&
    state.refreshed?.key !== revision?.key
  );
}

export function scheduleSubscriptionAuthorityExpiry(
  boundary: number,
  onBoundary: () => void,
  clock: AuthorityExpiryClock = SYSTEM_CLOCK
): () => void {
  let cancelled = false;
  let timer: unknown = null;

  const schedule = () => {
    if (cancelled) {
      return;
    }
    const remaining = boundary - clock.now();
    if (remaining <= 0) {
      onBoundary();
      return;
    }
    timer = clock.setTimeout(
      schedule,
      Math.min(remaining, MAX_AUTHORITY_TIMEOUT_MS)
    );
  };

  schedule();
  return () => {
    cancelled = true;
    if (timer !== null) {
      clock.clearTimeout(timer);
    }
  };
}
