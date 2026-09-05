// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { Eyebrow } from "@/components/console/primitives";
import { hairline, tabular, type as type_ } from "@/components/console/styles";
import type { AdminAccountRow, AdminOverview } from "@/lib/admin/directory";

/**
 * Warden — the owner's view of the fleet.
 *
 * Every figure is read off a real column (`RunUsage`, `User`) and the panels
 * whose columns do not exist yet say so, in the analytics screen's tradition:
 * a page for the operator is the last place a number may be invented.
 * Emails arrive masked from the server and the raw address never reaches
 * this component — support lookups go through the account id, which is why
 * search is id-only.
 */

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
type Tab = "accounts" | "alerts" | "audit" | "overview";
type SortKey = "lastRunDay" | "runs" | "signupDay";
const PAGE_SIZE = 15;
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "accounts", label: "Accounts" },
  { key: "alerts", label: "Alerts" },
  { key: "audit", label: "Audit log" },
];

type Payload = { accounts: AdminAccountRow[]; overview: AdminOverview };

function shortDay(day: string | null): string {
  if (!day) {
    return "—";
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00.000Z`));
}

function deltaLabel(current: number, previous: number): string {
  if (previous <= 0) {
    return current > 0 ? "new" : "±0";
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  return pct === 0 ? "±0%" : `${pct > 0 ? "+" : ""}${pct}%`;
}

const STATUS_TONE: Record<AdminAccountRow["status"], string> = {
  active: "var(--color-success)",
  guest: "var(--text-faint)",
  lapsed: "var(--color-warning)",
};

function Tile({
  delta,
  label,
  sub,
  value,
}: {
  delta?: string;
  label: string;
  sub: string;
  value: string;
}) {
  return (
    <div style={{ display: "flex", flex: 1, flexDirection: "column", gap: 7 }}>
      <Eyebrow>{label}</Eyebrow>
      <span style={{ alignItems: "baseline", display: "flex", gap: 8 }}>
        <span
          style={{
            ...tabular,
            color: "var(--text-primary)",
            font: "600 25px/1 var(--font-mono)",
            letterSpacing: "-0.01em",
          }}
        >
          {value}
        </span>
        {delta ? (
          <span
            style={{
              color: delta.startsWith("+")
                ? "var(--color-success-soft)"
                : delta.startsWith("-")
                  ? "var(--danger-text)"
                  : "var(--text-faint)",
              font: "500 11px/1 var(--font-mono)",
            }}
          >
            {delta}
          </span>
        ) : null}
      </span>
      <span style={{ ...type_.meta, whiteSpace: "normal" }}>{sub}</span>
    </div>
  );
}

/**
 * A panel the records cannot fill, named rather than hidden — the same
 * honesty contract as the tenant analytics screen.
 */
/** `2m 14s`, or `47s` under a minute. */
function fleetDuration(seconds: number): string {
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * A panel the receipts can fill. Solid border, so it reads as a measurement
 * rather than as one of the named gaps beside it.
 */
function Recorded({
  sub,
  title,
  value,
}: {
  sub: string;
  title: string;
  value: string | null;
}) {
  return (
    <div
      style={{
        background: "var(--bg-panel)",
        border: hairline,
        borderRadius: "var(--radius-card)",
        display: "flex",
        flex: "1 1 160px",
        flexDirection: "column",
        gap: 6,
        padding: "12px 14px",
      }}
    >
      <Eyebrow>{title}</Eyebrow>
      <span
        style={{
          color: value === null ? "var(--text-faint)" : "var(--text-primary)",
          font: "600 20px/1 var(--font-ui)",
          ...tabular,
        }}
      >
        {value ?? "—"}
      </span>
      <span style={{ ...type_.meta, lineHeight: 1.5, whiteSpace: "normal" }}>
        {value === null ? "no settled run in range" : String(sub)}
      </span>
    </div>
  );
}

function NotRecorded({ needs, title }: { needs: string; title: string }) {
  return (
    <div
      style={{
        border: "1px dashed var(--border-strong)",
        borderRadius: "var(--radius-card)",
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 8,
        minWidth: 150,
        padding: 12,
      }}
    >
      <Eyebrow>{title}</Eyebrow>
      <span
        style={{
          color: "var(--text-faint)",
          font: "600 20px/1 var(--font-ui)",
        }}
      >
        —
      </span>
      <span style={{ ...type_.meta, lineHeight: 1.5, whiteSpace: "normal" }}>
        needs {needs}
      </span>
    </div>
  );
}

function VolumeChart({ days }: { days: AdminOverview["days"] }) {
  const peak = Math.max(1, ...days.map((entry) => entry.runs));
  return (
    <div>
      <div
        style={{
          alignItems: "flex-end",
          display: "flex",
          gap: 2,
          height: 150,
        }}
      >
        {days.map((entry) => (
          <div
            key={entry.day}
            style={{
              alignItems: "flex-end",
              alignSelf: "stretch",
              display: "flex",
              flex: 1,
              minWidth: 0,
            }}
            title={`${shortDay(entry.day)} — ${entry.runs} run${entry.runs === 1 ? "" : "s"}`}
          >
            <div
              style={{
                background: "var(--accent-presence)",
                borderRadius: "4px 4px 0 0",
                height:
                  entry.runs === 0
                    ? 0
                    : `${Math.max(3, (entry.runs / peak) * 100)}%`,
                width: "100%",
              }}
            />
          </div>
        ))}
      </div>
      <div
        style={{
          borderTop: hairline,
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          paddingTop: 6,
        }}
      >
        <span style={type_.meta}>{shortDay(days[0]?.day ?? null)}</span>
        <span style={type_.meta}>peak {peak} in a day</span>
        <span style={type_.meta}>{shortDay(days.at(-1)?.day ?? null)}</span>
      </div>
    </div>
  );
}

function EmptyLedger({
  needs,
  note,
  title,
}: {
  needs: string;
  note: string;
  title: string;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        border: "1px dashed var(--border-strong)",
        borderRadius: "var(--radius-card)",
        display: "flex",
        flex: 1,
        flexDirection: "column",
        gap: 9,
        justifyContent: "center",
        padding: 40,
      }}
    >
      <span
        style={{
          color: "var(--text-secondary)",
          font: "500 13px/1 var(--font-ui)",
        }}
      >
        {title}
      </span>
      <p
        style={{
          ...type_.body,
          maxWidth: "54ch",
          textAlign: "center",
        }}
      >
        {note}
      </p>
      <span style={{ ...type_.meta, whiteSpace: "normal" }}>needs {needs}</span>
    </div>
  );
}

export function Warden({ operator }: { operator: string }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [range, setRange] = useState<Range>(30);
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("runs");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Payload | null>(null);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setRefused(false);
    fetch(`${BASE_PATH}/api/admin?days=${range}`)
      .then(async (response) =>
        response.ok ? ((await response.json()) as Payload) : null
      )
      .then((next) => {
        if (cancelled) {
          return;
        }
        if (next) {
          setData(next);
        } else {
          setRefused(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRefused(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

  const accounts = useMemo(() => {
    const pool = (data?.accounts ?? []).filter((row) =>
      query ? row.id.startsWith(query.trim().toLowerCase()) : true
    );
    return [...pool].sort((left, right) => {
      if (sortKey === "runs") {
        return right.runs - left.runs;
      }
      const l = left[sortKey] ?? "";
      const r = right[sortKey] ?? "";
      return r.localeCompare(l);
    });
  }, [data, query, sortKey]);

  const pages = Math.max(1, Math.ceil(accounts.length / PAGE_SIZE));
  const slice = accounts.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const overview = data?.overview ?? null;

  const columns: { key?: SortKey; label: string; right?: boolean }[] = [
    { label: "account" },
    { label: "email" },
    { label: "plan" },
    { label: "status" },
    { key: "signupDay", label: "signup" },
    { key: "lastRunDay", label: "last run" },
    { key: "runs", label: `runs · ${range}d`, right: true },
  ];

  return (
    <div
      className="oc-console"
      style={{
        background: "var(--bg-base)",
        color: "var(--text-primary)",
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        overflow: "hidden",
      }}
    >
      <header
        className="oc-admin-header"
        style={{
          alignItems: "center",
          background: "var(--bg-panel)",
          borderBottom: hairline,
          display: "flex",
          flex: "none",
          gap: 12,
          height: 52,
          padding: "0 18px",
        }}
      >
        <span
          style={{
            alignItems: "center",
            display: "flex",
            flex: "none",
            gap: 8,
          }}
        >
          <BrandMark
            style={{
              color: "var(--accent-presence)",
              height: 14,
              width: 15,
            }}
          />
          <span style={{ font: "600 13px/1 var(--font-ui)" }}>Warden</span>
        </span>
        <nav
          aria-label="Admin sections"
          className="oc-admin-tabs"
          style={{
            background: "var(--bg-sunken)",
            border: hairline,
            borderRadius: "var(--radius-control)",
            display: "flex",
            flex: "none",
            gap: 1,
            padding: 2,
          }}
        >
          {TABS.map((entry) => (
            <button
              aria-pressed={tab === entry.key}
              key={entry.key}
              onClick={() => setTab(entry.key)}
              style={{
                background:
                  tab === entry.key ? "var(--bg-elevated)" : "transparent",
                border: 0,
                borderRadius: 5,
                color:
                  tab === entry.key
                    ? "var(--text-primary)"
                    : "var(--text-secondary)",
                cursor: "pointer",
                font: "500 11px/1 var(--font-ui)",
                height: 24,
                padding: "0 10px",
              }}
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </nav>
        <fieldset
          className="oc-admin-ranges"
          style={{
            background: "var(--bg-sunken)",
            border: hairline,
            borderRadius: "var(--radius-control)",
            display: "flex",
            flex: "none",
            gap: 1,
            margin: 0,
            padding: 2,
          }}
        >
          {RANGES.map((option) => (
            <button
              aria-pressed={range === option}
              key={option}
              onClick={() => {
                setRange(option);
                setPage(0);
              }}
              style={{
                background:
                  range === option ? "var(--bg-elevated)" : "transparent",
                border: 0,
                borderRadius: 4,
                color:
                  range === option
                    ? "var(--accent-presence)"
                    : "var(--text-secondary)",
                cursor: "pointer",
                font: "500 10px/1 var(--font-mono)",
                height: 22,
                padding: "0 8px",
              }}
              type="button"
            >
              {option}d
            </button>
          ))}
        </fieldset>
        <input
          aria-label="Search accounts — account id only"
          className="oc-admin-search"
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          placeholder="Account id…"
          spellCheck={false}
          style={{
            background: "var(--bg-sunken)",
            border: hairline,
            borderRadius: "var(--radius-control)",
            color: "var(--text-primary)",
            flex: 1,
            font: "400 12px/1 var(--font-mono)",
            height: 28,
            minWidth: 0,
            outline: "none",
            padding: "0 10px",
          }}
          type="search"
          value={query}
        />
        <span
          className="oc-admin-owner"
          style={{ ...type_.meta, flex: "none" }}
          title={`${operator} — owner session. Views are not yet written to an audit log; the Audit tab says what that needs.`}
        >
          owner
        </span>
      </header>

      <main
        className="oc-admin-main oc-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "18px 22px 28px",
        }}
      >
        {refused ? (
          <p style={{ ...type_.body }}>
            The directory refused this request. Reload, or check the session.
          </p>
        ) : null}

        {tab === "overview" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <h1 style={{ ...type_.display, margin: 0 }}>
              The fleet, last {range} days
            </h1>
            <span style={type_.meta}>
              read off RunUsage — append-only run records · Δ vs the {range}{" "}
              days before
            </span>

            <div
              className="oc-card"
              style={{
                background: "var(--bg-panel)",
                border: hairline,
                borderRadius: "var(--radius-card)",
                display: "flex",
                flexWrap: "wrap",
                gap: 22,
                padding: "14px 18px",
              }}
            >
              <Tile
                delta={
                  overview
                    ? deltaLabel(overview.runsTotal, overview.runsPrevious)
                    : undefined
                }
                label="Runs"
                sub="counted at credential admission"
                value={
                  overview ? String(overview.runsTotal) : refused ? "n/a" : "…"
                }
              />
              <Tile
                label="Active accounts"
                sub="tenants with ≥1 run in range"
                value={
                  overview
                    ? String(overview.activeAccounts)
                    : refused
                      ? "n/a"
                      : "…"
                }
              />
              <Tile
                label="New accounts"
                sub="User rows created in range"
                value={
                  overview
                    ? String(overview.newAccounts)
                    : refused
                      ? "n/a"
                      : "…"
                }
              />
              <Tile
                label="All accounts"
                sub="every User row, ever"
                value={
                  overview
                    ? String(overview.accountsTotal)
                    : refused
                      ? "n/a"
                      : "…"
                }
              />
            </div>

            <div
              style={{
                background: "var(--bg-panel)",
                border: hairline,
                borderRadius: "var(--radius-card)",
                padding: "12px 14px",
              }}
            >
              <Eyebrow style={{ marginBottom: 10 }}>
                run volume · fleet-wide
              </Eyebrow>
              {overview ? (
                <VolumeChart days={overview.days} />
              ) : (
                <span style={type_.meta}>
                  {refused ? "directory unreachable" : "loading…"}
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
              <NotRecorded
                needs="an outcome column on RunUsage"
                title="Failure rate"
              />
              <Recorded
                sub="95th percentile of settled runs in range"
                title="p95 duration"
                value={
                  overview?.durationP95Seconds === null ||
                  overview?.durationP95Seconds === undefined
                    ? null
                    : fleetDuration(overview.durationP95Seconds)
                }
              />
              <NotRecorded needs="a retry ledger" title="Retries" />
              <Recorded
                sub="minutes charged against caps in range"
                title="Minutes charged"
                value={overview ? String(overview.minutesTotal) : null}
              />
              <NotRecorded
                needs="provider spend per run"
                title="Provider cost"
              />
            </div>
          </div>
        ) : null}

        {tab === "accounts" ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ alignItems: "baseline", display: "flex", gap: 12 }}>
              <h1 style={{ ...type_.display, margin: 0 }}>Accounts</h1>
              <span aria-live="polite" style={type_.meta}>
                {accounts.length} of {data?.accounts.length ?? 0}
              </span>
            </div>
            <span style={{ ...type_.meta, whiteSpace: "normal" }}>
              emails masked server-side — the address never reaches this page ·
              search is account id only, partial email search is deliberately
              unsupported
            </span>

            <div
              className="oc-admin-table-scroll"
              style={{
                background: "var(--bg-panel)",
                border: hairline,
                borderRadius: "var(--radius-card)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  background: "var(--bg-sunken)",
                  borderBottom: "1px solid var(--border-strong)",
                  display: "grid",
                  gap: 8,
                  gridTemplateColumns:
                    "minmax(120px,1fr) minmax(110px,1fr) 70px 70px 80px 80px 90px",
                  padding: "8px 14px",
                }}
              >
                {columns.map((column) => (
                  <button
                    disabled={!column.key}
                    key={column.label}
                    onClick={() => {
                      if (column.key) {
                        setSortKey(column.key);
                        setPage(0);
                      }
                    }}
                    style={{
                      background: "transparent",
                      border: 0,
                      color:
                        column.key && sortKey === column.key
                          ? "var(--accent-presence)"
                          : "var(--text-muted)",
                      cursor: column.key ? "pointer" : "default",
                      font: "600 9px/1 var(--font-mono)",
                      letterSpacing: "0.11em",
                      padding: 0,
                      textAlign: column.right ? "right" : "left",
                      textTransform: "uppercase",
                    }}
                    type="button"
                  >
                    {column.label}
                  </button>
                ))}
              </div>
              {slice.length === 0 ? (
                <p style={{ ...type_.body, padding: "26px 14px" }}>
                  {data
                    ? "No accounts match."
                    : refused
                      ? "The directory could not be read. Nothing is missing from the record."
                      : "loading…"}
                </p>
              ) : (
                slice.map((row) => (
                  <div
                    key={row.id}
                    style={{
                      alignItems: "center",
                      borderBottom: hairline,
                      display: "grid",
                      gap: 8,
                      gridTemplateColumns:
                        "minmax(120px,1fr) minmax(110px,1fr) 70px 70px 80px 80px 90px",
                      padding: "8px 14px",
                    }}
                  >
                    <button
                      onClick={() => navigator.clipboard?.writeText(row.id)}
                      style={{
                        background: "transparent",
                        border: 0,
                        color: "var(--accent-presence)",
                        cursor: "pointer",
                        font: "500 11px/1 var(--font-mono)",
                        overflow: "hidden",
                        padding: 0,
                        textAlign: "left",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                      title={`${row.id} — click to copy`}
                      type="button"
                    >
                      {row.id.slice(0, 8)}
                    </button>
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        font: "400 11px/1 var(--font-mono)",
                      }}
                      title="Masked server-side. Support lookups go through the account id."
                    >
                      {row.email}
                    </span>
                    <span
                      style={{
                        color: "var(--text-secondary)",
                        font: "400 11px/1 var(--font-mono)",
                      }}
                    >
                      {row.plan}
                    </span>
                    <span
                      style={{
                        alignItems: "center",
                        display: "flex",
                        gap: 5,
                      }}
                    >
                      <span
                        style={{
                          background: STATUS_TONE[row.status],
                          borderRadius: 99,
                          height: 6,
                          width: 6,
                        }}
                      />
                      <span
                        style={{
                          color: "var(--text-secondary)",
                          font: "400 10px/1 var(--font-mono)",
                        }}
                      >
                        {row.status}
                      </span>
                    </span>
                    <span style={{ ...type_.meta, ...tabular }}>
                      {shortDay(row.signupDay)}
                    </span>
                    <span style={{ ...type_.meta, ...tabular }}>
                      {shortDay(row.lastRunDay)}
                    </span>
                    <span
                      style={{
                        ...tabular,
                        color: "var(--text-primary)",
                        font: "500 11px/1 var(--font-mono)",
                        textAlign: "right",
                      }}
                    >
                      {row.runs}
                    </span>
                  </div>
                ))
              )}
              <div
                style={{
                  alignItems: "center",
                  background: "var(--bg-sunken)",
                  borderTop: "1px solid var(--border-strong)",
                  display: "flex",
                  gap: 10,
                  padding: "8px 14px",
                }}
              >
                <span style={{ ...type_.meta, ...tabular }}>
                  {accounts.length === 0
                    ? "0 accounts"
                    : `${page * PAGE_SIZE + 1}–${Math.min(accounts.length, (page + 1) * PAGE_SIZE)} of ${accounts.length}`}
                </span>
                <div style={{ flex: 1 }} />
                <button
                  disabled={page === 0}
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                  style={{
                    background: "transparent",
                    border: hairline,
                    borderRadius: "var(--radius-control)",
                    color:
                      page === 0
                        ? "var(--text-faint)"
                        : "var(--text-secondary)",
                    cursor: page === 0 ? "default" : "pointer",
                    font: "500 10px/1 var(--font-mono)",
                    height: 22,
                    padding: "0 8px",
                  }}
                  type="button"
                >
                  ← prev
                </button>
                <button
                  disabled={page >= pages - 1}
                  onClick={() =>
                    setPage((current) => Math.min(pages - 1, current + 1))
                  }
                  style={{
                    background: "transparent",
                    border: hairline,
                    borderRadius: "var(--radius-control)",
                    color:
                      page >= pages - 1
                        ? "var(--text-faint)"
                        : "var(--text-secondary)",
                    cursor: page >= pages - 1 ? "default" : "pointer",
                    font: "500 10px/1 var(--font-mono)",
                    height: 22,
                    padding: "0 8px",
                  }}
                  type="button"
                >
                  next →
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {tab === "alerts" ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              height: "100%",
            }}
          >
            <h1 style={{ ...type_.display, margin: 0 }}>Alerts</h1>
            <EmptyLedger
              needs="an alert store with thresholds evaluated over run outcomes"
              note="Nothing here is monitored yet. RunUsage records that runs happened, not how they went, so there is no signal an alert could honestly fire on."
              title="No alert stream exists"
            />
          </div>
        ) : null}

        {tab === "audit" ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              height: "100%",
            }}
          >
            <h1 style={{ ...type_.display, margin: 0 }}>Audit log</h1>
            <EmptyLedger
              needs="an append-only table recording every admin view and action"
              note="Admin sessions are not yet audited. Until the ledger exists this page will not pretend they are — the header chip says owner, not audited, for the same reason."
              title="No audit ledger exists"
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
