"use client";

import {
  ArrowLeftIcon,
  Database,
  Gauge,
  KeyRound,
  ReceiptText,
  UserCircle,
} from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AvatarSettings } from "@/components/account/avatar-settings";
import { DeleteAllChats } from "@/components/account/delete-all-chats";
import { HarnessCredentials } from "@/components/account/harness-credentials";
import { UsageMeter } from "@/components/account/usage-meter";
import { AccountMenu } from "@/components/agents/account-menu";
import { SubscriptionCard } from "@/components/billing/subscription-card";
import { BrandMark } from "@/components/brand/brand-mark";
import { useApplicationLoginPath } from "@/hooks/use-application-login-path";
import { useResponsiveTabOrientation } from "@/hooks/use-responsive-tab-orientation";
import { useSubscriptionAuthorityRefresh } from "@/hooks/use-subscription-authority-refresh";
import {
  effectiveSubscriptionAuthority,
  type SubscriptionAuthority,
} from "@/lib/subscription-authority";
import { cn } from "@/lib/utils";

type CheckoutResult = "cancelled" | "success" | null;

type AccountSettingsProps = {
  checkoutEnabled: boolean;
  checkoutResult?: CheckoutResult;
  subscriptionAuthority: SubscriptionAuthority;
};

/**
 * Account settings.
 *
 * Tabbed rather than a single column of stacked cards. Stacked, the page ran
 * well past the fold and the thing most people come here for -- connecting
 * Copilot -- sat third, below a password form that could not work.
 *
 * That password form is gone. Sign-in is GitHub-only, so no account has a
 * password to change; the form was the first thing on the page and implied
 * otherwise.
 *
 * The panel scrolls on its own rather than the page, so the navigation stays
 * put and nothing reflows when a section is taller than the viewport.
 */
const TABS = [
  { icon: KeyRound, id: "copilot", label: "Copilot" },
  { icon: UserCircle, id: "profile", label: "Profile" },
  { icon: Gauge, id: "usage", label: "Usage" },
  { icon: ReceiptText, id: "billing", label: "Billing" },
  { icon: Database, id: "data", label: "Data" },
] as const;

type Tab = (typeof TABS)[number];
type TabId = Tab["id"];
const HORIZONTAL_ACCOUNT_TABS_QUERY = "(max-width: 639px)";

function accountPanelId(tab: TabId): string {
  return `account-panel-${tab}`;
}

function accountTabId(tab: TabId): string {
  return `account-tab-${tab}`;
}

export function AccountSettings({
  checkoutEnabled,
  checkoutResult = null,
  subscriptionAuthority,
}: AccountSettingsProps) {
  const [effectiveCheckoutResult, setEffectiveCheckoutResult] =
    useState(checkoutResult);
  const [confirmationOwner, setConfirmationOwner] = useState<string | null>(
    null
  );
  const [tab, setTab] = useState<TabId>(() =>
    checkoutResult === "success" ||
    (checkoutResult === "cancelled" && checkoutEnabled)
      ? "billing"
      : "copilot"
  );
  const { data: session, status } = useSession();
  const loginPath = useApplicationLoginPath();
  const tabOrientation = useResponsiveTabOrientation(
    HORIZONTAL_ACCOUNT_TABS_QUERY
  );
  const serverAuthority = effectiveSubscriptionAuthority(
    subscriptionAuthority,
    session?.user?.id
  );
  const authorityPending = useSubscriptionAuthorityRefresh({
    enabled: effectiveCheckoutResult !== "success",
    isSubscriber: serverAuthority.isSubscriber,
    status,
    subscribedUntil: serverAuthority.subscribedUntil,
    type: session?.user?.type,
    userId: session?.user?.id,
  });
  const { isSubscriber, subscribedUntil } = effectiveSubscriptionAuthority(
    subscriptionAuthority,
    session?.user?.id,
    authorityPending
  );
  const showBilling =
    checkoutEnabled || isSubscriber || effectiveCheckoutResult === "success";
  const visibleTabs = TABS.filter(
    (entry) => entry.id !== "billing" || showBilling
  );
  const selectedTab = visibleTabs.some((entry) => entry.id === tab)
    ? tab
    : visibleTabs[0].id;
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const billingPanelRef = useRef<HTMLElement | null>(null);
  const removedBillingOwnedFocusRef = useRef(false);

  useEffect(() => {
    setEffectiveCheckoutResult(checkoutResult);
    if (checkoutResult !== "success") {
      setConfirmationOwner(null);
    }
  }, [checkoutResult]);

  useEffect(() => {
    if (tab === selectedTab) {
      return;
    }
    const shouldFocus =
      tab === "billing" && removedBillingOwnedFocusRef.current;
    removedBillingOwnedFocusRef.current = false;
    setTab(selectedTab);
    if (!shouldFocus) {
      return;
    }
    queueMicrotask(() => {
      tabRefs.current.get(selectedTab)?.focus();
    });
  }, [selectedTab, tab]);

  const captureRemovedBillingFocus = useCallback(
    (element: HTMLElement | null) => {
      const { activeElement } = document;
      if (
        element &&
        (activeElement === element ||
          (activeElement && element.contains(activeElement)))
      ) {
        removedBillingOwnedFocusRef.current = true;
      }
    },
    []
  );

  const registerTab = useCallback(
    (id: TabId, element: HTMLButtonElement | null) => {
      if (element) {
        if (id === "billing") {
          removedBillingOwnedFocusRef.current = false;
        }
        tabRefs.current.set(id, element);
      } else {
        if (id === "billing") {
          captureRemovedBillingFocus(tabRefs.current.get(id) ?? null);
        }
        tabRefs.current.delete(id);
      }
    },
    [captureRemovedBillingFocus]
  );

  const registerBillingPanel = useCallback(
    (element: HTMLElement | null) => {
      if (element) {
        billingPanelRef.current = element;
        return;
      }
      captureRemovedBillingFocus(billingPanelRef.current);
      billingPanelRef.current = null;
    },
    [captureRemovedBillingFocus]
  );

  const focusTab = useCallback((id: TabId) => {
    setTab(id);
    tabRefs.current.get(id)?.focus();
  }, []);

  const handleTabKeyDown = useCallback(
    (id: TabId, key: string) => {
      const index = visibleTabs.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return false;
      }
      let destination: TabId | null = null;
      const nextKey =
        tabOrientation === "horizontal" ? "ArrowRight" : "ArrowDown";
      const previousKey =
        tabOrientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
      if (key === nextKey) {
        destination = visibleTabs[(index + 1) % visibleTabs.length].id;
      } else if (key === previousKey) {
        destination =
          visibleTabs[(index - 1 + visibleTabs.length) % visibleTabs.length].id;
      } else if (key === "Home") {
        destination = visibleTabs[0].id;
      } else if (key === "End") {
        destination = visibleTabs.at(-1)?.id ?? null;
      }
      if (destination) {
        focusTab(destination);
        return true;
      }
      return false;
    },
    [focusTab, tabOrientation, visibleTabs]
  );

  const checkoutConfirmed = useCallback(() => {
    setEffectiveCheckoutResult(null);
    setConfirmationOwner(null);
  }, []);

  const establishConfirmationOwner = useCallback((ownerId: string) => {
    setConfirmationOwner((current) => current ?? ownerId);
  }, []);

  if (!session?.user && status === "loading") {
    return (
      <div
        aria-busy="true"
        className="h-dvh w-full bg-background"
        role="status"
      >
        <span className="sr-only">Loading account settings</span>
      </div>
    );
  }

  if (!session?.user) {
    return (
      <div className="flex h-dvh w-full flex-col overflow-hidden bg-background">
        <header className="flex shrink-0 items-center gap-4 border-border border-b px-4 py-4 sm:px-6">
          <Link
            aria-label="OpenCoven home"
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
            href="/"
          >
            <BrandMark className="size-4 text-[var(--oc-accent)]" />
            <span className="font-medium text-[13px] tracking-[-0.01em]">
              OpenCoven
            </span>
          </Link>
          <Link
            className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            href="/agents"
          >
            <ArrowLeftIcon className="size-3.5" />
            Back
          </Link>
        </header>
        <main className="flex flex-1 items-center justify-center px-5 py-10 text-center">
          <div className="max-w-[440px]">
            <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
              Account required
            </p>
            <h1 className="mt-3 font-semibold text-2xl tracking-tight">
              Sign in to manage your account
            </h1>
            <p className="mt-2 text-[13px] text-muted-foreground leading-relaxed">
              Harness credentials, usage, profile, and account data are
              available after GitHub sign-in.
            </p>
            <Link
              className="mt-5 inline-flex h-10 items-center rounded-[8px] bg-[var(--oc-accent)] px-4 font-medium text-[13px] text-white transition-opacity hover:opacity-90"
              href={loginPath}
            >
              Sign in with GitHub
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-border border-b px-6 py-4">
        <div className="flex items-center gap-4">
          <Link
            aria-label="OpenCoven home"
            className="flex items-center gap-2 transition-opacity hover:opacity-80"
            href="/"
          >
            <BrandMark className="size-4 text-[var(--oc-accent)]" />
            <span className="font-medium text-[13px] tracking-[-0.01em]">
              OpenCoven
            </span>
          </Link>
          <Link
            className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            href="/agents"
          >
            <ArrowLeftIcon className="size-3.5" />
            Back
          </Link>
        </div>

        <div className="flex items-center gap-3">
          {session.user.email ? (
            <span className="hidden truncate text-[13px] text-muted-foreground sm:block">
              {session.user.email}
            </span>
          ) : null}
          <AccountMenu isSubscriber={isSubscriber} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 w-full flex-col sm:flex-row">
          <nav
            aria-label="Account settings navigation"
            className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto border-border border-b px-3 py-3 sm:w-[200px] sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:px-4 sm:py-6"
          >
            <div
              aria-label="Account settings"
              aria-orientation={tabOrientation}
              className="contents"
              role="tablist"
            >
              <p className="hidden px-3 pb-2 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em] sm:block">
                Settings
              </p>

              {visibleTabs.map((entry) => (
                <TabButton
                  active={selectedTab === entry.id}
                  key={entry.id}
                  onKeyDown={handleTabKeyDown}
                  onSelect={setTab}
                  register={registerTab}
                  tab={entry}
                />
              ))}
            </div>
          </nav>

          {visibleTabs.map((entry) => {
            const active = selectedTab === entry.id;
            return (
              <section
                aria-labelledby={accountTabId(entry.id)}
                className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6"
                hidden={!active}
                id={accountPanelId(entry.id)}
                key={entry.id}
                ref={entry.id === "billing" ? registerBillingPanel : undefined}
                role="tabpanel"
              >
                {active && entry.id === "copilot" ? (
                  <HarnessCredentials />
                ) : null}
                {active && entry.id === "profile" ? <AvatarSettings /> : null}
                {active && entry.id === "usage" ? <UsageMeter /> : null}
                {entry.id === "billing" && showBilling ? (
                  <SubscriptionCard
                    checkoutEnabled={checkoutEnabled}
                    checkoutResult={effectiveCheckoutResult}
                    confirmationOwner={confirmationOwner}
                    isSubscriber={isSubscriber}
                    onCheckoutConfirmed={checkoutConfirmed}
                    onConfirmationOwnerEstablished={establishConfirmationOwner}
                    subscribedUntil={subscribedUntil}
                  />
                ) : null}
                {active && entry.id === "data" ? <DeleteAllChats /> : null}
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onKeyDown,
  onSelect,
  register,
  tab,
}: {
  active: boolean;
  onKeyDown: (id: TabId, key: string) => boolean;
  onSelect: (id: TabId) => void;
  register: (id: TabId, element: HTMLButtonElement | null) => void;
  tab: Tab;
}) {
  const Icon = tab.icon;

  const select = useCallback(() => {
    onSelect(tab.id);
  }, [onSelect, tab.id]);
  const keyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (onKeyDown(tab.id, event.key)) {
        event.preventDefault();
      }
    },
    [onKeyDown, tab.id]
  );
  const ref = useCallback(
    (element: HTMLButtonElement | null) => {
      register(tab.id, element);
    },
    [register, tab.id]
  );

  return (
    <button
      aria-controls={accountPanelId(tab.id)}
      aria-selected={active}
      className={cn(
        "oc-account-tab flex shrink-0 items-center gap-2.5 rounded-[8px] px-3 py-2 text-left text-[13px] transition-colors",
        active
          ? "bg-[var(--oc-accent-soft)] font-medium text-[var(--oc-accent)]"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      )}
      id={accountTabId(tab.id)}
      onClick={select}
      onKeyDown={keyDown}
      ref={ref}
      role="tab"
      tabIndex={active ? 0 : -1}
      type="button"
    >
      <Icon className="size-4 shrink-0" />
      {tab.label}
    </button>
  );
}
