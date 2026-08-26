// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import type { AgentDefinition } from "@opencoven/agent-contracts";
import { Sparkles } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Btn, Eyebrow } from "@/components/console/primitives";
import { hairline, truncate, type as type_ } from "@/components/console/styles";
import { formatAge } from "@/lib/console/format";
import type { ConsoleRun } from "@/lib/console/types";

/**
 * The New run surface.
 *
 * It asks what the run should prove rather than what the agent should do,
 * because the agent runs without approval: the only thing that makes a run
 * reviewable afterwards is having named the evidence beforehand.
 */

const MIN_MISSION = 12;

export function Composer({
  agent,
  blocked,
  draft,
  now,
  onDraft,
  onOpenRun,
  onStart,
  runs,
  starting,
}: {
  agent: AgentDefinition;
  /** Why a run cannot start, or null when it can. */
  blocked: string | null;
  draft: string;
  /** The browser's clock, or 0 before it is known. */
  now: number;
  onDraft: (value: string) => void;
  onOpenRun: (runId: string) => void;
  onStart: () => void;
  runs: ConsoleRun[];
  starting: boolean;
}) {
  const tooShort = draft.trim().length < MIN_MISSION;
  const disabled = tooShort || starting || blocked !== null;

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key === "Enter" &&
      !disabled
    ) {
      event.preventDefault();
      onStart();
    }
  };

  return (
    <div
      className="oc-scroll"
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        padding: "26px 24px",
      }}
    >
      <div style={{ margin: "0 auto", maxWidth: 760 }}>
        <h2 style={{ ...type_.display, marginBottom: 14 }}>
          What should it prove?
        </h2>

        <div
          style={{
            background: "var(--bg-raised)",
            border: "1px solid var(--border-strong)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--shadow-md)",
            overflow: "hidden",
          }}
        >
          <textarea
            aria-label="Mission"
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Describe the outcome and the evidence you would accept…"
            rows={5}
            style={{
              background: "transparent",
              border: 0,
              color: "var(--text-primary)",
              display: "block",
              font: "400 13px/1.65 var(--font-ui)",
              minHeight: 104,
              outline: "none",
              padding: "14px 15px 10px",
              resize: "vertical",
              width: "100%",
            }}
            value={draft}
          />

          <div
            style={{
              alignItems: "center",
              display: "flex",
              flexWrap: "wrap",
              gap: "8px 10px",
              padding: "0 12px 12px",
            }}
          >
            <span
              style={{
                color: "var(--text-muted)",
                font: "400 11px/1 var(--font-mono)",
                ...truncate,
              }}
              title="Set on the agent profile, not per run"
            >
              {[agent.runtime, agent.model, agent.workspace ?? "/workspace"]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <div style={{ flex: 1 }} />
            {blocked ? (
              <span
                style={{
                  color: "var(--danger-text)",
                  font: "400 11px/1.4 var(--font-ui)",
                }}
              >
                {blocked}
              </span>
            ) : null}
            <Btn
              disabled={disabled}
              onClick={onStart}
              title="⌘↵"
              variant={disabled ? "secondary" : "primary"}
            >
              <Sparkles size={13} />
              {starting ? "Starting…" : "Run autonomously"}
            </Btn>
          </div>
        </div>

        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 9,
            marginTop: 22,
          }}
        >
          <Eyebrow
            style={{ color: "var(--text-muted)", letterSpacing: "0.14em" }}
          >
            This session
          </Eyebrow>
          <span
            style={{ background: "var(--border-hairline)", flex: 1, height: 1 }}
          />
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            marginTop: 10,
          }}
        >
          {runs.length === 0 ? (
            <p
              style={{
                ...type_.body,
                color: "var(--text-muted)",
                font: "400 12px/1.55 var(--font-ui)",
              }}
            >
              No runs opened yet for this agent.
            </p>
          ) : (
            runs.map((run) => (
              <button
                className="oc-row oc-rowscope"
                key={run.snapshot.id}
                onClick={() => onOpenRun(run.snapshot.id)}
                style={{
                  alignItems: "center",
                  background: "var(--bg-raised)",
                  border: hairline,
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                  display: "flex",
                  gap: 11,
                  padding: "10px 12px",
                  textAlign: "left",
                  width: "100%",
                }}
                type="button"
              >
                <span
                  style={{
                    color: "var(--text-secondary)",
                    flex: 1,
                    font: "400 13px/1.4 var(--font-ui)",
                    ...truncate,
                  }}
                >
                  {run.snapshot.task}
                </span>
                <span style={type_.meta}>
                  {formatAge(run.snapshot.createdAt, now)}
                </span>
                <span
                  className="oc-reveal"
                  style={{
                    color: "var(--accent-presence)",
                    font: "400 11px/1 var(--font-mono)",
                  }}
                >
                  open →
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
