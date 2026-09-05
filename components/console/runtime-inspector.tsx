// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import {
  type AgentDefinition,
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { X } from "lucide-react";
import { useState } from "react";
import { Caret, Eyebrow } from "@/components/console/primitives";
import {
  hairline,
  pill,
  truncate,
  type as type_,
} from "@/components/console/styles";

/**
 * What this run is bounded by.
 *
 * Every row is read off the stored definition rather than off a form the user
 * last saw. A profile edited in another tab shows its real contract here, which
 * is the point of a panel called Runtime.
 */

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div
      style={{
        alignItems: "center",
        borderBottom: hairline,
        display: "flex",
        gap: 12,
        padding: "7px 0",
      }}
    >
      <span
        style={{
          color: "var(--text-muted)",
          flex: "none",
          font: "400 11px/1 var(--font-mono)",
          whiteSpace: "nowrap",
        }}
      >
        {k}
      </span>
      <div style={{ flex: 1 }} />
      <span
        style={{
          color: "var(--text-primary)",
          font: "400 11px/1 var(--font-mono)",
          ...truncate,
        }}
        title={v}
      >
        {v}
      </span>
    </div>
  );
}

export function RuntimeInspector({
  agent,
  onClose,
}: {
  agent: AgentDefinition;
  onClose: () => void;
}) {
  const [contractOpen, setContractOpen] = useState(false);

  return (
    <aside
      aria-label="Runtime — configuration for this run"
      style={{
        background: "var(--bg-panel)",
        borderLeft: "1px solid var(--border-strong)",
        bottom: 0,
        boxShadow: "var(--shadow-lg)",
        display: "flex",
        flexDirection: "column",
        position: "absolute",
        right: 0,
        top: 0,
        width: 320,
        zIndex: 46,
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: hairline,
          display: "flex",
          flex: "none",
          height: 44,
          justifyContent: "space-between",
          padding: "0 13px",
        }}
      >
        <span
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 3,
            minWidth: 0,
          }}
        >
          <Eyebrow>Runtime</Eyebrow>
          <span
            style={{
              color: "var(--text-muted)",
              font: "400 10px/1 var(--font-ui)",
              whiteSpace: "nowrap",
            }}
          >
            Configuration for this run
          </span>
        </span>
        <button
          aria-label="Close runtime"
          className="oc-tint"
          onClick={onClose}
          style={{
            background: "transparent",
            border: "1px solid transparent",
            borderRadius: "var(--radius-control)",
            color: "var(--text-secondary)",
            cursor: "pointer",
            display: "grid",
            flex: "none",
            height: 28,
            placeItems: "center",
            width: 28,
          }}
          title="Close runtime"
          type="button"
        >
          <X size={13} />
        </button>
      </div>

      <div
        className="oc-scroll"
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          minHeight: 0,
          overflowY: "auto",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 9,
            padding: "12px 14px 13px",
          }}
        >
          <Eyebrow>Execution profile</Eyebrow>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <Row k="harness" v={agent.runtime} />
            <Row k="model" v={sanitizeEvidenceText(agent.model)} />
            <Row k="backend" v={agent.backend} />
            <Row
              k="workspace"
              v={sanitizeEvidencePath(agent.workspace ?? "/workspace")}
            />
            <Row k="approvals" v="none" />
          </div>
          <p style={{ ...type_.body, font: "400 11px/1.5 var(--font-ui)" }}>
            {agent.description
              ? sanitizeEvidenceText(agent.description)
              : "No description. The operating contract below is what actually governs the run."}
          </p>
        </div>

        <div
          style={{
            borderTop: hairline,
            display: "flex",
            flexDirection: "column",
            gap: 7,
            padding: "12px 14px 13px",
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
            {/* No health dot here. This panel reads the stored definition and
                receives no sandbox status, so a green dot asserted a liveness
                nothing had checked. */}
            <Eyebrow>Boundary</Eyebrow>
            <div style={{ flex: 1 }} />
            <span style={type_.meta}>Daytona sandbox</span>
          </div>
          <p style={{ ...type_.body, font: "400 11px/1.55 var(--font-ui)" }}>
            Each agent has one tenant-scoped persistent workspace. Runs use
            short-lived process sessions inside it; nothing executes on your
            machine.
          </p>
        </div>

        <div
          style={{
            borderTop: hairline,
            display: "flex",
            flexDirection: "column",
            gap: 9,
            padding: "12px 14px 13px",
          }}
        >
          <button
            aria-expanded={contractOpen}
            onClick={() => setContractOpen((value) => !value)}
            style={{
              alignItems: "center",
              background: "transparent",
              border: 0,
              cursor: "pointer",
              display: "flex",
              gap: 8,
              padding: 0,
              textAlign: "left",
              width: "100%",
            }}
            type="button"
          >
            <Caret open={contractOpen} />
            <Eyebrow>Operating contract</Eyebrow>
            <div style={{ flex: 1 }} />
            <span
              style={{
                color: "var(--accent-presence)",
                font: "400 10px/1 var(--font-mono)",
                whiteSpace: "nowrap",
              }}
            >
              {agent.instructions.length} chars
            </span>
          </button>
          {contractOpen ? (
            <pre
              className="oc-scroll"
              style={{
                background: "var(--bg-sunken)",
                border: hairline,
                borderRadius: "var(--radius-md)",
                color: "var(--text-secondary)",
                font: "400 11px/1.6 var(--font-ui)",
                margin: 0,
                maxHeight: 260,
                overflow: "auto",
                padding: "10px 11px",
                whiteSpace: "pre-wrap",
              }}
            >
              {sanitizeEvidenceText(agent.instructions)}
            </pre>
          ) : null}
        </div>

        <div
          style={{
            borderTop: hairline,
            display: "flex",
            flexDirection: "column",
            gap: 7,
            padding: "12px 14px 14px",
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 9 }}>
            <button
              aria-checked={false}
              aria-label="Pause and ask — not available yet"
              disabled
              role="switch"
              style={{
                background: "var(--bg-panel)",
                border: "1px dashed var(--border-strong)",
                borderRadius: 999,
                cursor: "not-allowed",
                flex: "none",
                height: 15,
                padding: 0,
                position: "relative",
                width: 26,
              }}
              title="Not available yet"
              type="button"
            >
              <span
                style={{
                  background: "var(--text-faint)",
                  borderRadius: 999,
                  height: 9,
                  left: 2,
                  position: "absolute",
                  top: 2,
                  width: 9,
                }}
              />
            </button>
            <Eyebrow>Pause and ask</Eyebrow>
            <div style={{ flex: 1 }} />
            <span style={pill("muted")}>Proposed</span>
          </div>
          <p style={{ ...type_.body, font: "400 11px/1.55 var(--font-ui)" }}>
            Stop and ask instead of guessing on an ambiguous mission.{" "}
            <span style={{ color: "var(--text-muted)" }}>
              Not built — today it states its assumption and continues, in the
              record.
            </span>
          </p>
        </div>
      </div>
    </aside>
  );
}
