"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

type SessionAuthorityIdentity = {
  enabled?: boolean;
  status: "authenticated" | "loading" | "unauthenticated";
  type: string | null | undefined;
  userId: string | null | undefined;
};

export function useSubscriptionAuthorityRefresh({
  enabled = true,
  status,
  type,
  userId,
}: SessionAuthorityIdentity): void {
  const router = useRouter();
  const previousIdentityRef = useRef<string | null>(null);
  const hasResolvedIdentityRef = useRef(false);

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
}
