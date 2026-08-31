"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  effectiveSubscriptionAuthority,
  type SubscriptionAuthority,
} from "@/lib/subscription-authority";
import { scheduleSubscriptionAuthorityExpiry } from "@/lib/subscription-authority-expiry";
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
  const refreshedBoundaryRef = useRef<string | null>(null);
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
  const serverAuthority = effectiveSubscriptionAuthority(authority, userId);
  const authorityKey =
    serverAuthority.isSubscriber && userId && serverAuthority.subscribedUntil
      ? `${userId}:${serverAuthority.subscribedUntil}`
      : null;
  const [expiredAuthorityKey, setExpiredAuthorityKey] = useState<string | null>(
    null
  );
  const boundaryPending =
    authorityKey !== null && expiredAuthorityKey === authorityKey;
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
    if (!(authorityKey && serverAuthority.subscribedUntil)) {
      return;
    }
    const boundary = Date.parse(serverAuthority.subscribedUntil);
    return scheduleSubscriptionAuthorityExpiry(boundary, () => {
      setExpiredAuthorityKey(authorityKey);
    });
  }, [authorityKey, serverAuthority.subscribedUntil]);

  // Refresh separately so every consumer renders the closed gate first.
  useEffect(() => {
    if (
      !boundaryPending ||
      !authorityKey ||
      refreshedBoundaryRef.current === authorityKey
    ) {
      return;
    }
    refreshedBoundaryRef.current = authorityKey;
    router.refresh();
  }, [authorityKey, boundaryPending, router]);

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
