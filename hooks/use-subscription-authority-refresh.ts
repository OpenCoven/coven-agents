"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { scheduleSubscriptionAuthorityExpiry } from "@/lib/subscription-authority-expiry";

type SessionAuthorityIdentity = {
  enabled?: boolean;
  isSubscriber: boolean;
  status: "authenticated" | "loading" | "unauthenticated";
  subscribedUntil: string | null;
  type: string | null | undefined;
  userId: string | null | undefined;
};

export function useSubscriptionAuthorityRefresh({
  enabled = true,
  isSubscriber,
  status,
  subscribedUntil,
  type,
  userId,
}: SessionAuthorityIdentity): boolean {
  const router = useRouter();
  const previousIdentityRef = useRef<string | null>(null);
  const hasResolvedIdentityRef = useRef(false);
  const refreshedBoundaryRef = useRef<string | null>(null);
  const authorityKey =
    isSubscriber && userId && subscribedUntil
      ? `${userId}:${subscribedUntil}`
      : null;
  const [expiredAuthorityKey, setExpiredAuthorityKey] = useState<string | null>(
    null
  );
  const authorityPending =
    authorityKey !== null && expiredAuthorityKey === authorityKey;

  useEffect(() => {
    if (status === "loading") {
      return;
    }
    const identity = `${status}:${userId ?? ""}:${type ?? ""}`;
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
  }, [enabled, router, status, type, userId]);

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
      !authorityPending ||
      !authorityKey ||
      refreshedBoundaryRef.current === authorityKey
    ) {
      return;
    }
    refreshedBoundaryRef.current = authorityKey;
    router.refresh();
  }, [authorityKey, authorityPending, router]);

  return authorityPending;
}
