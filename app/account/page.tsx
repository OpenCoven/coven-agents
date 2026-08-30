"use client";

import {
  ArrowLeftIcon,
  Database,
  Gauge,
  KeyRound,
  UserCircle,
} from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useState } from "react";
import { AvatarSettings } from "@/components/account/avatar-settings";
import { DeleteAllChats } from "@/components/account/delete-all-chats";
import { HarnessCredentials } from "@/components/account/harness-credentials";
import { UsageMeter } from "@/components/account/usage-meter";
import { AccountMenu } from "@/components/agents/account-menu";
import { BrandMark } from "@/components/brand/brand-mark";
import { cn } from "@/lib/utils";

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
  { icon: Database, id: "data", label: "Data" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Page() {
  const [tab, setTab] = useState<TabId>("copilot");
  const { data: session, status } = useSession();

  if (status === "loading") {
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
              href="/login"
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
          {/* The brand is the way home from every screen, this one included.
              The console header already works this way; a page where the mark
              was absent broke the habit the console teaches. `/` rather than
              `/agents`, so home stays whatever the root route decides it is. */}
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
          {session?.user?.email ? (
            <span className="hidden truncate text-[13px] text-muted-foreground sm:block">
              {session.user.email}
            </span>
          ) : null}
          <AccountMenu />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 w-full flex-col sm:flex-row">
          <nav
            aria-label="Account settings"
            className="flex w-full shrink-0 flex-row gap-1 overflow-x-auto border-border border-b px-3 py-3 sm:w-[200px] sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:px-4 sm:py-6"
          >
            <p className="hidden px-3 pb-2 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em] sm:block">
              Settings
            </p>

            {TABS.map((entry) => (
              <TabButton
                active={tab === entry.id}
                key={entry.id}
                onSelect={setTab}
                tab={entry}
              />
            ))}
          </nav>

          {/* Only the panel scrolls, so the navigation never moves and a tall
            section cannot push the page into a second scrollbar. */}
          <section className="min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-6">
            {tab === "copilot" ? <HarnessCredentials /> : null}
            {tab === "profile" ? <AvatarSettings /> : null}
            {tab === "usage" ? <UsageMeter /> : null}
            {tab === "data" ? <DeleteAllChats /> : null}
          </section>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onSelect,
  tab,
}: {
  active: boolean;
  onSelect: (id: TabId) => void;
  tab: (typeof TABS)[number];
}) {
  const Icon = tab.icon;

  // Bound here so the parent passes a stable reference and every tab does not
  // re-render when one is selected.
  const select = useCallback(() => {
    onSelect(tab.id);
  }, [onSelect, tab.id]);

  return (
    <button
      className={cn(
        "flex shrink-0 items-center gap-2.5 rounded-[8px] px-3 py-2 text-left text-[13px] transition-colors",
        active
          ? "bg-[var(--oc-accent-soft)] font-medium text-[var(--oc-accent)]"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      )}
      onClick={select}
      type="button"
    >
      <Icon className="size-4 shrink-0" />
      {tab.label}
    </button>
  );
}
