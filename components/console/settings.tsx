// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import { HARNESS_SPECS } from "@opencoven/harness";
import Link from "next/link";
import { signOut } from "next-auth/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { SubscriptionCard } from "@/components/billing/subscription-card";
import { Btn, Caret, Eyebrow } from "@/components/console/primitives";
import {
  hairline,
  pill,
  tabular,
  truncate,
  type as type_,
  well,
} from "@/components/console/styles";
import { useResponsiveTabOrientation } from "@/hooks/use-responsive-tab-orientation";
import { browserApplicationPath } from "@/lib/application-path";
import { glyphFor } from "@/lib/console/format";
import {
  isSessionOperationCurrent,
  type SessionOperationContext,
} from "@/lib/console/session-operation";
import { createCredentialRefreshFence } from "@/lib/credentials/client";

/**
 * Settings, inside the console shell.
 *
 * Every panel reads the endpoint that actually enforces the thing it shows —
 * `/api/credentials` for what a run will be handed, `/api/usage` for the cap
 * the runner counts against — so the number displayed and the number enforced
 * cannot drift.
 */

type Tab = "account" | "billing" | "data" | "harness" | "usage";

const TABS: { id: Exclude<Tab, "billing">; label: string }[] = [
  { id: "harness", label: "Harness credentials" },
  { id: "usage", label: "Usage" },
  { id: "data", label: "Data" },
  { id: "account", label: "Account" },
];

const GUIDANCE: Record<string, string> = {
  claude: "A Claude Code OAuth token.",
  codex: "An OpenAI API key.",
  copilot:
    "A fine-grained PAT with the Copilot Requests permission, or an OAuth token from the Copilot CLI. Classic ghp_ tokens are not supported.",
};

const RUNNABLE = HARNESS_SPECS.filter((spec) => spec.supported);
const REFUSED = HARNESS_SPECS.filter((spec) => !spec.supported);

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const MS_PER_DAY = 86_400_000;
const HORIZONTAL_SETTINGS_QUERY = "(max-width: 720px)";

function settingsPanelId(tab: Tab): string {
  return `console-settings-panel-${tab}`;
}

function settingsTabId(tab: Tab): string {
  return `console-settings-tab-${tab}`;
}

type Usage = { cap: number; resetsAt: string | null; used: number };

const inputStyle: React.CSSProperties = {
  background: "var(--bg-sunken)",
  border: hairline,
  borderRadius: "var(--radius-control)",
  color: "var(--text-primary)",
  font: "400 12px/1.4 var(--font-mono)",
  outline: "none",
  padding: "9px 11px",
  width: "100%",
};

function Heading({ blurb, title }: { blurb: string; title: string }) {
  return (
    <div>
      <h2
        style={{
          color: "var(--text-primary)",
          font: "600 16px/1.3 var(--font-ui)",
          margin: "0 0 4px",
        }}
      >
        {title}
      </h2>
      <p style={type_.body}>{blurb}</p>
    </div>
  );
}

function HarnessCard({
  busy,
  configured,
  draft,
  harness,
  onDraft,
  onRemove,
  runnable,
}: {
  busy: boolean;
  configured: boolean;
  draft: string;
  harness: { id: string; label: string };
  onDraft: (id: string, value: string) => void;
  onRemove: (id: string) => void;
  runnable: boolean;
}) {
  return (
    <div
      style={{
        background: "var(--bg-raised)",
        border: hairline,
        borderRadius: "var(--radius-card)",
        opacity: runnable ? 1 : 0.72,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: hairline,
          display: "flex",
          gap: 9,
          padding: "12px 14px",
        }}
      >
        <span style={type_.title}>{harness.label}</span>
        <span
          style={pill(
            runnable ? (configured ? "success" : "muted") : "warning"
          )}
        >
          {runnable ? (configured ? "configured" : "not set") : "refused"}
        </span>
        <div style={{ flex: 1 }} />
        <span style={type_.meta}>{harness.id}</span>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 9,
          padding: "12px 14px",
        }}
      >
        {runnable ? (
          <>
            <input
              aria-label={`${harness.label} credential`}
              autoComplete="off"
              onChange={(event) => onDraft(harness.id, event.target.value)}
              placeholder={
                configured
                  ? "Paste a new token to replace the stored one"
                  : "Paste the token"
              }
              style={inputStyle}
              type="password"
              value={draft}
            />
            <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
              <p
                style={{
                  ...type_.body,
                  flex: 1,
                  font: "400 11px/1.5 var(--font-ui)",
                }}
              >
                {GUIDANCE[harness.id] ?? ""}
              </p>
              {configured ? (
                <Btn
                  disabled={busy}
                  onClick={() => onRemove(harness.id)}
                  size="xs"
                  variant="danger-ghost"
                >
                  Remove
                </Btn>
              ) : null}
            </div>
          </>
        ) : (
          <p style={{ ...type_.body, font: "400 11px/1.5 var(--font-ui)" }}>
            The runner refuses a run on this harness, so there is no slot to
            store a credential in. Storing one would look like a working setup
            and behave like a missing one.
          </p>
        )}
      </div>
    </div>
  );
}

export function Settings({
  account,
  checkoutEnabled,
  isSubscriber,
  onCredentialsChange,
  operationContext,
  subscribedUntil,
}: {
  /** The signed-in email, or null. Not a display string — the panel decides
   *  how to render "nobody", so a fallback sentence can never be mistaken for
   *  an account name or have an initial derived from it. */
  account: string | null;
  checkoutEnabled: boolean;
  isSubscriber: boolean;
  onCredentialsChange: (harnessIds: readonly string[]) => void;
  operationContext: SessionOperationContext | null;
  subscribedUntil: string | null;
}) {
  const [tab, setTab] = useState<Tab>("harness");
  const tabOrientation = useResponsiveTabOrientation(HORIZONTAL_SETTINGS_QUERY);
  const horizontalTabs = tabOrientation === "horizontal";
  const showBilling = checkoutEnabled || isSubscriber;
  const tabs: { id: Tab; label: string }[] = showBilling
    ? [
        ...TABS.slice(0, 2),
        { id: "billing", label: "Billing" },
        ...TABS.slice(2),
      ]
    : TABS;
  const selectedTab = tabs.some((entry) => entry.id === tab) ? tab : tabs[0].id;
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());
  const billingTabRef = useRef<HTMLButtonElement | null>(null);
  const billingPanelRef = useRef<HTMLDivElement | null>(null);
  const removedBillingOwnedFocusRef = useRef(false);

  const [configured, setConfigured] = useState<string[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusedOpen, setRefusedOpen] = useState(false);

  const [usage, setUsage] = useState<Usage | null>(null);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const refreshFence = useRef(createCredentialRefreshFence()).current;
  const operationContextRef = useRef(operationContext);
  operationContextRef.current = operationContext;

  const isCurrentOperation = useCallback(
    (context: SessionOperationContext | null) =>
      isSessionOperationCurrent(context, operationContextRef.current),
    []
  );

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

  const registerBillingTab = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        removedBillingOwnedFocusRef.current = false;
        billingTabRef.current = element;
        tabRefs.current.set("billing", element);
        return;
      }
      captureRemovedBillingFocus(billingTabRef.current);
      billingTabRef.current = null;
      tabRefs.current.delete("billing");
    },
    [captureRemovedBillingFocus]
  );

  const registerBillingPanel = useCallback(
    (element: HTMLDivElement | null) => {
      if (element) {
        billingPanelRef.current = element;
        return;
      }
      captureRemovedBillingFocus(billingPanelRef.current);
      billingPanelRef.current = null;
    },
    [captureRemovedBillingFocus]
  );

  const publishCredentials = useCallback(
    (
      harnessIds: readonly string[],
      context: SessionOperationContext | null
    ) => {
      if (!isCurrentOperation(context)) {
        return null;
      }
      const next = [...new Set(harnessIds)].sort();
      setConfigured(next);
      onCredentialsChange(next);
      return next;
    },
    [isCurrentOperation, onCredentialsChange]
  );

  const refreshCredentials = useCallback(
    async (context: SessionOperationContext | null) => {
      if (!context || !isCurrentOperation(context)) {
        return null;
      }
      const ticket = refreshFence.beginRefresh();
      const response = await fetch(`${BASE_PATH}/api/credentials`, {
        signal: context.signal,
      });
      if (!isCurrentOperation(context) || !refreshFence.isCurrent(ticket)) {
        return null;
      }
      if (response.status === 403) {
        // A demo session cannot store one, and saying so beats a form that
        // fails on submit.
        setLocked(true);
        return publishCredentials([], context);
      }
      if (!response.ok) {
        return null;
      }
      const body = (await response.json()) as { harnessIds?: string[] };
      if (!isCurrentOperation(context) || !refreshFence.isCurrent(ticket)) {
        return null;
      }
      return publishCredentials(body.harnessIds ?? [], context);
    },
    [isCurrentOperation, publishCredentials, refreshFence]
  );

  useEffect(() => {
    refreshFence.activate();
    setTab("harness");
    setConfigured([]);
    setDrafts({});
    setLocked(false);
    setBusy(false);
    setRefusedOpen(false);
    setUsage(null);
    setConfirmWipe(false);
    if (!account || !operationContext) {
      return () => refreshFence.deactivate();
    }
    refreshCredentials(operationContext).catch(() => undefined);
    return () => refreshFence.deactivate();
  }, [account, operationContext, refreshCredentials, refreshFence]);

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

  const handleTabKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, id: Tab) => {
      const index = tabs.findIndex((entry) => entry.id === id);
      if (index < 0) {
        return;
      }
      let destination: Tab | null = null;
      const nextKey = horizontalTabs ? "ArrowRight" : "ArrowDown";
      const previousKey = horizontalTabs ? "ArrowLeft" : "ArrowUp";
      if (event.key === nextKey) {
        destination = tabs[(index + 1) % tabs.length].id;
      } else if (event.key === previousKey) {
        destination = tabs[(index - 1 + tabs.length) % tabs.length].id;
      } else if (event.key === "Home") {
        destination = tabs[0].id;
      } else if (event.key === "End") {
        destination = tabs.at(-1)?.id ?? null;
      }
      if (!destination) {
        return;
      }
      event.preventDefault();
      setTab(destination);
      tabRefs.current.get(destination)?.focus();
    },
    [horizontalTabs, tabs]
  );

  useEffect(() => {
    const context = operationContext;
    if (!account || !context || !isCurrentOperation(context)) {
      return;
    }
    const load = async () => {
      try {
        const response = await fetch(`${BASE_PATH}/api/usage`, {
          signal: context.signal,
        });
        if (!isCurrentOperation(context) || !response.ok) {
          return;
        }
        const next = (await response.json()) as Usage;
        if (isCurrentOperation(context)) {
          setUsage(next);
        }
      } catch {
        // Session transitions abort this best-effort summary.
      }
    };
    load().catch(() => undefined);
  }, [account, isCurrentOperation, operationContext]);

  const dirty = Object.values(drafts).some((value) => value.trim().length > 0);

  const onDraft = (id: string, value: string) => {
    setDrafts((current) => ({ ...current, [id]: value }));
  };

  const save = async () => {
    const context = operationContextRef.current;
    if (!context || !isCurrentOperation(context)) {
      return;
    }
    setBusy(true);
    let stored = 0;
    let nextConfigured = configured;
    try {
      for (const [harnessId, value] of Object.entries(drafts)) {
        const credential = value.trim();
        if (!credential) {
          continue;
        }
        // Sequential: each write is a separate envelope encryption, and a
        // rejected token has to be reported against the harness it belongs to.
        // biome-ignore lint/performance/noAwaitInLoops: one credential at a time so a 422 names the harness that was refused.
        const response = await fetch(`${BASE_PATH}/api/credentials`, {
          body: JSON.stringify({ credential, harnessId }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: context.signal,
        });
        if (!isCurrentOperation(context)) {
          return;
        }

        if (response.status === 422) {
          // A rejected token is the person's to fix, so it is shown verbatim
          // and the typed value is kept — that is the only state it can be
          // corrected from.
          const body = (await response.json()) as { message?: string };
          if (isCurrentOperation(context)) {
            toast.error(body.message ?? "That token was rejected.");
          }
          return;
        }
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        if (!refreshFence.advanceMutation()) {
          return;
        }
        stored += 1;
        nextConfigured =
          publishCredentials([...nextConfigured, harnessId], context) ??
          nextConfigured;
      }

      if (!isCurrentOperation(context)) {
        return;
      }
      setDrafts({});
      await refreshCredentials(context);
      if (!isCurrentOperation(context)) {
        return;
      }
      toast.success(
        stored === 1 ? "Credential stored." : `${stored} credentials stored.`
      );
    } catch {
      if (isCurrentOperation(context)) {
        toast.error("Could not store the credential.");
      }
    } finally {
      if (isCurrentOperation(context)) {
        setBusy(false);
      }
    }
  };

  const remove = async (harnessId: string) => {
    const context = operationContextRef.current;
    if (!context || !isCurrentOperation(context)) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${BASE_PATH}/api/credentials`, {
        body: JSON.stringify({ harnessId }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
        signal: context.signal,
      });
      if (!isCurrentOperation(context)) {
        return;
      }
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      if (!refreshFence.advanceMutation()) {
        return;
      }
      publishCredentials(
        configured.filter((id) => id !== harnessId),
        context
      );
      await refreshCredentials(context);
      if (!isCurrentOperation(context)) {
        return;
      }
      toast.success("Credential removed.");
    } catch {
      if (isCurrentOperation(context)) {
        toast.error("Could not remove the credential.");
      }
    } finally {
      if (isCurrentOperation(context)) {
        setBusy(false);
      }
    }
  };

  const wipeChats = async () => {
    const context = operationContextRef.current;
    if (!context || !isCurrentOperation(context)) {
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${BASE_PATH}/api/history`, {
        method: "DELETE",
        signal: context.signal,
      });
      if (!isCurrentOperation(context)) {
        return;
      }
      if (!response.ok) {
        throw new Error(String(response.status));
      }
      toast.success("All chats deleted.");
      setConfirmWipe(false);
    } catch {
      if (isCurrentOperation(context)) {
        toast.error("Could not delete your chats.");
      }
    } finally {
      if (isCurrentOperation(context)) {
        setBusy(false);
      }
    }
  };

  const daysToReset = usage?.resetsAt
    ? Math.max(
        0,
        Math.ceil((Date.parse(usage.resetsAt) - Date.now()) / MS_PER_DAY)
      )
    : null;
  const pct = usage
    ? Math.min(100, Math.round((usage.used / usage.cap) * 100))
    : 0;

  if (!account) {
    return (
      <div
        className="oc-settings-signed-out"
        style={{
          alignItems: "center",
          background: "var(--bg-base)",
          display: "flex",
          flex: 1,
          justifyContent: "center",
          padding: 32,
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 440 }}>
          <Eyebrow>Account required</Eyebrow>
          <h2 style={{ ...type_.display, fontSize: 28, margin: "10px 0 8px" }}>
            Sign in to manage your account
          </h2>
          <p style={{ ...type_.body, margin: "0 auto", maxWidth: "42ch" }}>
            Harness credentials, usage, and account data are available only
            after GitHub sign-in.
          </p>
          <Link
            href="/login"
            style={{
              ...pill("accent"),
              display: "inline-flex",
              marginTop: 20,
              padding: "9px 14px",
              textDecoration: "none",
            }}
          >
            Sign in with GitHub
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      className="oc-settings"
      style={{
        background: "var(--bg-panel)",
        display: "flex",
        flex: 1,
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <nav
          aria-label="Console settings navigation"
          className="oc-settings-nav"
          style={{
            borderRight: hairline,
            display: "flex",
            flex: "none",
            flexDirection: "column",
            gap: 3,
            padding: "16px 12px",
            width: 212,
          }}
        >
          <div
            aria-label="Console settings"
            aria-orientation={tabOrientation}
            role="tablist"
            style={{ display: "contents" }}
          >
            <Eyebrow
              style={{
                color: "var(--text-muted)",
                letterSpacing: "0.14em",
                padding: "0 10px 8px",
              }}
            >
              Settings
            </Eyebrow>
            {tabs.map((entry) => (
              <button
                aria-controls={settingsPanelId(entry.id)}
                aria-selected={selectedTab === entry.id}
                className="oc-row"
                id={settingsTabId(entry.id)}
                key={entry.id}
                onClick={() => setTab(entry.id)}
                onKeyDown={(event) => handleTabKeyDown(event, entry.id)}
                ref={
                  entry.id === "billing"
                    ? registerBillingTab
                    : (element) => {
                        if (element) {
                          tabRefs.current.set(entry.id, element);
                        } else {
                          tabRefs.current.delete(entry.id);
                        }
                      }
                }
                role="tab"
                style={{
                  background:
                    selectedTab === entry.id
                      ? "color-mix(in oklch, var(--accent-presence) 14%, transparent)"
                      : "transparent",
                  border: 0,
                  borderRadius: "var(--radius-md)",
                  color:
                    selectedTab === entry.id
                      ? "var(--text-primary)"
                      : "var(--text-secondary)",
                  cursor: "pointer",
                  font: "500 12px/1.3 var(--font-ui)",
                  padding: "8px 10px",
                  textAlign: "left",
                  width: "100%",
                }}
                tabIndex={selectedTab === entry.id ? 0 : -1}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </div>
        </nav>

        <div
          aria-labelledby={settingsTabId(selectedTab)}
          className="oc-settings-content oc-scroll"
          id={settingsPanelId(selectedTab)}
          role="tabpanel"
          style={{
            background: "var(--bg-base)",
            flex: 1,
            minWidth: 0,
            overflowY: "auto",
            padding: "24px 30px 30px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 16,
              maxWidth: 640,
            }}
          >
            {selectedTab === "harness" ? (
              <>
                <Heading
                  blurb="Your credential, envelope-encrypted, fetched for the duration of one run and redacted from evidence. Never shared with another account."
                  title="Harness credentials"
                />
                {locked ? (
                  <p style={type_.body}>
                    Storing a credential needs an active subscription.
                  </p>
                ) : (
                  RUNNABLE.map((spec) => (
                    <HarnessCard
                      busy={busy}
                      configured={configured.includes(spec.id)}
                      draft={drafts[spec.id] ?? ""}
                      harness={spec}
                      key={spec.id}
                      onDraft={onDraft}
                      onRemove={remove}
                      runnable
                    />
                  ))
                )}

                <button
                  aria-expanded={refusedOpen}
                  className="oc-tint"
                  onClick={() => setRefusedOpen((value) => !value)}
                  style={{
                    alignItems: "center",
                    background: "transparent",
                    border: hairline,
                    borderRadius: "var(--radius-card)",
                    cursor: "pointer",
                    display: "flex",
                    gap: 9,
                    padding: "10px 12px",
                    textAlign: "left",
                    width: "100%",
                  }}
                  type="button"
                >
                  <Caret open={refusedOpen} />
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      font: "500 12px/1.3 var(--font-ui)",
                    }}
                  >
                    Unavailable providers
                  </span>
                  <span style={{ ...type_.meta, flex: 1, ...truncate }}>
                    {REFUSED.map((spec) => spec.label).join(", ")} — refused by
                    the runner
                  </span>
                </button>

                {refusedOpen
                  ? REFUSED.map((spec) => (
                      <HarnessCard
                        busy={busy}
                        configured={false}
                        draft=""
                        harness={spec}
                        key={spec.id}
                        onDraft={onDraft}
                        onRemove={remove}
                        runnable={false}
                      />
                    ))
                  : null}
              </>
            ) : null}

            {selectedTab === "usage" ? (
              <>
                <Heading
                  blurb="A run is counted when an agent starts, whether it succeeds or not."
                  title="Usage"
                />
                {usage ? (
                  <div
                    style={{
                      background: "var(--bg-raised)",
                      border: hairline,
                      borderRadius: "var(--radius-card)",
                      display: "flex",
                      flexDirection: "column",
                      gap: 12,
                      padding: 16,
                    }}
                  >
                    <div
                      style={{
                        alignItems: "baseline",
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                      }}
                    >
                      <span
                        style={{
                          color: "var(--text-primary)",
                          font: "600 26px/1 var(--font-ui)",
                          ...tabular,
                        }}
                      >
                        {usage.used}
                      </span>
                      <span
                        style={{
                          color: "var(--text-secondary)",
                          font: "400 13px/1 var(--font-ui)",
                          ...tabular,
                        }}
                      >
                        of {usage.cap} runs
                      </span>
                      {daysToReset === null ? null : (
                        <span style={type_.meta}>
                          · {daysToReset} days to reset
                        </span>
                      )}
                    </div>

                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      <div
                        aria-label="Runs used this month"
                        aria-valuemax={usage.cap}
                        aria-valuemin={0}
                        aria-valuenow={usage.used}
                        aria-valuetext={`${usage.used} of ${usage.cap} runs, ${pct} percent of the monthly cap`}
                        role="progressbar"
                        style={{
                          background: "var(--bg-sunken)",
                          border: hairline,
                          borderRadius: 999,
                          height: 6,
                          overflow: "hidden",
                        }}
                      >
                        <div
                          style={{
                            background: "var(--accent-presence)",
                            borderRadius: 999,
                            height: "100%",
                            width: `${pct}%`,
                          }}
                        />
                      </div>
                      <span style={{ ...type_.meta, ...tabular }}>
                        {pct}% of the monthly cap ·{" "}
                        {Math.max(0, usage.cap - usage.used)} runs left
                      </span>
                    </div>

                    <div
                      style={{
                        borderTop: hairline,
                        display: "grid",
                        gap: 12,
                        gridTemplateColumns: "repeat(3, 1fr)",
                        paddingTop: 12,
                      }}
                    >
                      {[
                        { label: "Used", value: String(usage.used) },
                        {
                          label: "Remaining",
                          value: String(Math.max(0, usage.cap - usage.used)),
                        },
                        {
                          label: "Cap",
                          value: String(usage.cap),
                        },
                      ].map((stat) => (
                        <div
                          key={stat.label}
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          <Eyebrow style={{ color: "var(--text-muted)" }}>
                            {stat.label}
                          </Eyebrow>
                          <span
                            style={{
                              color: "var(--text-primary)",
                              font: "500 13px/1 var(--font-ui)",
                              ...tabular,
                            }}
                          >
                            {stat.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p style={type_.body}>
                    Usage is not readable on this session. The cap applies to a
                    subscriber account.
                  </p>
                )}
              </>
            ) : null}

            {selectedTab === "billing" && showBilling ? (
              <div ref={registerBillingPanel}>
                <SubscriptionCard
                  checkoutEnabled={checkoutEnabled}
                  isSubscriber={isSubscriber}
                  subscribedUntil={subscribedUntil}
                />
              </div>
            ) : null}

            {selectedTab === "data" ? (
              <>
                <Heading
                  blurb="What this account stores, and how to remove it."
                  title="Data"
                />
                <div
                  style={{
                    background: "var(--bg-raised)",
                    border: hairline,
                    borderRadius: "var(--radius-card)",
                    padding: 14,
                  }}
                >
                  <div style={type_.label}>Run records</div>
                  <p
                    style={{
                      ...type_.body,
                      font: "400 12px/1.5 var(--font-ui)",
                      marginTop: 3,
                    }}
                  >
                    Runs live in the runner&rsquo;s durable state, not in this
                    account. There is no export or bulk delete here because
                    there is no archive on this side to act on.
                  </p>
                </div>

                <div
                  style={{
                    background: "var(--danger-bg)",
                    border: "1px solid var(--danger-border)",
                    borderRadius: "var(--radius-card)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 11,
                    padding: 14,
                  }}
                >
                  <div>
                    <div
                      style={{
                        color: "var(--danger-text)",
                        font: "600 13px/1.3 var(--font-ui)",
                      }}
                    >
                      Delete all chats
                    </div>
                    <p
                      style={{
                        ...type_.body,
                        font: "400 12px/1.5 var(--font-ui)",
                        marginTop: 3,
                      }}
                    >
                      Removes every chat on this account. Agents and stored
                      credentials are untouched. This is not reversible.
                    </p>
                  </div>
                  {confirmWipe ? (
                    <div
                      style={{ alignItems: "center", display: "flex", gap: 9 }}
                    >
                      <Btn
                        disabled={busy}
                        onClick={() => {
                          wipeChats().catch(() => undefined);
                        }}
                        variant="danger-ghost"
                      >
                        Yes, delete every chat
                      </Btn>
                      <Btn
                        onClick={() => setConfirmWipe(false)}
                        variant="ghost"
                      >
                        Cancel
                      </Btn>
                    </div>
                  ) : (
                    <Btn
                      onClick={() => setConfirmWipe(true)}
                      variant="danger-ghost"
                    >
                      Delete all chats…
                    </Btn>
                  )}
                </div>
              </>
            ) : null}

            {selectedTab === "account" ? (
              <>
                <Heading
                  blurb="Sign-in is GitHub-only. There is no password to change."
                  title="Account"
                />
                <div
                  style={{
                    alignItems: "center",
                    background: "var(--bg-raised)",
                    border: hairline,
                    borderRadius: "var(--radius-card)",
                    display: "flex",
                    gap: 12,
                    padding: 14,
                  }}
                >
                  <span
                    style={{
                      ...well(false, 34),
                      borderRadius: "var(--radius-pill)",
                    }}
                  >
                    {account ? glyphFor(account) : "\u25c6"}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ ...type_.label, ...truncate }}>
                      {account ?? "not signed in"}
                    </div>
                    <div style={{ ...type_.meta, marginTop: 2 }}>
                      {configured.length > 0
                        ? `${configured.length} harness credential(s) stored`
                        : "no harness credential stored"}
                    </div>
                  </div>
                  {account ? (
                    <Btn
                      onClick={() =>
                        signOut({
                          redirectTo: browserApplicationPath("/login"),
                        })
                      }
                      variant="ghost"
                    >
                      Sign out
                    </Btn>
                  ) : (
                    // Offering "Sign out" to a visitor who never signed in is
                    // a control that cannot do anything. The useful one is the
                    // opposite.
                    <Btn
                      onClick={() => {
                        window.location.href = "/login";
                      }}
                      variant="secondary"
                    >
                      Sign in
                    </Btn>
                  )}
                </div>
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* The save bar exists for the credential drafts, which are the only
          deferred writes on this screen. Everything else commits when clicked,
          so the bar reports idle rather than implying it owns those too. */}
      <div
        style={{
          alignItems: "center",
          background: "var(--bg-sunken)",
          borderTop: hairline,
          display: "flex",
          flex: "none",
          gap: 10,
          minHeight: 52,
          padding: "11px 22px",
        }}
      >
        <span
          style={{
            background: dirty ? "var(--color-warning)" : "var(--text-faint)",
            borderRadius: 999,
            flex: "none",
            height: 6,
            width: 6,
          }}
        />
        <span
          aria-live="polite"
          role="status"
          style={{
            color: dirty ? "var(--text-primary)" : "var(--text-muted)",
            font: "400 12px/1 var(--font-ui)",
          }}
        >
          {dirty ? "Unsaved credential" : "No unsaved changes"}
        </span>
        <div style={{ flex: 1 }} />
        <Btn
          disabled={!dirty || busy}
          onClick={() => setDrafts({})}
          variant="ghost"
        >
          Discard
        </Btn>
        <Btn
          disabled={!dirty || busy}
          onClick={() => {
            save().catch(() => undefined);
          }}
          variant="primary"
        >
          {busy ? "Saving…" : "Save"}
        </Btn>
      </div>
    </div>
  );
}
