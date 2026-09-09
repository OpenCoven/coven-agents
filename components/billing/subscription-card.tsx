"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { UsageLedger } from "@/components/billing/usage-ledger";
import { useApplicationLoginPath } from "@/hooks/use-application-login-path";
import { browserApplicationPath } from "@/lib/application-path";
import {
  MONTHLY_MINUTE_CAP,
  RUN_MINUTE_RESERVATION,
} from "@/lib/billing/limits";
import { CLOUD_PILOT_PLAN } from "@/lib/billing/pilot-plan";
import { parseRetryAfter } from "@/lib/http/retry-after";

const MAX_CONFIRMATION_ATTEMPTS = 15;
const CONFIRMATION_INTERVAL_MS = 1000;
const CONFIRMATION_FOREGROUND_BUDGET_MS = 15_000;
type CheckoutResult = "cancelled" | "success" | null;
export type MinutePackResult = "added" | "cancelled" | null;
export type BillingReturn = "managed" | null;
export type MinutePackOffer = { minutes: number; priceId: string };

export type SubscriptionCardProps = {
  checkoutEnabled: boolean;
  checkoutResult?: CheckoutResult;
  confirmationOwner?: string | null;
  isSubscriber: boolean;
  /** Top-up packs on offer, smallest first. Empty hides the section. */
  /** Set when the viewer has just come back from Stripe's billing portal. */
  billingReturn?: BillingReturn;
  minutePacks?: readonly MinutePackOffer[];
  minutePackResult?: MinutePackResult;
  onCheckoutConfirmed?: () => void;
  onConfirmationOwnerEstablished?: (userId: string) => void;
  subscribedUntil?: string | null;
};

type Notice = {
  detail: string;
  title: string;
  tone: "error" | "neutral" | "pending" | "success";
};

type SubscriptionStatusBody = {
  active: boolean;
  checkoutEnabled: boolean;
  subscribedUntil: string | null;
};

type CheckoutAttempt = {
  controller: AbortController;
  generation: number;
  idempotencyKey: string;
  userId: string;
};

type CheckoutKey = {
  idempotencyKey: string;
  userId: string;
};

const CANCELLED_NOTICE: Notice = {
  detail: "You can return to secure checkout whenever you are ready.",
  title: "Checkout cancelled. No payment was taken.",
  tone: "neutral",
};

const CONFIRMING_NOTICE: Notice = {
  detail:
    "Account access stays unchanged until the payment is recorded on this account.",
  title: "Confirming payment",
  tone: "pending",
};

const PROCESSING_NOTICE: Notice = {
  detail:
    "Account access will update after Stripe records the payment. You can check the same account again.",
  title: "Payment may still be processing.",
  tone: "neutral",
};

function initialNotice(
  checkoutResult: CheckoutResult,
  isSubscriber: boolean
): Notice | null {
  if (checkoutResult === "success") {
    return CONFIRMING_NOTICE;
  }
  if (checkoutResult === "cancelled") {
    return CANCELLED_NOTICE;
  }
  if (isSubscriber) {
    return {
      detail: "Reading the current paid-through date from your account.",
      title: "Checking subscription",
      tone: "pending",
    };
  }
  return null;
}

function parseSubscriptionStatus(
  value: unknown
): SubscriptionStatusBody | null {
  if (!(value && typeof value === "object")) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.active !== "boolean" ||
    typeof candidate.checkoutEnabled !== "boolean" ||
    !(
      candidate.subscribedUntil === null ||
      typeof candidate.subscribedUntil === "string"
    )
  ) {
    return null;
  }
  return {
    active: candidate.active,
    checkoutEnabled: candidate.checkoutEnabled,
    subscribedUntil: candidate.subscribedUntil,
  };
}

function paidThroughDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function checkoutError(value: unknown): string | null {
  if (!(value && typeof value === "object")) {
    return null;
  }
  const { error } = value as Record<string, unknown>;
  return typeof error === "string" ? error : null;
}

function secureCheckoutDestination(
  value: unknown
): { kind: "missing" } | { kind: "unsafe" } | { href: string; kind: "valid" } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { kind: "missing" };
  }
  try {
    const destination = new URL(value);
    return destination.protocol === "https:"
      ? { href: destination.href, kind: "valid" }
      : { kind: "unsafe" };
  } catch {
    return { kind: "unsafe" };
  }
}

function responseBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function retryTime(retryAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(retryAt);
}

export function SubscriptionCard({
  billingReturn = null,
  checkoutEnabled,
  checkoutResult = null,
  confirmationOwner,
  isSubscriber,
  minutePacks = [],
  minutePackResult = null,
  onCheckoutConfirmed,
  onConfirmationOwnerEstablished,
  subscribedUntil = null,
}: SubscriptionCardProps) {
  const titleId = useId();
  const router = useRouter();
  const session = useSession();
  const loginPath = useApplicationLoginPath();
  const userId = session.data?.user?.id ?? null;
  const checkoutUserId =
    session.status === "authenticated" ? (session.data.user?.id ?? null) : null;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const checkoutUserIdRef = useRef(checkoutUserId);
  checkoutUserIdRef.current = checkoutUserId;

  const [activeConfirmed, setActiveConfirmed] = useState(isSubscriber);
  const [paidThrough, setPaidThrough] = useState<Date | null>(() =>
    isSubscriber ? paidThroughDate(subscribedUntil) : null
  );
  const [notice, setNotice] = useState<Notice | null>(() =>
    initialNotice(checkoutResult, isSubscriber)
  );
  const [focusRevision, setFocusRevision] = useState(0);
  const [canCheckAgain, setCanCheckAgain] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [checkoutSuppressed, setCheckoutSuppressed] = useState(false);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [packPending, setPackPending] = useState<string | null>(null);
  const [packCredited, setPackCredited] = useState(false);
  const [portalPending, setPortalPending] = useState(false);
  const markPackCredited = useCallback(() => setPackCredited(true), []);

  const noticeRef = useRef<HTMLDivElement>(null);
  const checkoutAttemptRef = useRef<CheckoutAttempt | null>(null);
  const checkoutGenerationRef = useRef(0);
  const checkoutKeyRef = useRef<CheckoutKey | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollDeadlineTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshRequestedGenerationRef = useRef<number | null>(null);
  const pollGenerationRef = useRef(0);
  const internalConfirmationOwnerRef = useRef<string | null>(null);
  const authorityRef = useRef({ isSubscriber, subscribedUntil, userId });
  const checkoutIdentityRef = useRef(checkoutUserId);
  const portalAbortRef = useRef<AbortController | null>(null);
  const portalIdentity = `${checkoutUserId ?? ""}:${session.data?.user?.authVersion ?? ""}`;
  const portalIdentityRef = useRef(portalIdentity);
  portalIdentityRef.current = portalIdentity;

  useEffect(() => {
    if (portalIdentityRef.current === portalIdentity) {
      setPortalPending(false);
    }
    return () => {
      portalAbortRef.current?.abort();
      portalAbortRef.current = null;
    };
  }, [portalIdentity]);

  const publishNotice = useCallback(
    (next: Notice, options: { focus?: boolean } = {}) => {
      setNotice(next);
      if (options.focus) {
        setFocusRevision((current) => current + 1);
      }
    },
    []
  );

  useEffect(() => {
    if (focusRevision > 0) {
      noticeRef.current?.focus();
    }
  }, [focusRevision]);

  useEffect(() => {
    if (checkoutResult !== "cancelled") {
      return;
    }
    const url = new URL(window.location.href);
    if (url.searchParams.get("checkout") !== "cancelled") {
      return;
    }
    url.searchParams.delete("checkout");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [checkoutResult]);

  const stopPolling = useCallback(() => {
    pollGenerationRef.current += 1;
    refreshRequestedGenerationRef.current = null;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    if (pollDeadlineTimerRef.current) {
      clearTimeout(pollDeadlineTimerRef.current);
      pollDeadlineTimerRef.current = null;
    }
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const finishActivation = useCallback(
    (activationUserId: string, paidUntil: Date) => {
      if (
        userIdRef.current !== activationUserId ||
        !authorityRef.current.isSubscriber ||
        authorityRef.current.userId !== activationUserId
      ) {
        return;
      }
      stopPolling();
      setCanCheckAgain(false);
      setNeedsSignIn(false);
      setPaidThrough(paidUntil);
      setActiveConfirmed(true);
      publishNotice({
        detail: "Subscriber access is ready on this account.",
        title: "Subscription active",
        tone: "success",
      });
      const url = new URL(window.location.href);
      if (url.searchParams.get("checkout") === "success") {
        url.searchParams.delete("checkout");
        window.history.replaceState(
          window.history.state,
          "",
          `${url.pathname}${url.search}${url.hash}`
        );
      }
      onCheckoutConfirmed?.();
    },
    [onCheckoutConfirmed, publishNotice, stopPolling]
  );

  useEffect(() => {
    const previous = authorityRef.current;
    authorityRef.current = { isSubscriber, subscribedUntil, userId };

    const identityChanged = previous.userId !== userId;
    if (identityChanged) {
      stopPolling();
    }
    const authorityPaidThrough = isSubscriber
      ? paidThroughDate(subscribedUntil)
      : null;
    setActiveConfirmed(isSubscriber);
    setPaidThrough((current) =>
      isSubscriber ? (authorityPaidThrough ?? current) : null
    );
    setCanCheckAgain(false);
    setNeedsSignIn(false);
    setCheckoutSuppressed(false);
    if (
      identityChanged &&
      previous.userId !== null &&
      checkoutResult === "success"
    ) {
      publishNotice(
        {
          detail: "Return to the account that opened checkout to confirm it.",
          title: "The signed-in account changed.",
          tone: "error",
        },
        { focus: true }
      );
      return;
    }
    if (checkoutResult === "success") {
      setNotice((current) =>
        current?.tone === "success" ? CONFIRMING_NOTICE : current
      );
    } else if (isSubscriber) {
      setNotice((current) =>
        current?.tone === "success"
          ? current
          : authorityPaidThrough
            ? {
                detail: "Subscriber access is ready on this account.",
                title: "Subscription active",
                tone: "success",
              }
            : initialNotice(checkoutResult, isSubscriber)
      );
    } else {
      setNotice(initialNotice(checkoutResult, isSubscriber));
    }
  }, [
    checkoutResult,
    isSubscriber,
    publishNotice,
    stopPolling,
    subscribedUntil,
    userId,
  ]);

  useEffect(() => {
    const previousUserId = checkoutIdentityRef.current;
    checkoutIdentityRef.current = checkoutUserId;
    if (previousUserId === checkoutUserId) {
      return;
    }

    checkoutGenerationRef.current += 1;
    const attempt = checkoutAttemptRef.current;
    if (attempt && attempt.userId !== checkoutUserId) {
      attempt.controller.abort();
      if (checkoutAttemptRef.current === attempt) {
        checkoutAttemptRef.current = null;
        setCheckoutPending(false);
      }
    }
    if (checkoutKeyRef.current?.userId !== checkoutUserId) {
      checkoutKeyRef.current = null;
    }
    setCheckoutSuppressed(false);
  }, [checkoutUserId]);

  const startConfirmation = useCallback(() => {
    stopPolling();
    const generation = pollGenerationRef.current;
    const confirmationUserId = userId;
    const deadline = performance.now() + CONFIRMATION_FOREGROUND_BUDGET_MS;
    let attempts = 0;
    let deadlineFinished = false;

    const authoritativePaidThrough = paidThroughDate(
      authorityRef.current.subscribedUntil
    );
    if (
      confirmationUserId &&
      authorityRef.current.isSubscriber &&
      authoritativePaidThrough
    ) {
      finishActivation(confirmationUserId, authoritativePaidThrough);
      return;
    }

    setActiveConfirmed(authorityRef.current.isSubscriber);
    setPaidThrough(authoritativePaidThrough);
    setCanCheckAgain(false);
    setNeedsSignIn(false);
    publishNotice(CONFIRMING_NOTICE);

    const isCurrent = () =>
      pollGenerationRef.current === generation &&
      userIdRef.current === confirmationUserId;
    const remainingTime = () => Math.max(0, deadline - performance.now());

    const finishForRetry = (next: Notice) => {
      if (!isCurrent()) {
        return;
      }
      setCanCheckAgain(true);
      publishNotice(next, { focus: true });
    };

    const finishAtDeadline = () => {
      if (deadlineFinished || !isCurrent()) {
        return;
      }
      deadlineFinished = true;
      finishForRetry(PROCESSING_NOTICE);
    };

    const scheduleNext = (
      next: Notice,
      delay: number = CONFIRMATION_INTERVAL_MS
    ) => {
      if (!isCurrent()) {
        return;
      }
      const remaining = remainingTime();
      if (attempts >= MAX_CONFIRMATION_ATTEMPTS || remaining <= 0) {
        finishAtDeadline();
        return;
      }
      publishNotice(next);
      const boundedDelay = Math.min(delay, remaining);
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        if (boundedDelay >= remaining) {
          finishAtDeadline();
          return;
        }
        check().catch(() => {
          finishForRetry({
            detail: "No account access was changed. Check again.",
            title: "Subscription status could not be checked.",
            tone: "error",
          });
        });
      }, boundedDelay);
    };

    const waitForRateLimit = (response: Response) => {
      const retryAfter = parseRetryAfter(
        response.headers.get("retry-after"),
        Date.now()
      );
      if (retryAfter.kind === "excessive") {
        const retryGuidance =
          retryAfter.retryAt === null
            ? "Automatic checks stopped. Return later to check this account again."
            : `Automatic checks stopped. Check this account again after ${retryTime(retryAfter.retryAt)}.`;
        setCanCheckAgain(false);
        scheduleNext(
          {
            detail: retryGuidance,
            title: "Payment status is temporarily rate limited.",
            tone: "pending",
          },
          remainingTime()
        );
        return;
      }

      const retryAt =
        retryAfter.kind === "valid"
          ? retryAfter.retryAt
          : Date.now() + CONFIRMATION_INTERVAL_MS;
      const delay = Math.max(0, retryAt - Date.now());
      const rateLimitNotice: Notice = {
        detail: `The next account check is eligible after ${retryTime(retryAt)}.`,
        title: "Payment status is temporarily rate limited.",
        tone: "pending",
      };
      setCanCheckAgain(false);
      scheduleNext(rateLimitNotice, delay);
    };

    const check = async (): Promise<void> => {
      if (!isCurrent()) {
        return;
      }
      if (remainingTime() <= 0) {
        finishAtDeadline();
        return;
      }
      attempts += 1;
      const controller = new AbortController();
      pollAbortRef.current = controller;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      const operationRemaining = remainingTime();
      deadlineTimer = setTimeout(() => {
        if (pollDeadlineTimerRef.current === deadlineTimer) {
          pollDeadlineTimerRef.current = null;
        }
        controller.abort();
        finishAtDeadline();
      }, operationRemaining);
      pollDeadlineTimerRef.current = deadlineTimer;

      try {
        const response = await fetch(
          browserApplicationPath("/api/subscription"),
          {
            cache: "no-store",
            credentials: "same-origin",
            signal: controller.signal,
          }
        );

        if (!isCurrent()) {
          return;
        }
        if (remainingTime() <= 0) {
          finishAtDeadline();
          return;
        }
        if (response.status === 401) {
          setNeedsSignIn(true);
          finishForRetry({
            detail: "Sign in again to check the subscription on this account.",
            title: "Your sign-in changed before payment could be confirmed.",
            tone: "error",
          });
          setCanCheckAgain(false);
          return;
        }
        if (response.status === 429) {
          waitForRateLimit(response);
          return;
        }
        if (response.status >= 500) {
          scheduleNext({
            detail: "The account will be checked again in a moment.",
            title: "Payment status is temporarily unavailable.",
            tone: "pending",
          });
          return;
        }
        if (!response.ok) {
          finishForRetry({
            detail: "Check the same account again.",
            title: "Subscription status could not be checked.",
            tone: "error",
          });
          return;
        }

        let decoded: unknown;
        try {
          decoded = await response.json();
        } catch (error) {
          if (controller.signal.aborted || remainingTime() <= 0) {
            throw error;
          }
          decoded = null;
        }
        if (!isCurrent()) {
          return;
        }
        if (remainingTime() <= 0) {
          finishAtDeadline();
          return;
        }
        const status = parseSubscriptionStatus(decoded);
        if (!status) {
          finishForRetry({
            detail: "No account access was changed. Check again.",
            title: "The subscription status response was incomplete.",
            tone: "error",
          });
          return;
        }
        if (!status.active) {
          scheduleNext(CONFIRMING_NOTICE);
          return;
        }

        const paidUntil = paidThroughDate(status.subscribedUntil);
        if (!paidUntil) {
          finishForRetry({
            detail: "No account access was changed. Check again.",
            title: "The subscription status response was incomplete.",
            tone: "error",
          });
          return;
        }
        setPaidThrough(paidUntil);
        if (confirmationUserId && authorityRef.current.isSubscriber) {
          finishActivation(confirmationUserId, paidUntil);
          return;
        }
        if (!confirmationUserId) {
          return;
        }
        publishNotice({
          detail:
            "Payment is recorded. Loading subscriber access from this account.",
          title: "Finalizing subscription",
          tone: "pending",
        });
        if (refreshRequestedGenerationRef.current === generation) {
          return;
        }
        refreshRequestedGenerationRef.current = generation;
        router.refresh();
        pollTimerRef.current = setTimeout(finishAtDeadline, remainingTime());
      } catch (error) {
        if (!isCurrent()) {
          return;
        }
        if (
          deadlineFinished ||
          remainingTime() <= 0 ||
          controller.signal.aborted
        ) {
          finishAtDeadline();
          return;
        }
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        scheduleNext({
          detail: "The next check will use the same account.",
          title: "Payment status could not be reached. Trying again…",
          tone: "pending",
        });
      } finally {
        if (pollAbortRef.current === controller) {
          pollAbortRef.current = null;
        }
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          if (pollDeadlineTimerRef.current === deadlineTimer) {
            pollDeadlineTimerRef.current = null;
          }
        }
      }
    };

    check().catch(() => {
      finishForRetry({
        detail: "No account access was changed. Check again.",
        title: "Subscription status could not be checked.",
        tone: "error",
      });
    });
  }, [finishActivation, publishNotice, router, stopPolling, userId]);

  useEffect(() => {
    const generation = refreshRequestedGenerationRef.current;
    if (
      generation === null ||
      generation !== pollGenerationRef.current ||
      !userId ||
      !isSubscriber
    ) {
      return;
    }
    const owner =
      checkoutResult === "success"
        ? confirmationOwner === undefined
          ? internalConfirmationOwnerRef.current
          : confirmationOwner
        : userId;
    const activationPaidThrough =
      paidThroughDate(subscribedUntil) ?? paidThrough;
    if (owner === userId && activationPaidThrough) {
      finishActivation(userId, activationPaidThrough);
    }
  }, [
    checkoutResult,
    confirmationOwner,
    finishActivation,
    isSubscriber,
    paidThrough,
    subscribedUntil,
    userId,
  ]);

  useEffect(() => {
    if (checkoutResult !== "success") {
      internalConfirmationOwnerRef.current = null;
      return;
    }
    if (!userId) {
      return;
    }
    let owner =
      confirmationOwner === undefined
        ? internalConfirmationOwnerRef.current
        : confirmationOwner;
    if (owner === null) {
      if (confirmationOwner === undefined) {
        internalConfirmationOwnerRef.current = userId;
        owner = userId;
      } else {
        onConfirmationOwnerEstablished?.(userId);
        return;
      }
    }
    if (owner !== userId) {
      stopPolling();
      setCanCheckAgain(false);
      publishNotice(
        {
          detail: "Return to the account that opened checkout to confirm it.",
          title: "The signed-in account changed.",
          tone: "error",
        },
        { focus: true }
      );
      return;
    }
    const kickoff = setTimeout(startConfirmation, 0);
    return () => {
      clearTimeout(kickoff);
      stopPolling();
    };
  }, [
    checkoutResult,
    confirmationOwner,
    onConfirmationOwnerEstablished,
    publishNotice,
    startConfirmation,
    stopPolling,
    userId,
  ]);

  useEffect(() => {
    if (
      !(
        isSubscriber &&
        checkoutResult !== "success" &&
        userId &&
        !paidThroughDate(subscribedUntil) &&
        !paidThrough
      )
    ) {
      return;
    }
    const controller = new AbortController();
    setActiveConfirmed(true);
    publishNotice({
      detail: "Reading the current paid-through date from your account.",
      title: "Checking subscription",
      tone: "pending",
    });

    const read = async () => {
      let response: Response;
      try {
        response = await fetch(browserApplicationPath("/api/subscription"), {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
      } catch (error) {
        if (
          controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError")
        ) {
          return;
        }
        publishNotice(
          {
            detail: "Refresh this page to read the current paid-through date.",
            title: "Subscription status could not be reached.",
            tone: "error",
          },
          { focus: true }
        );
        return;
      }

      if (controller.signal.aborted) {
        return;
      }
      if (response.status === 401) {
        setNeedsSignIn(true);
        publishNotice(
          {
            detail: "Sign in again to read the subscription on this account.",
            title: "Your sign-in changed.",
            tone: "error",
          },
          { focus: true }
        );
        return;
      }
      if (response.status === 429) {
        publishNotice(
          {
            detail: "Refresh this page in a moment.",
            title: "Subscription status is temporarily rate limited.",
            tone: "error",
          },
          { focus: true }
        );
        return;
      }
      if (!response.ok) {
        publishNotice(
          {
            detail: "Refresh this page to read the current paid-through date.",
            title: "Subscription status is temporarily unavailable.",
            tone: "error",
          },
          { focus: true }
        );
        return;
      }

      let decoded: unknown;
      try {
        decoded = await response.json();
      } catch {
        decoded = null;
      }
      if (controller.signal.aborted) {
        return;
      }
      const status = parseSubscriptionStatus(decoded);
      const paidUntil = status?.active
        ? paidThroughDate(status.subscribedUntil)
        : null;
      if (!(status?.active && paidUntil)) {
        publishNotice(
          {
            detail:
              "No purchase action is available while this signed-in session still has subscriber access.",
            title: status
              ? "Account access and billing status are out of sync."
              : "The subscription status response was incomplete.",
            tone: "error",
          },
          { focus: true }
        );
        return;
      }

      setPaidThrough(paidUntil);
      setActiveConfirmed(true);
      publishNotice({
        detail: "Subscriber access is ready on this account.",
        title: "Subscription active",
        tone: "success",
      });
    };

    const kickoff = setTimeout(() => {
      read().catch(() => {
        if (!controller.signal.aborted) {
          publishNotice(
            {
              detail:
                "Refresh this page to read the current paid-through date.",
              title: "Subscription status could not be checked.",
              tone: "error",
            },
            { focus: true }
          );
        }
      });
    }, 0);
    return () => {
      clearTimeout(kickoff);
      controller.abort();
    };
  }, [
    checkoutResult,
    isSubscriber,
    paidThrough,
    publishNotice,
    subscribedUntil,
    userId,
  ]);

  useEffect(
    () => () => {
      checkoutGenerationRef.current += 1;
      checkoutAttemptRef.current?.controller.abort();
      checkoutAttemptRef.current = null;
      checkoutKeyRef.current = null;
    },
    []
  );

  useEffect(
    () => () => {
      stopPolling();
    },
    [stopPolling]
  );

  /**
   * A top-up is a one-time payment, so unlike the subscription flow it needs
   * no idempotency key or confirmation polling: a duplicate session is
   * harmless, only a paid one credits, and the usage meter shows the credit.
   */
  const buyMinutePack = useCallback(
    async (pack: MinutePackOffer) => {
      if (packPending) {
        return;
      }
      setPackPending(pack.priceId);
      publishNotice({
        detail: "Stripe will show the amount before purchase.",
        title: `Opening secure checkout for ${pack.minutes} minutes`,
        tone: "pending",
      });
      let response: Response;
      try {
        response = await fetch(
          browserApplicationPath("/api/minute-packs/checkout"),
          {
            body: JSON.stringify({ priceId: pack.priceId }),
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            method: "POST",
          }
        );
      } catch {
        publishNotice(
          {
            detail: "Check your connection, then choose the pack again.",
            title: "Could not reach billing.",
            tone: "error",
          },
          { focus: true }
        );
        setPackPending(null);
        return;
      }
      let decoded: unknown;
      try {
        decoded = await response.json();
      } catch {
        decoded = null;
      }
      const body = responseBody(decoded);
      if (response.ok) {
        const destination = secureCheckoutDestination(body.url);
        if (destination.kind === "valid") {
          window.location.assign(destination.href);
          return;
        }
        publishNotice(
          {
            detail: "No navigation occurred. Choose the pack again.",
            title:
              destination.kind === "unsafe"
                ? "Checkout returned an unsafe destination."
                : "Checkout returned no secure destination.",
            tone: "error",
          },
          { focus: true }
        );
        setPackPending(null);
        return;
      }
      const error = checkoutError(body);
      publishNotice(
        {
          detail:
            error === "customer_required"
              ? "Top-ups are available on subscriptions purchased through Stripe."
              : error === "subscription_required"
                ? "An active subscription is needed before adding minutes."
                : "Try again in a moment.",
          title: "Could not open checkout for this pack.",
          tone: "error",
        },
        { focus: true }
      );
      setPackPending(null);
    },
    [packPending, publishNotice]
  );

  /**
   * Sends the subscriber to Stripe's hosted portal to cancel, change a card,
   * or read invoices. Everything that touches a payment method lives there,
   * so this app never sees one.
   */
  const openBillingPortal = useCallback(async () => {
    if (portalAbortRef.current || !checkoutUserIdRef.current) {
      return;
    }
    const controller = new AbortController();
    portalAbortRef.current = controller;
    const identity = portalIdentityRef.current;
    const isCurrent = () =>
      portalAbortRef.current === controller &&
      !controller.signal.aborted &&
      portalIdentityRef.current === identity;
    const finish = () => {
      if (isCurrent()) {
        portalAbortRef.current = null;
        setPortalPending(false);
      }
    };
    setPortalPending(true);
    let response: Response;
    try {
      response = await fetch(browserApplicationPath("/api/billing/portal"), {
        credentials: "same-origin",
        method: "POST",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(CONFIRMATION_FOREGROUND_BUDGET_MS),
        ]),
      });
    } catch {
      if (!isCurrent()) {
        return;
      }
      publishNotice(
        {
          detail: "Check your connection, then try again.",
          title: "Could not reach billing.",
          tone: "error",
        },
        { focus: true }
      );
      finish();
      return;
    }
    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      decoded = null;
    }
    if (!isCurrent()) {
      return;
    }
    const body = responseBody(decoded);
    if (response.ok) {
      const destination = secureCheckoutDestination(body.url);
      if (destination.kind === "valid") {
        window.location.assign(destination.href);
        return;
      }
    }
    const error = checkoutError(body);
    publishNotice(
      {
        detail:
          error === "customer_required"
            ? "This account has no Stripe billing record. Complimentary access does not create a subscription."
            : "Try again in a moment.",
        title: "Could not open the billing portal.",
        tone: "error",
      },
      { focus: true }
    );
    finish();
  }, [publishNotice]);

  const startBillingPortal = useCallback(() => {
    openBillingPortal().catch(() => undefined);
  }, [openBillingPortal]);

  const chooseMinutePack = useCallback(
    (event: { currentTarget: HTMLButtonElement }) => {
      const { priceId } = event.currentTarget.dataset;
      const pack = minutePacks.find((entry) => entry.priceId === priceId);
      if (pack) {
        buyMinutePack(pack).catch(() => undefined);
      }
    },
    [buyMinutePack, minutePacks]
  );

  const beginCheckout = useCallback(async () => {
    if (checkoutAttemptRef.current) {
      return;
    }
    const initiatingUserId = checkoutUserIdRef.current;
    if (!initiatingUserId) {
      return;
    }

    const controller = new AbortController();
    const existingKey = checkoutKeyRef.current;
    const idempotencyKey =
      existingKey?.userId === initiatingUserId
        ? existingKey.idempotencyKey
        : crypto.randomUUID();
    const attempt: CheckoutAttempt = {
      controller,
      generation: checkoutGenerationRef.current + 1,
      idempotencyKey,
      userId: initiatingUserId,
    };
    checkoutGenerationRef.current = attempt.generation;
    checkoutAttemptRef.current = attempt;

    const isCurrent = () =>
      checkoutAttemptRef.current === attempt &&
      !attempt.controller.signal.aborted &&
      checkoutGenerationRef.current === attempt.generation &&
      checkoutUserIdRef.current === attempt.userId;
    const mutate = (mutation: () => void): boolean => {
      if (!isCurrent()) {
        return false;
      }
      mutation();
      return true;
    };
    const finish = () => {
      mutate(() => {
        setCheckoutPending(false);
        checkoutAttemptRef.current = null;
      });
    };
    const clearKey = () => {
      mutate(() => {
        if (
          checkoutKeyRef.current?.userId === attempt.userId &&
          checkoutKeyRef.current.idempotencyKey === attempt.idempotencyKey
        ) {
          checkoutKeyRef.current = null;
        }
      });
    };
    const announce = (
      next: Notice,
      options: { focus?: boolean } = {}
    ): boolean => mutate(() => publishNotice(next, options));

    if (
      !mutate(() => {
        checkoutKeyRef.current = {
          idempotencyKey,
          userId: initiatingUserId,
        };
      })
    ) {
      controller.abort();
      return;
    }
    if (!mutate(() => setCheckoutPending(true))) {
      return;
    }
    mutate(() => setCanCheckAgain(false));
    mutate(() => setNeedsSignIn(false));
    announce({
      detail: "Stripe will show the configured amount before purchase.",
      title: "Opening secure checkout",
      tone: "pending",
    });

    let response: Response;
    try {
      response = await fetch(browserApplicationPath("/api/checkout"), {
        credentials: "same-origin",
        headers: { "idempotency-key": idempotencyKey },
        method: "POST",
        signal: controller.signal,
      });
    } catch (networkError) {
      if (
        controller.signal.aborted ||
        (networkError instanceof DOMException &&
          networkError.name === "AbortError")
      ) {
        return;
      }
      if (!isCurrent()) {
        return;
      }
      announce(
        {
          detail:
            "Check your connection, then use the same checkout action again.",
          title: "Could not reach billing.",
          tone: "error",
        },
        { focus: true }
      );
      finish();
      return;
    }
    if (!isCurrent()) {
      return;
    }

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      decoded = null;
    }
    if (!isCurrent()) {
      return;
    }
    const body = responseBody(decoded);

    if (response.ok) {
      const destination = secureCheckoutDestination(body.url);
      clearKey();
      if (destination.kind === "missing") {
        announce(
          {
            detail: "No navigation occurred. Use the checkout action again.",
            title: "Checkout returned no secure destination.",
            tone: "error",
          },
          { focus: true }
        );
        finish();
        return;
      }
      if (destination.kind === "unsafe") {
        announce(
          {
            detail: "Only an HTTPS checkout destination can be opened.",
            title: "Checkout returned an unsafe destination.",
            tone: "error",
          },
          { focus: true }
        );
        finish();
        return;
      }
      if (!isCurrent()) {
        return;
      }
      window.location.assign(destination.href);
      return;
    }

    const error = checkoutError(body);
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      error === "request_in_progress" ||
      error === "checkout_session_conflict";
    if (!retryable) {
      clearKey();
    }

    if (error === "subscriptions_unavailable") {
      mutate(() => setCheckoutSuppressed(true));
      announce(
        {
          detail: "No payment was started.",
          title: "Subscriptions are not available right now.",
          tone: "neutral",
        },
        { focus: true }
      );
      finish();
      return;
    }
    if (error === "already_subscribed") {
      mutate(() => setCheckoutSuppressed(true));
      mutate(() => setCanCheckAgain(true));
      announce(
        {
          detail: "Check this account to load its current paid status.",
          title: "A subscription already exists for this account.",
          tone: "neutral",
        },
        { focus: true }
      );
      finish();
      return;
    }
    if (error === "billing_unavailable") {
      announce(
        {
          detail: "Use the same checkout action again in a moment.",
          title: "Billing is temporarily unavailable.",
          tone: "error",
        },
        { focus: true }
      );
      finish();
      return;
    }
    if (error === "request_in_progress") {
      announce(
        {
          detail: "Wait a moment, then use the same checkout action again.",
          title: "A checkout request is still processing.",
          tone: "neutral",
        },
        { focus: true }
      );
      finish();
      return;
    }
    if (error === "checkout_session_conflict") {
      announce(
        {
          detail: "Wait a moment, then use the same checkout action again.",
          title: "A previous checkout session is still settling.",
          tone: "neutral",
        },
        { focus: true }
      );
      finish();
      return;
    }
    if (response.status === 429) {
      announce(
        {
          detail: "Wait a moment, then use the same checkout action again.",
          title: "Checkout is temporarily rate limited.",
          tone: "neutral",
        },
        { focus: true }
      );
      finish();
      return;
    }
    if (response.status === 401) {
      mutate(() => setCheckoutSuppressed(true));
      mutate(() => setNeedsSignIn(true));
      announce(
        {
          detail: "Sign in again before opening checkout.",
          title: "Your sign-in changed.",
          tone: "error",
        },
        { focus: true }
      );
      finish();
      return;
    }
    if (response.status >= 500) {
      announce(
        {
          detail: "Use the same checkout action again.",
          title: "The checkout provider could not open a session.",
          tone: "error",
        },
        { focus: true }
      );
      finish();
      return;
    }

    announce(
      {
        detail: "No payment was started. Use the checkout action again.",
        title: "Checkout could not be started.",
        tone: "error",
      },
      { focus: true }
    );
    finish();
  }, [publishNotice]);

  const startCheckout = useCallback(() => {
    beginCheckout().catch(() => undefined);
  }, [beginCheckout]);

  if (
    !(
      checkoutEnabled ||
      isSubscriber ||
      checkoutResult === "success" ||
      billingReturn === "managed"
    )
  ) {
    return null;
  }

  const formattedPaidThrough = paidThrough
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "long",
      }).format(paidThrough)
    : null;
  const daysToRenewal = paidThrough
    ? Math.max(0, Math.ceil((paidThrough.getTime() - Date.now()) / 86_400_000))
    : null;
  const confirmationInFlight = checkoutResult === "success" && !activeConfirmed;
  const showCheckoutAction =
    checkoutEnabled &&
    !isSubscriber &&
    !activeConfirmed &&
    !confirmationInFlight &&
    !checkoutSuppressed;
  const showBillingPortal =
    checkoutUserId !== null &&
    (isSubscriber || activeConfirmed || billingReturn === "managed");
  const showMinutePacks =
    checkoutEnabled &&
    minutePacks.length > 0 &&
    (isSubscriber || activeConfirmed);

  return (
    <section
      aria-labelledby={titleId}
      className="oc-subscription-card"
      data-testid="subscription-card"
    >
      <div className="oc-subscription-card__copy">
        <p className="oc-subscription-card__eyebrow">Monthly contract</p>
        <h2 id={titleId}>Subscriber access</h2>
        <p>
          One subscription includes {MONTHLY_MINUTE_CAP} minutes of agent run
          time each month. Each run counts the minutes it actually runs, rounded
          up to the next minute; while a run is in progress, up to{" "}
          {RUN_MINUTE_RESERVATION} minutes are set aside and released when it
          ends.
        </p>
        <p>
          No automatic overage. Cloud capacity does not include model inference:
          bring your own supported harness credential and provider entitlement.
          Work remains limited to {CLOUD_PILOT_PLAN.maximumRunMinutes} minutes
          per run.
        </p>
        <p>
          Per-sandbox policy caps: {CLOUD_PILOT_PLAN.sandboxPolicy.caps.cpu}{" "}
          vCPU, {CLOUD_PILOT_PLAN.sandboxPolicy.caps.memory} GiB memory, and{" "}
          {CLOUD_PILOT_PLAN.sandboxPolicy.caps.disk} GiB disk. These are limits,
          not a guarantee of provisioned resources.
        </p>
      </div>

      <UsageLedger
        enabled={isSubscriber || activeConfirmed}
        onPackCredited={markPackCredited}
        variant="card"
        watchPackCredit={minutePackResult === "added"}
      />

      {activeConfirmed && formattedPaidThrough && paidThrough ? (
        <div className="oc-subscription-paid-through">
          <span>Paid through</span>
          <span>
            <time dateTime={paidThrough.toISOString()}>
              {formattedPaidThrough}
            </time>
            {daysToRenewal === null ? null : (
              <>
                {" "}
                <small>
                  {daysToRenewal === 0
                    ? "today"
                    : `in ${daysToRenewal} day${daysToRenewal === 1 ? "" : "s"}`}
                </small>
              </>
            )}
          </span>
        </div>
      ) : null}

      {!isSubscriber && !activeConfirmed ? (
        <p className="oc-subscription-card__provider-note">
          Stripe shows the configured amount before purchase. OpenCoven does not
          display or infer the amount here.
        </p>
      ) : null}

      {showMinutePacks ? (
        <div
          className="oc-subscription-offer"
          data-result={packCredited ? "credited" : (minutePackResult ?? "none")}
          data-testid="minute-packs"
        >
          <p className="oc-subscription-offer__eyebrow">Top up</p>
          {minutePacks.length === 1 && minutePacks[0] ? (
            <div className="oc-subscription-offer__figure">
              <strong>{minutePacks[0].minutes}</strong>
              <span>minutes · one-time</span>
            </div>
          ) : (
            <div className="oc-subscription-offer__figure">
              <strong>{minutePacks.length}</strong>
              <span>pack sizes · one-time</span>
            </div>
          )}
          <div className="oc-subscription-offer__actions">
            {minutePacks.map((pack) => (
              <button
                aria-busy={packPending === pack.priceId}
                className="oc-subscription-action"
                data-price-id={pack.priceId}
                disabled={packPending !== null}
                key={pack.priceId}
                onClick={chooseMinutePack}
                type="button"
              >
                {packPending === pack.priceId
                  ? "Opening secure checkout…"
                  : `Add ${pack.minutes} minutes`}
              </button>
            ))}
          </div>
          <p className="oc-subscription-offer__terms">
            Top-up minutes never expire and are used only after your monthly{" "}
            {MONTHLY_MINUTE_CAP}. Stripe shows the price before you pay.
          </p>
          {packCredited || minutePackResult ? (
            <p className="oc-subscription-offer__status" role="status">
              {packCredited
                ? "Minutes added. Your allowance above already includes them."
                : minutePackResult === "added"
                  ? "Payment received. Your minutes appear above as soon as Stripe records it, usually within a minute."
                  : "Top-up cancelled. Nothing was charged."}
            </p>
          ) : null}
        </div>
      ) : null}

      {notice ? (
        <div
          aria-atomic="true"
          aria-live="polite"
          className="oc-subscription-notice"
          data-tone={notice.tone}
          ref={noticeRef}
          role="status"
          tabIndex={-1}
        >
          <span aria-hidden="true" className="oc-subscription-notice__mark" />
          <div>
            <strong>{notice.title}</strong>
            <p>{notice.detail}</p>
          </div>
        </div>
      ) : null}

      {showBillingPortal ? (
        <div className="oc-subscription-manage">
          <p>
            Cancelling, changing a card, and invoice history are handled by
            Stripe.{" "}
            {billingReturn === "managed"
              ? "A change made there appears here once Stripe confirms it, which can take a moment."
              : "A cancellation keeps access until the paid-through date above."}
          </p>
          <button
            aria-busy={portalPending}
            className="oc-subscription-action"
            data-variant="quiet"
            disabled={portalPending}
            onClick={startBillingPortal}
            type="button"
          >
            {portalPending ? "Opening Stripe…" : "Manage subscription"}
          </button>
        </div>
      ) : null}

      {showCheckoutAction || canCheckAgain || needsSignIn ? (
        <div className="oc-subscription-card__actions">
          {showCheckoutAction ? (
            <button
              aria-busy={checkoutPending}
              className="oc-subscription-action"
              disabled={checkoutPending}
              onClick={startCheckout}
              type="button"
            >
              {checkoutPending
                ? "Opening secure checkout…"
                : "Continue to secure checkout"}
            </button>
          ) : null}
          {canCheckAgain ? (
            <button
              className="oc-subscription-action"
              onClick={startConfirmation}
              type="button"
            >
              Check again
            </button>
          ) : null}
          {needsSignIn && loginPath ? (
            <Link className="oc-subscription-action" href={loginPath}>
              Sign in again
            </Link>
          ) : needsSignIn ? (
            <button className="oc-subscription-action" disabled type="button">
              Sign in again
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
