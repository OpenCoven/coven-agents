"use client";

import { ArrowLeftIcon, Database, Gauge, KeyRound } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useState } from "react";
import { DeleteAllChats } from "@/components/account/delete-all-chats";
import { HarnessCredentials } from "@/components/account/harness-credentials";
import { UsageMeter } from "@/components/account/usage-meter";
import { AccountMenu } from "@/components/agents/account-menu";
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
  { icon: Gauge, id: "usage", label: "Usage" },
  { icon: Database, id: "data", label: "Data" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Page() {
  const [tab, setTab] = useState<TabId>("copilot");
  const { data: session } = useSession();

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-border border-b px-6 py-4">
        <Link
          className="flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          href="/agents"
        >
          <ArrowLeftIcon className="size-3.5" />
          Back
        </Link>

        <div className="flex items-center gap-3">
          {session?.user?.email ? (
            <span className="hidden truncate text-[13px] text-muted-foreground sm:block">
              {session.user.email}
            </span>
          ) : null}
          <AccountMenu />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden px-6 py-8">
        {/* `m-auto` centres the block when the panel is short, so a two-field
            section sits in the optical centre instead of clinging to the top
            with a void beneath it. `max-h-full` keeps a tall one from
            overflowing the page rather than its own panel. */}
        <div className="m-auto flex max-h-full w-full max-w-[760px] gap-8">
          <nav className="flex w-[150px] shrink-0 flex-col gap-1">
            <p className="px-3 pb-2 font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
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
          <section className="min-w-0 flex-1 overflow-y-auto pr-1">
            {tab === "copilot" ? <HarnessCredentials /> : null}
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
        "flex items-center gap-2.5 rounded-[8px] px-3 py-2 text-left text-[13px] transition-colors",
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
