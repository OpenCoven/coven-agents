// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import { useEffect, useState } from "react";
import { Eyebrow } from "@/components/console/primitives";
import { hairline, tabular, type as type_ } from "@/components/console/styles";
import type { DayCount } from "@/lib/billing/history";

/**
 * Evidence analytics.
 *
 * One panel here is drawn from data and the rest say they are not, on purpose.
 * `RunUsage` records a tenant, a run id and the instant a run was counted —
 * so run volume over time is real, and acceptance rate, time-to-evidence and
 * stop reasons have no column behind them. A page headed "read off run
 * receipts" that guessed at those would be worse than one that admits the gap:
 * the whole point of the screen is that its numbers can be trusted.
 */

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];

const CHART_HEIGHT = 168;
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Analytics = {
  cap: number;
  days: DayCount[];
  range: number;
  total: number;
};

function shortDay(day: string): string {
  const at = new Date(`${day}T00:00:00.000Z`);
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(at);
}

/**
 * Daily run volume.
 *
 * One series, so no legend — the panel title names it. Each day gets a track
 * whether or not it had a run, because a quiet day has to read as an empty
 * slot rather than as a day that is missing from the series.
 */
function VolumeChart({ days }: { days: DayCount[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const peak = Math.max(1, ...days.map((entry) => entry.runs));
  const peakIndex = days.findIndex((entry) => entry.runs === peak);

  return (
    <div>
      <div
        style={{
          alignItems: "flex-end",
          display: "flex",
          gap: 2,
          height: CHART_HEIGHT,
          position: "relative",
        }}
      >
        {days.map((entry, index) => {
          const ratio = entry.runs / peak;
          const active = hover === index;
          return (
            <div
              key={entry.day}
              onPointerEnter={() => setHover(index)}
              onPointerLeave={() => setHover(null)}
              style={{
                alignItems: "flex-end",
                alignSelf: "stretch",
                background: active
                  ? "color-mix(in oklch, var(--ink) 6%, transparent)"
                  : "transparent",
                borderRadius: 4,
                display: "flex",
                flex: 1,
                minWidth: 0,
                position: "relative",
              }}
              title={`${shortDay(entry.day)} — ${entry.runs} run${entry.runs === 1 ? "" : "s"}`}
            >
              <div
                style={{
                  // 4px rounded data-end, anchored to the baseline. A zero day
                  // draws nothing at all rather than a stub that would read as
                  // a small value.
                  background: active
                    ? "oklch(0.82 0.10 292)"
                    : "var(--accent-presence)",
                  borderRadius: "4px 4px 0 0",
                  height: entry.runs === 0 ? 0 : `${Math.max(3, ratio * 100)}%`,
                  width: "100%",
                }}
              />
              {index === peakIndex && entry.runs > 0 ? (
                <span
                  style={{
                    ...type_.meta,
                    ...tabular,
                    bottom: `calc(${Math.max(3, ratio * 100)}% + 4px)`,
                    color: "var(--text-secondary)",
                    left: "50%",
                    position: "absolute",
                    transform: "translateX(-50%)",
                  }}
                >
                  {entry.runs}
                </span>
              ) : null}
            </div>
          );
        })}
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
        <span style={type_.meta}>{shortDay(days[0]?.day ?? "")}</span>
        <span
          aria-live="polite"
          style={{
            ...type_.meta,
            color: hover === null ? "var(--text-muted)" : "var(--text-primary)",
          }}
        >
          {hover === null
            ? `peak ${peak} in a day`
            : `${shortDay(days[hover]?.day ?? "")} — ${days[hover]?.runs} run${days[hover]?.runs === 1 ? "" : "s"}`}
        </span>
        <span style={type_.meta}>{shortDay(days.at(-1)?.day ?? "")}</span>
      </div>
    </div>
  );
}

/**
 * A panel the receipts cannot fill.
 *
 * Named rather than hidden. A missing panel reads as a page still being built;
 * a panel that says which column is absent tells you what would have to be
 * recorded for the number to exist.
 */
function NotRecorded({
  blurb,
  needs,
  title,
}: {
  blurb: string;
  needs: string;
  title: string;
}) {
  return (
    <div
      style={{
        background: "var(--bg-sunken)",
        border: "1px dashed var(--border-strong)",
        borderRadius: "var(--radius-card)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        minHeight: 186,
        padding: 14,
      }}
    >
      <Eyebrow>{title}</Eyebrow>
      <span
        style={{
          color: "var(--text-faint)",
          font: "600 26px/1 var(--font-ui)",
        }}
      >
        —
      </span>
      <p style={{ ...type_.body, font: "400 11px/1.55 var(--font-ui)" }}>
        {blurb}
      </p>
      <div style={{ flex: 1 }} />
      <span
        style={{
          ...type_.meta,
          color: "var(--text-faint)",
          lineHeight: 1.5,
          whiteSpace: "normal",
        }}
      >
        needs {needs}
      </span>
    </div>
  );
}

export function Analytics() {
  const [range, setRange] = useState<Range>(30);
  const [data, setData] = useState<Analytics | null>(null);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setRefused(false);

    fetch(`${BASE_PATH}/api/analytics?days=${range}`)
      .then(async (response) =>
        response.ok ? ((await response.json()) as Analytics) : null
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

  const busiest = data?.days.reduce(
    (best, entry) => (entry.runs > best.runs ? entry : best),
    { day: "", runs: 0 }
  );

  return (
    <div
      style={{
        background: "var(--bg-base)",
        display: "flex",
        flex: 1,
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: hairline,
          display: "flex",
          flex: "none",
          gap: 12,
          minHeight: 48,
          padding: "0 22px",
        }}
      >
        <h2 style={{ ...type_.title, margin: 0 }}>Evidence analytics</h2>
        <span style={type_.meta}>read off run receipts</span>
        <div style={{ flex: 1 }} />
        <fieldset
          aria-label="Range"
          style={{
            background: "var(--bg-panel)",
            border: hairline,
            borderRadius: "var(--radius-pill)",
            display: "flex",
            gap: 4,
            margin: 0,
            padding: 3,
          }}
        >
          {RANGES.map((option) => (
            <button
              aria-pressed={range === option}
              key={option}
              onClick={() => setRange(option)}
              style={{
                background:
                  range === option
                    ? "color-mix(in oklch, var(--accent-presence) 20%, transparent)"
                    : "transparent",
                border: 0,
                borderRadius: "var(--radius-pill)",
                boxShadow:
                  range === option
                    ? "inset 0 0 0 1px color-mix(in oklch, var(--accent-presence) 44%, transparent)"
                    : undefined,
                color:
                  range === option
                    ? "var(--accent-presence)"
                    : "var(--text-secondary)",
                cursor: "pointer",
                font: "500 11px/1 var(--font-mono)",
                height: 22,
                padding: "0 10px",
              }}
              type="button"
            >
              {option}d
            </button>
          ))}
        </fieldset>
      </div>

      <div
        className="oc-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "18px 22px 28px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div
            className="oc-fog oc-card"
            style={{
              background: "var(--bg-sunken)",
              border: hairline,
              borderRadius: "var(--radius-card)",
              display: "flex",
              flexDirection: "column",
              gap: 11,
              padding: 14,
              position: "relative",
            }}
          >
            <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
              <Eyebrow>Runs per day</Eyebrow>
              <div style={{ flex: 1 }} />
              <span style={{ ...type_.meta, ...tabular }}>
                last {range} days
              </span>
            </div>

            {refused ? (
              <p style={{ ...type_.body, font: "400 12px/1.6 var(--font-ui)" }}>
                Run history is not readable on this session. The record is kept
                per account, so it needs a signed-in subscriber.
              </p>
            ) : data ? (
              <>
                <div
                  style={{ alignItems: "baseline", display: "flex", gap: 8 }}
                >
                  <span
                    style={{
                      color: "var(--text-primary)",
                      font: "600 26px/1 var(--font-ui)",
                      ...tabular,
                    }}
                  >
                    {data.total}
                  </span>
                  <span style={{ ...type_.meta, ...tabular }}>
                    {data.total === 1 ? "run" : "runs"} counted
                    {busiest && busiest.runs > 0
                      ? ` · busiest ${shortDay(busiest.day)}`
                      : ""}
                  </span>
                </div>

                <VolumeChart days={data.days} />

                <p
                  style={{
                    ...type_.body,
                    font: "400 11px/1.55 var(--font-ui)",
                  }}
                >
                  A run is counted when an agent starts, whether it succeeds or
                  not — the same row the cap is enforced against, so this and
                  your usage cannot disagree.
                </p>

                <details>
                  <summary
                    style={{
                      ...type_.meta,
                      color: "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    View as a table
                  </summary>
                  <div
                    className="oc-scroll"
                    style={{ marginTop: 8, maxHeight: 220, overflowY: "auto" }}
                  >
                    <table
                      style={{
                        borderCollapse: "collapse",
                        font: "400 11px/1.6 var(--font-mono)",
                        width: "100%",
                      }}
                    >
                      <thead>
                        <tr>
                          <th
                            style={{
                              borderBottom: hairline,
                              color: "var(--text-muted)",
                              fontWeight: 500,
                              padding: "4px 0",
                              textAlign: "left",
                            }}
                          >
                            Day
                          </th>
                          <th
                            style={{
                              borderBottom: hairline,
                              color: "var(--text-muted)",
                              fontWeight: 500,
                              padding: "4px 0",
                              textAlign: "right",
                            }}
                          >
                            Runs
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.days.map((entry) => (
                          <tr key={entry.day}>
                            <td
                              style={{
                                color: "var(--text-secondary)",
                                padding: "3px 0",
                              }}
                            >
                              {entry.day}
                            </td>
                            <td
                              style={{
                                color: "var(--text-primary)",
                                padding: "3px 0",
                                textAlign: "right",
                                ...tabular,
                              }}
                            >
                              {entry.runs}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              <div
                className="oc-shim"
                style={{
                  backgroundColor: "var(--bg-raised)",
                  borderRadius: 6,
                  height: CHART_HEIGHT,
                }}
              />
            )}
          </div>

          <div
            style={{
              display: "grid",
              gap: 14,
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
            }}
          >
            <NotRecorded
              blurb="Whether a run's evidence was accepted is not stored. Nothing on this side records a verification command or its exit code once the run has closed."
              needs="an outcome on the run record"
              title="Accepted evidence"
            />
            <NotRecorded
              blurb="How long a run took, and where the time went, is not stored. The runner reports durations while a run is live; nothing persists them."
              needs="start and finish timestamps per run"
              title="Time to evidence"
            />
            <NotRecorded
              blurb="Why a run stopped is not stored. The reason exists in the run's own record inside the runner, which this account does not archive."
              needs="a stop reason on the run record"
              title="Why runs stopped"
            />
          </div>

          <p
            style={{
              ...type_.body,
              font: "400 11px/1.6 var(--font-ui)",
              maxWidth: "84ch",
            }}
          >
            Three panels above are empty because the data behind them is not
            recorded, not because they are unfinished. The run record stores one
            row per counted run — a tenant, a run id and an instant — which is
            enough to say how many runs happened and when, and nothing about how
            they went.
          </p>
        </div>
      </div>
    </div>
  );
}
