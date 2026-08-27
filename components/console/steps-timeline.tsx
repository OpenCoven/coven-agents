// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Caret } from "@/components/console/primitives";
import {
  hairline,
  tabular,
  toneInk,
  truncate,
  type as type_,
} from "@/components/console/styles";
import type { Step } from "@/lib/console/blocks";

/**
 * One row per thing the agent did.
 *
 * The thread is the argument; this is the index. It exists so a reader who
 * knows a run made four commands can find the third one without scrolling
 * through the prose between them.
 */

const MIN_WIDTH = 200;
const MAX_WIDTH = 460;
const DEFAULT_WIDTH = 268;
const KEY_STEP = 16;

const TONE_GUTTER: Record<Step["tone"], string> = {
  danger: toneInk("danger"),
  muted: "var(--border-strong)",
  running: toneInk("warning"),
  success: toneInk("success"),
};

export function StepsTimeline({
  collapsed,
  elapsed,
  onOpenAnalytics,
  onJump,
  onToggle,
  running,
  selectedBlockId,
  steps,
}: {
  collapsed: boolean;
  elapsed: string;
  onJump: (blockId: string) => void;
  onOpenAnalytics: () => void;
  onToggle: () => void;
  running: boolean;
  selectedBlockId: string | null;
  steps: Step[];
}) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  /**
   * Rich by default: the rail opens showing each step's body lines, and one
   * toggle collapses the whole index back to single-line entries. Expanded
   * first, because the reader who opens this panel is looking for what
   * happened, not for how compact the list can be.
   */
  const [rich, setRich] = useState(true);
  const dragFrom = useRef<{ startWidth: number; startX: number } | null>(null);

  const onPointerMove = useCallback((event: PointerEvent) => {
    const from = dragFrom.current;
    if (!from) {
      return;
    }
    // The panel is on the right, so dragging left widens it.
    const next = from.startWidth + (from.startX - event.clientX);
    setWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
  }, []);

  useEffect(() => {
    const stop = () => {
      dragFrom.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stop);
    };
  }, [onPointerMove]);

  if (collapsed) {
    return (
      <button
        aria-expanded={false}
        aria-label="Expand the steps panel"
        className="oc-strip"
        onClick={onToggle}
        style={{
          alignItems: "center",
          background: "var(--bg-panel)",
          border: 0,
          borderLeft: hairline,
          cursor: "pointer",
          display: "flex",
          flex: "none",
          flexDirection: "column",
          gap: 9,
          padding: "10px 0",
          transition: "background var(--duration-fast) var(--ease-standard)",
          width: 28,
        }}
        title="Expand steps"
        type="button"
      >
        <Caret open={false} size={11} style={{ transform: "rotate(90deg)" }} />
        <span
          style={{
            ...type_.eyebrow,
            letterSpacing: "0.14em",
            writingMode: "vertical-rl",
          }}
        >
          Steps
        </span>
        <span
          style={{
            ...type_.meta,
            ...tabular,
            writingMode: "vertical-rl",
          }}
        >
          {steps.length}
        </span>
      </button>
    );
  }

  return (
    <aside
      style={{
        background: "var(--bg-panel)",
        borderLeft: hairline,
        display: "flex",
        flex: "none",
        flexDirection: "column",
        position: "relative",
        width,
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: role="separator" here is the ARIA splitter pattern — a focusable, resizable divider — not the thematic break an <hr> means. */}
      <div
        aria-label="Resize the steps panel"
        aria-orientation="vertical"
        aria-valuemax={MAX_WIDTH}
        aria-valuemin={MIN_WIDTH}
        aria-valuenow={width}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            setWidth((value) => Math.min(MAX_WIDTH, value + KEY_STEP));
          }
          if (event.key === "ArrowRight") {
            setWidth((value) => Math.max(MIN_WIDTH, value - KEY_STEP));
          }
        }}
        onPointerDown={(event) => {
          dragFrom.current = { startWidth: width, startX: event.clientX };
        }}
        role="separator"
        style={{
          bottom: 0,
          cursor: "col-resize",
          left: -3,
          position: "absolute",
          top: 0,
          width: 7,
          zIndex: 6,
        }}
        tabIndex={0}
        title="Drag, or use the arrow keys, to resize"
      />

      <div
        style={{
          alignItems: "center",
          borderBottom: hairline,
          display: "flex",
          flex: "none",
          gap: 8,
          height: 44,
          padding: "0 9px 0 13px",
        }}
      >
        <span style={type_.eyebrow}>Steps</span>
        <div style={{ flex: 1 }} />
        <span style={{ ...type_.meta, ...tabular }}>{steps.length}</span>
        <button
          aria-pressed={rich}
          onClick={() => setRich((current) => !current)}
          style={{
            background: "transparent",
            border: 0,
            color: rich ? "var(--accent-presence)" : "var(--text-muted)",
            cursor: "pointer",
            font: "500 10px/1 var(--font-mono)",
            padding: 0,
          }}
          title={
            rich
              ? "Collapse steps to one line each"
              : "Expand steps to show what each one did"
          }
          type="button"
        >
          {rich ? "collapse" : "expand"}
        </button>
        <button
          aria-label="Collapse the steps panel"
          className="oc-tint"
          onClick={onToggle}
          style={{
            background: "transparent",
            border: "1px solid transparent",
            borderRadius: "var(--radius-control)",
            cursor: "pointer",
            display: "grid",
            flex: "none",
            height: 24,
            placeItems: "center",
            width: 24,
          }}
          title="Collapse steps"
          type="button"
        >
          <Caret
            open={false}
            size={11}
            style={{ transform: "rotate(90deg)" }}
          />
        </button>
      </div>

      <div
        className="oc-scroll"
        style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 6 }}
      >
        {steps.map((step) => (
          <button
            className="oc-row"
            key={step.id}
            onClick={() => onJump(step.blockId)}
            style={{
              alignItems: "flex-start",
              background:
                step.blockId === selectedBlockId
                  ? "var(--bg-raised)"
                  : "transparent",
              border: 0,
              borderRadius: "var(--radius-sm)",
              cursor: "pointer",
              display: "flex",
              gap: 9,
              padding: "8px 9px",
              textAlign: "left",
              width: "100%",
            }}
            type="button"
          >
            <span
              style={{
                background: TONE_GUTTER[step.tone],
                borderRadius: 2,
                flex: "none",
                height: 26,
                marginTop: 1,
                width: 3,
              }}
            />
            <span
              style={{
                display: "flex",
                flex: 1,
                flexDirection: "column",
                gap: 3,
                minWidth: 0,
                textAlign: "left",
              }}
            >
              <span style={{ ...type_.label, ...truncate }}>{step.label}</span>
              <span
                style={{
                  color: "var(--text-muted)",
                  font: "400 10px/1.35 var(--font-mono)",
                  ...truncate,
                }}
              >
                {step.detail}
              </span>
              {rich && step.expanded.length > 1 ? (
                <span
                  style={{
                    borderLeft: "2px solid var(--border-hairline)",
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    marginTop: 3,
                    paddingLeft: 7,
                  }}
                >
                  {step.expanded.map((line, index) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: the lines are a fixed excerpt of one immutable step; they never reorder.
                      key={`${step.id}-x${index}`}
                      style={{
                        color: "var(--text-faint)",
                        font: "400 10px/1.4 var(--font-mono)",
                        ...truncate,
                      }}
                    >
                      {line}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
            <span style={{ ...type_.meta, ...tabular, flex: "none" }}>
              {step.duration}
            </span>
          </button>
        ))}

        {running ? (
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 8,
              padding: "9px 10px",
            }}
          >
            <span
              className="oc-shim"
              style={{
                backgroundColor: "var(--bg-raised)",
                borderRadius: 2,
                height: 26,
                width: 3,
              }}
            />
            <span
              className="oc-shim"
              style={{
                backgroundColor: "var(--bg-raised)",
                borderRadius: 999,
                flex: 1,
                height: 9,
              }}
            />
          </div>
        ) : null}

        {steps.length === 0 && !running ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 7,
              padding: "14px 11px",
            }}
          >
            <span
              style={{
                color: "var(--text-secondary)",
                font: "500 11px/1.3 var(--font-ui)",
              }}
            >
              No steps yet
            </span>
            <span
              style={{
                color: "var(--text-secondary)",
                font: "400 11px/1.55 var(--font-ui)",
              }}
            >
              Steps appear here as the agent works — one row per command, edit,
              and report.
            </span>
          </div>
        ) : null}
      </div>

      <button
        aria-label="Wall clock — open evidence analytics"
        className="oc-strip"
        onClick={onOpenAnalytics}
        style={{
          background: "var(--bg-sunken)",
          border: 0,
          borderTop: hairline,
          cursor: "pointer",
          display: "flex",
          flex: "none",
          flexDirection: "column",
          gap: 6,
          padding: "10px 13px",
          textAlign: "left",
          width: "100%",
        }}
        title="Open evidence analytics"
        type="button"
      >
        <div
          style={{
            alignItems: "baseline",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span style={{ ...type_.eyebrow, color: "var(--text-muted)" }}>
            Wall clock
          </span>
          <span
            style={{
              color: "var(--text-primary)",
              font: "500 12px/1 var(--font-mono)",
              ...tabular,
            }}
          >
            {elapsed}
          </span>
        </div>
        {/* Indeterminate while the run is in flight. The runner publishes no
            step count, so a percentage here would be invented. */}
        <div
          aria-label="Run progress"
          aria-valuetext={running ? "in progress" : "finished"}
          role="progressbar"
          style={{
            background: "var(--bg-elevated)",
            borderRadius: 999,
            height: 4,
            overflow: "hidden",
          }}
        >
          <div
            className={running ? "oc-shim" : undefined}
            style={{
              background: running
                ? "var(--bg-elevated)"
                : "var(--accent-presence)",
              borderRadius: 999,
              height: "100%",
              width: "100%",
            }}
          />
        </div>
      </button>
    </aside>
  );
}
