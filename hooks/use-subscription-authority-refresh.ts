"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  effectiveSubscriptionAuthority,
  type SubscriptionAuthority,
} from "@/lib/subscription-authority";
import {
  INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE,
  reduceSubscriptionAuthorityExpiry,
  scheduleSubscriptionAuthorityExpiry,
  subscriptionAuthorityBoundaryPending,
  subscriptionAuthorityBoundaryRefreshRequired,
  subscriptionAuthorityBoundaryRevision,
} from "@/lib/subscription-authority-expiry";
import {
  createSubscriptionAuthorityInvalidationFence,
  type SubscriptionAuthorityRevision,
  subscriptionAuthorityRevision,
  subscriptionAuthorityRevisionContext,
} from "@/lib/subscription-authority-refresh";

type SessionAuthorityIdentity = {
  authority: SubscriptionAuthority;
  authVersion: number | null | undefined;
  enabled?: boolean;
  status: "authenticated" | "loading" | "unauthenticated";
  type: string | null | undefined;
  userId: string | null | undefined;
};

type SubscriptionAuthorityState = Readonly<{
  authorityPending: boolean;
  authorityRevision: string | null;
  invalidateAndRefresh: () => void;
  isSubscriber: boolean;
  subscribedUntil: string | null;
}>;

export function useSubscriptionAuthorityRefresh({
  authority,
  authVersion,
  enabled = true,
  status,
  type,
  userId,
}: SessionAuthorityIdentity): SubscriptionAuthorityState {
  const router = useRouter();
  const previousIdentityRef = useRef<string | null>(null);
  const hasResolvedIdentityRef = useRef(false);
  const boundaryRequestRef = useRef<{
    observedKey: string | null;
    requestedKey: string | null;
  }>({
    observedKey: null,
    requestedKey: null,
  });
  const invalidationFence = useRef(
    createSubscriptionAuthorityInvalidationFence()
  ).current;
  const [manualInvalidation, setManualInvalidation] =
    useState<SubscriptionAuthorityRevision | null>(null);
  const revision = subscriptionAuthorityRevision(
    authority,
    userId,
    authVersion
  );
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const revisionContext = subscriptionAuthorityRevisionContext(
    userId,
    authVersion
  );
  const boundaryRevision = useMemo(
    () =>
      subscriptionAuthorityBoundaryRevision(
        {
          checkedAt: authority.checkedAt,
          subscribedUntil: authority.subscribedUntil,
          userId: authority.userId,
        },
        userId
      ),
    [authority.checkedAt, authority.subscribedUntil, authority.userId, userId]
  );
  const [expiryState, dispatchExpiry] = useReducer(
    reduceSubscriptionAuthorityExpiry,
    INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE
  );
  const boundaryPending = subscriptionAuthorityBoundaryPending(
    expiryState,
    boundaryRevision
  );
  const invalidationPending =
    manualInvalidation !== null &&
    invalidationFence.isPending(revision, revisionContext);
  const authorityPending = boundaryPending || invalidationPending;
  const effectiveAuthority = effectiveSubscriptionAuthority(
    authority,
    userId,
    authorityPending
  );

  useEffect(() => {
    if (status === "loading") {
      return;
    }
    const identity = `${status}:${userId ?? ""}:${type ?? ""}:${authVersion ?? ""}`;
    if (!hasResolvedIdentityRef.current) {
      hasResolvedIdentityRef.current = true;
      previousIdentityRef.current = identity;
      return;
    }
    if (previousIdentityRef.current === identity) {
      return;
    }
    previousIdentityRef.current = identity;
    if (enabled) {
      router.refresh();
    }
  }, [authVersion, enabled, router, status, type, userId]);

  useEffect(() => {
    dispatchExpiry({
      nowMs: Date.now(),
      revision: boundaryRevision,
      type: "reconcile",
    });
  }, [boundaryRevision]);

  useEffect(() => {
    if (!boundaryRevision) {
      return;
    }
    return scheduleSubscriptionAuthorityExpiry(
      boundaryRevision.boundaryMs,
      () => {
        dispatchExpiry({
          revision: boundaryRevision,
          type: "boundary",
        });
      }
    );
  }, [boundaryRevision]);

  // Refresh separately so every consumer renders the closed gate first.
  useEffect(() => {
    const revisionKey = boundaryRevision?.key ?? null;
    if (boundaryRequestRef.current.observedKey !== revisionKey) {
      boundaryRequestRef.current = {
        observedKey: revisionKey,
        requestedKey: null,
      };
    }
    if (
      !subscriptionAuthorityBoundaryRefreshRequired(
        expiryState,
        boundaryRevision
      ) ||
      !boundaryRevision ||
      boundaryRequestRef.current.requestedKey === boundaryRevision.key
    ) {
      return;
    }
    boundaryRequestRef.current.requestedKey = boundaryRevision.key;
    dispatchExpiry({
      revision: boundaryRevision,
      type: "refresh_requested",
    });
    router.refresh();
  }, [boundaryRevision, expiryState, router]);

  useEffect(() => {
    if (invalidationFence.reconcile(revision, revisionContext)) {
      setManualInvalidation(null);
    }
  }, [invalidationFence, revision, revisionContext]);

  const invalidateAndRefresh = useCallback(() => {
    const currentRevision = revisionRef.current;
    if (!currentRevision || !invalidationFence.invalidate(currentRevision)) {
      return;
    }
    setManualInvalidation(currentRevision);
    router.refresh();
  }, [invalidationFence, router]);

  return {
    authorityPending,
    authorityRevision: revision?.checkedAt ?? null,
    invalidateAndRefresh,
    ...effectiveAuthority,
  };
}
