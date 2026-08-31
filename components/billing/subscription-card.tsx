"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useApplicationLoginPath } from "@/hooks/use-application-login-path";
import { browserApplicationPath } from "@/lib/application-path";
import { parseRetryAfter } from "@/lib/http/retry-after";

const MAX_CONFIRMATION_ATTEMPTS = 15;
const CONFIRMATION_INTERVAL_MS = 1000;
const CONFIRMATION_FOREGROUND_BUDGET_MS = 15_000;
const ALLOWANCE_MARKERS = Array.from(
  { length: 15 },
  (_, index) => `allowance-${index + 1}`
);

type CheckoutResult = "cancelled" | "success" | null;

export type SubscriptionCardProps = {
  checkoutEnabled: boolean;
  checkoutResult?: CheckoutResult;
  isSubscriber: boolean;
  onCheckoutConfirmed?: () => void;
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
  checkoutEnabled,
  checkoutResult = null,
  isSubscriber,
  onCheckoutConfirmed,
}: SubscriptionCardProps) {
  const titleId = useId();
  const session = useSession();
  const loginPath = useApplicationLoginPath();
  const userId = session.data?.user?.id ?? null;
  const checkoutUserId =
    session.status === "authenticated" ? (session.data.user?.id ?? null) : null;
  const updateSessionRef = useRef(session.update);
  updateSessionRef.current = session.update;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const checkoutUserIdRef = useRef(checkoutUserId);
  checkoutUserIdRef.current = checkoutUserId;

  const [activeConfirmed, setActiveConfirmed] = useState(false);
  const [paidThrough, setPaidThrough] = useState<Date | null>(null);
  const [notice, setNotice] = useState<Notice | null>(() =>
    initialNotice(checkoutResult, isSubscriber)
  );
  const [focusRevision, setFocusRevision] = useState(0);
  const [canCheckAgain, setCanCheckAgain] = useState(false);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [checkoutSuppressed, setCheckoutSuppressed] = useState(false);
  const [checkoutPending, setCheckoutPending] = useState(false);

  const noticeRef = useRef<HTMLDivElement>(null);
  const checkoutAttemptRef = useRef<CheckoutAttempt | null>(null);
  const checkoutGenerationRef = useRef(0);
  const checkoutKeyRef = useRef<CheckoutKey | null>(null);
  const pollAbortRef = useRef<AbortController | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollGenerationRef = useRef(0);
  const confirmationOwnerRef = useRef<string | null>(null);
  const authorityRef = useRef({ isSubscriber, userId });
  const checkoutIdentityRef = useRef(checkoutUserId);

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

  const stopPolling = useCallback(() => {
    pollGenerationRef.current += 1;
    pollAbortRef.current?.abort();
    pollAbortRef.current = null;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const previous = authorityRef.current;
    authorityRef.current = { isSubscriber, userId };
    if (previous.userId === userId && previous.isSubscriber === isSubscriber) {
      return;
    }

    const identityChanged = previous.userId !== userId;
    if (identityChanged) {
      stopPolling();
    }
    setActiveConfirmed(false);
    setPaidThrough(null);
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
    } else {
      setNotice(initialNotice(checkoutResult, isSubscriber));
    }
  }, [checkoutResult, isSubscriber, publishNotice, stopPolling, userId]);

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
    const startedAt = Date.now();
    let attempts = 0;

    setActiveConfirmed(false);
    setPaidThrough(null);
    setCanCheckAgain(false);
    setNeedsSignIn(false);
    publishNotice(CONFIRMING_NOTICE);

    const isCurrent = () =>
      pollGenerationRef.current === generation &&
      userIdRef.current === confirmationUserId;

    const finishForRetry = (next: Notice) => {
      if (!isCurrent()) {
        return;
      }
      setCanCheckAgain(true);
      publishNotice(next, { focus: true });
    };

    const scheduleNext = (
      next: Notice,
      delay: number = CONFIRMATION_INTERVAL_MS
    ) => {
      if (!isCurrent()) {
        return;
      }
      if (
        attempts >= MAX_CONFIRMATION_ATTEMPTS ||
        Date.now() + delay - startedAt > CONFIRMATION_FOREGROUND_BUDGET_MS
      ) {
        finishForRetry({
          detail:
            "Account access will update after Stripe records the payment. You can check the same account again.",
          title: "Payment may still be processing.",
          tone: "neutral",
        });
        return;
      }
      publishNotice(next);
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        check().catch(() => {
          finishForRetry({
            detail: "No account access was changed. Check again.",
            title: "Subscription status could not be checked.",
            tone: "error",
          });
        });
      }, delay);
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
        publishNotice(
          {
            detail: retryGuidance,
            title: "Payment status is temporarily rate limited.",
            tone: "neutral",
          },
          { focus: true }
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
      if (Date.now() + delay - startedAt <= CONFIRMATION_FOREGROUND_BUDGET_MS) {
        scheduleNext(rateLimitNotice, delay);
        return;
      }

      setCanCheckAgain(false);
      publishNotice(rateLimitNotice);
      pollTimerRef.current = setTimeout(() => {
        pollTimerRef.current = null;
        if (!isCurrent()) {
          return;
        }
        finishForRetry({
          detail: "The same account can be checked again now.",
          title: "Payment may still be processing.",
          tone: "neutral",
        });
      }, delay);
    };

    const check = async (): Promise<void> => {
      if (!isCurrent()) {
        return;
      }
      attempts += 1;
      const controller = new AbortController();
      pollAbortRef.current = controller;

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
          (error instanceof DOMException && error.name === "AbortError") ||
          !isCurrent()
        ) {
          return;
        }
        scheduleNext({
          detail: "The next check will use the same account.",
          title: "Payment status could not be reached. Trying again…",
          tone: "pending",
        });
        return;
      }

      if (!isCurrent()) {
        return;
      }
      pollAbortRef.current = null;

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
      } catch {
        decoded = null;
      }
      if (!isCurrent()) {
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
      publishNotice({
        detail: "Refreshing this signed-in account before access changes.",
        title: "Refreshing account access",
        tone: "pending",
      });

      let refreshed: Awaited<ReturnType<typeof session.update>>;
      try {
        refreshed = await updateSessionRef.current({
          refreshSubscription: true,
        });
      } catch {
        if (!isCurrent()) {
          return;
        }
        scheduleNext({
          detail:
            "The paid status is recorded. Account access will be checked again.",
          title: "Refreshing account access",
          tone: "pending",
        });
        return;
      }
      if (!isCurrent()) {
        return;
      }
      if (refreshed?.user?.type !== "subscriber") {
        scheduleNext({
          detail:
            "The paid status is recorded. Account access will be checked again.",
          title: "Refreshing account access",
          tone: "pending",
        });
        return;
      }

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
    };

    check().catch(() => {
      finishForRetry({
        detail: "No account access was changed. Check again.",
        title: "Subscription status could not be checked.",
        tone: "error",
      });
    });
  }, [onCheckoutConfirmed, publishNotice, stopPolling, userId]);

  useEffect(() => {
    if (checkoutResult !== "success") {
      confirmationOwnerRef.current = null;
      return;
    }
    if (!userId) {
      return;
    }
    if (confirmationOwnerRef.current === null) {
      confirmationOwnerRef.current = userId;
    }
    if (confirmationOwnerRef.current !== userId) {
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
  }, [checkoutResult, publishNotice, startConfirmation, stopPolling, userId]);

  useEffect(() => {
    if (
      !(
        isSubscriber &&
        checkoutResult !== "success" &&
        userId &&
        !activeConfirmed
      )
    ) {
      return;
    }
    const controller = new AbortController();
    setActiveConfirmed(false);
    setPaidThrough(null);
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
  }, [activeConfirmed, checkoutResult, isSubscriber, publishNotice, userId]);

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

  if (!(checkoutEnabled || isSubscriber || checkoutResult === "success")) {
    return null;
  }

  const formattedPaidThrough = paidThrough
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "long",
      }).format(paidThrough)
    : null;
  const confirmationInFlight = checkoutResult === "success" && !activeConfirmed;
  const showCheckoutAction =
    checkoutEnabled &&
    !isSubscriber &&
    !activeConfirmed &&
    !confirmationInFlight &&
    !checkoutSuppressed;

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
          One subscription provides 750 runs each month. A run is counted when
          an agent starts.
        </p>
      </div>

      <div
        aria-label="Monthly allowance: 750 agent runs"
        className="oc-subscription-ledger"
        role="img"
      >
        <div className="oc-subscription-ledger__heading">
          <span>Run allowance</span>
          <span>Monthly</span>
        </div>
        <div className="oc-subscription-ledger__value">
          <strong>750</strong>
          <span>runs</span>
        </div>
        <div aria-hidden="true" className="oc-subscription-ledger__ticks">
          {ALLOWANCE_MARKERS.map((marker) => (
            <span key={marker} />
          ))}
        </div>
      </div>

      {activeConfirmed && formattedPaidThrough && paidThrough ? (
        <div className="oc-subscription-paid-through">
          <span>Paid through</span>
          <time dateTime={paidThrough.toISOString()}>
            {formattedPaidThrough}
          </time>
        </div>
      ) : null}

      {!isSubscriber && !activeConfirmed ? (
        <p className="oc-subscription-card__provider-note">
          Stripe shows the configured amount before purchase. OpenCoven does not
          display or infer the amount here.
        </p>
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
          {needsSignIn ? (
            <Link className="oc-subscription-action" href={loginPath}>
              Sign in again
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
