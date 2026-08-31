"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SubscriptionAuthority } from "@/lib/subscription-authority";
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
  isSubscriber: boolean;
  status: "authenticated" | "loading" | "unauthenticated";
  subscribedUntil: string | null;
  type: string | null | undefined;
  userId: string | null | undefined;
};

type SubscriptionAuthorityRefreshState = Readonly<{
  authorityPending: boolean;
  authorityRevision: string | null;
  invalidateAndRefresh: () => void;
}>;

export function useSubscriptionAuthorityRefresh({
  authority,
  authVersion,
  enabled = true,
  isSubscriber,
  status,
  subscribedUntil,
  type,
  userId,
}: SessionAuthorityIdentity): SubscriptionAuthorityRefreshState {
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
  const authorityKey =
    isSubscriber && userId && subscribedUntil
      ? `${userId}:${subscribedUntil}`
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
    if (!authorityKey || !subscribedUntil) {
      return;
    }
    const boundary = Date.parse(subscribedUntil);
    if (!Number.isFinite(boundary)) {
      setExpiredAuthorityKey(authorityKey);
      return;
    }
    return scheduleSubscriptionAuthorityExpiry(boundary, () => {
      setExpiredAuthorityKey(authorityKey);
    });
  }, [authorityKey, subscribedUntil]);

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
  };
}
