// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import type { AgentDefinition } from "@opencoven/agent-contracts";
import { Check, ChevronsUpDown, PanelLeft, Plus } from "lucide-react";
import { useState } from "react";
import {
  AccountAvatar,
  Caret,
  StatusDot,
  statusTone,
} from "@/components/console/primitives";
import {
  hairline,
  tabular,
  truncate,
  type as type_,
  well,
} from "@/components/console/styles";
import { formatAge, glyphFor } from "@/lib/console/format";
import type { ConsoleRun } from "@/lib/console/types";

/**
 * Agents, and under the selected one, its runs.
 *
 * The nesting is the point: a run has no meaning apart from the profile that
 * produced it, so the rail refuses to show a flat list of runs the way a chat
 * app shows a flat list of threads.
 */

const RAIL_WIDTH = 268;
const MINI_WIDTH = 58;

type RailProps = {
  agents: AgentDefinition[];
  collapsed: boolean;
  /** The signed-in account's picture, or null when nobody is. */
  avatarSrc: string | null;
  onCreateAgent: () => void;
  onNewRun: (agentId: string) => void;
  onOpenAccount: () => void;
  onSelectAgent: (agentId: string) => void;
  onSelectRun: (runId: string) => void;
  /** The browser's clock, or 0 before it is known. */
  now: number;
  onToggle: () => void;
  runs: ConsoleRun[];
  selectedAgentId: string | null;
  selectedRunId: string | null;
  who: string;
};

function agentTone(agent: AgentDefinition) {
  if (agent.status === "running") {
    return "warning" as const;
  }
  return agent.status === "error" ? ("danger" as const) : ("accent" as const);
}

function AgentGlyph({
  agent,
  selected,
  size,
}: {
  agent: AgentDefinition;
  selected: boolean;
  size?: number;
}) {
  return <span style={well(selected, size)}>{glyphFor(agent.name)}</span>;
}

function MiniRail({
  agents,
  avatarSrc,
  onOpenAccount,
  onSelectAgent,
  onToggle,
  selectedAgentId,
  who,
}: Pick<
  RailProps,
  | "agents"
  | "avatarSrc"
  | "onOpenAccount"
  | "onSelectAgent"
  | "onToggle"
  | "selectedAgentId"
  | "who"
>) {
  return (
    <aside
      aria-label="Navigation, collapsed"
      style={{
        alignItems: "center",
        background: "var(--bg-panel)",
        borderRight: hairline,
        display: "flex",
        flex: "none",
        flexDirection: "column",
        gap: 7,
        padding: "11px 0",
        width: MINI_WIDTH,
      }}
    >
      <button
        aria-label="Expand the navigation"
        className="oc-tint"
        onClick={onToggle}
        style={{
          background: "var(--bg-elevated)",
          border: hairline,
          borderRadius: "var(--radius-control)",
          color: "var(--accent-presence)",
          cursor: "pointer",
          display: "grid",
          flex: "none",
          height: 30,
          placeItems: "center",
          width: 30,
        }}
        title="Expand the navigation"
        type="button"
      >
        <PanelLeft size={15} />
      </button>
      <span
        style={{
          background: "var(--border-hairline)",
          height: 1,
          margin: "3px 0",
          width: 22,
        }}
      />
      <div
        className="oc-scroll"
        style={{
          display: "flex",
          flex: 1,
          flexDirection: "column",
          gap: 7,
          minHeight: 0,
          overflowY: "auto",
          width: "100%",
        }}
      >
        {agents.map((agent) => (
          <button
            aria-label={agent.name}
            className="oc-tint"
            key={agent.id}
            onClick={() => onSelectAgent(agent.id)}
            style={{
              alignSelf: "center",
              background: "transparent",
              border: "1px solid transparent",
              borderRadius: "var(--radius-control)",
              cursor: "pointer",
              display: "grid",
              flex: "none",
              placeItems: "center",
              position: "relative",
            }}
            title={`${agent.name} · ${agent.status}`}
            type="button"
          >
            <AgentGlyph
              agent={agent}
              selected={agent.id === selectedAgentId}
              size={30}
            />
            <span style={{ bottom: -1, position: "absolute", right: -1 }}>
              <StatusDot
                label={agent.status}
                size={6}
                tone={agentTone(agent)}
              />
            </span>
          </button>
        ))}
      </div>
      <button
        aria-label="Account and settings"
        className="oc-tint"
        onClick={onOpenAccount}
        style={{
          background: "var(--bg-raised)",
          border: hairline,
          borderRadius: "var(--radius-pill)",
          color: "var(--text-secondary)",
          cursor: "pointer",
          display: "grid",
          flex: "none",
          font: "500 11px/1 var(--font-mono)",
          height: 28,
          placeItems: "center",
          width: 28,
        }}
        title={who}
        type="button"
      >
        <AccountAvatar size={26} src={avatarSrc} />
      </button>
    </aside>
  );
}

function RuntimeFilter({
  onToggle,
  runtimes,
  selected,
  total,
}: {
  onToggle: (runtime: string) => void;
  runtimes: { count: number; id: string }[];
  selected: Set<string>;
  total: number;
}) {
  const [open, setOpen] = useState(false);
  const label =
    selected.size === 0
      ? "every harness"
      : selected.size === 1
        ? [...selected][0]
        : `${selected.size} harnesses`;

  return (
    <div style={{ position: "relative" }}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="oc-tint"
        onClick={() => setOpen((value) => !value)}
        style={{
          alignItems: "center",
          background: "transparent",
          border: hairline,
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
          display: "flex",
          gap: 6,
          height: 22,
          padding: "0 7px",
        }}
        title="Filter by harness"
        type="button"
      >
        <span
          style={{
            color: "var(--text-secondary)",
            font: "400 10px/1 var(--font-mono)",
            ...truncate,
          }}
        >
          {label}
        </span>
        <span style={{ ...type_.meta, ...tabular }}>{total}</span>
        <Caret open={open} size={9} />
      </button>
      {open ? (
        <>
          <button
            aria-label="Close the harness filter"
            onClick={() => setOpen(false)}
            style={{
              background: "transparent",
              border: 0,
              cursor: "default",
              inset: 0,
              position: "fixed",
              zIndex: 28,
            }}
            type="button"
          />
          <div
            aria-label="Filter by harness"
            aria-multiselectable="true"
            role="listbox"
            style={{
              background: "var(--bg-elevated)",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--shadow-lg)",
              display: "flex",
              flexDirection: "column",
              gap: 2,
              padding: 6,
              position: "absolute",
              right: 0,
              top: 28,
              width: 214,
              zIndex: 30,
            }}
          >
            {runtimes.map((runtime) => (
              <button
                aria-selected={selected.has(runtime.id)}
                className="oc-row"
                key={runtime.id}
                onClick={() => onToggle(runtime.id)}
                role="option"
                style={{
                  alignItems: "center",
                  background: "transparent",
                  border: 0,
                  borderRadius: "var(--radius-control)",
                  cursor: "pointer",
                  display: "flex",
                  gap: 9,
                  padding: "7px 8px",
                  textAlign: "left",
                  width: "100%",
                }}
                type="button"
              >
                <span
                  style={{
                    alignItems: "center",
                    background: selected.has(runtime.id)
                      ? "color-mix(in oklch, var(--accent-presence) 22%, transparent)"
                      : "transparent",
                    border: `1px solid ${
                      selected.has(runtime.id)
                        ? "color-mix(in oklch, var(--accent-presence) 60%, transparent)"
                        : "var(--border-hairline)"
                    }`,
                    borderRadius: 4,
                    color: "var(--accent-presence)",
                    display: "grid",
                    flex: "none",
                    height: 14,
                    placeItems: "center",
                    width: 14,
                  }}
                >
                  {selected.has(runtime.id) ? <Check size={10} /> : null}
                </span>
                <span
                  style={{
                    color: "var(--text-primary)",
                    flex: 1,
                    font: "400 12px/1.3 var(--font-ui)",
                    ...truncate,
                  }}
                >
                  {runtime.id}
                </span>
                <span style={{ ...type_.meta, ...tabular }}>
                  {runtime.count}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function AgentRail(props: RailProps) {
  const [filter, setFilter] = useState<Set<string>>(new Set());

  if (props.collapsed) {
    return <MiniRail {...props} />;
  }

  const runtimes = [...new Set(props.agents.map((agent) => agent.runtime))]
    .sort()
    .map((runtime) => ({
      count: props.agents.filter((agent) => agent.runtime === runtime).length,
      id: runtime,
    }));

  const visible =
    filter.size === 0
      ? props.agents
      : props.agents.filter((agent) => filter.has(agent.runtime));

  const toggleRuntime = (runtime: string) => {
    setFilter((current) => {
      const next = new Set(current);
      if (next.has(runtime)) {
        next.delete(runtime);
      } else {
        next.add(runtime);
      }
      return next;
    });
  };

  return (
    <aside
      style={{
        background: "var(--bg-panel)",
        borderRight: hairline,
        display: "flex",
        flex: "none",
        flexDirection: "column",
        width: RAIL_WIDTH,
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          flex: "none",
          gap: 10,
          padding: "12px 12px 6px",
        }}
      >
        <span
          style={{
            ...well(false, 30),
            color: "var(--accent-presence)",
            fontSize: 13,
          }}
        >
          ◆
        </span>
        <span
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            gap: 3,
            minWidth: 0,
          }}
        >
          <span style={type_.title}>OpenCoven</span>
          <span style={type_.meta}>Control plane</span>
        </span>
        <button
          aria-label="Collapse the navigation"
          className="oc-tint"
          onClick={props.onToggle}
          style={{
            background: "transparent",
            border: "1px solid transparent",
            borderRadius: "var(--radius-control)",
            color: "var(--text-muted)",
            cursor: "pointer",
            display: "grid",
            flex: "none",
            height: 26,
            placeItems: "center",
            width: 26,
          }}
          title="Collapse the navigation"
          type="button"
        >
          <PanelLeft size={15} />
        </button>
      </div>

      <div
        className="oc-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "2px 8px 10px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 8,
            padding: "12px 9px 6px",
          }}
        >
          <span
            style={{
              color: "var(--text-muted)",
              font: "400 11px/1 var(--font-ui)",
            }}
          >
            Agents
          </span>
          <div style={{ flex: 1 }} />
          {runtimes.length > 1 ? (
            <RuntimeFilter
              onToggle={toggleRuntime}
              runtimes={runtimes}
              selected={filter}
              total={visible.length}
            />
          ) : (
            <span style={{ ...type_.meta, ...tabular }}>{visible.length}</span>
          )}
        </div>

        {visible.map((agent) => {
          const isOpen = agent.id === props.selectedAgentId;
          const agentRuns = props.runs.filter(
            (run) => run.agentId === agent.id
          );

          return (
            <div key={agent.id} style={{ marginBottom: 2 }}>
              <button
                aria-expanded={isOpen}
                className="oc-row oc-rowscope"
                onClick={() => props.onSelectAgent(agent.id)}
                style={{
                  alignItems: "center",
                  background: isOpen
                    ? "color-mix(in oklch, var(--accent-presence) 12%, transparent)"
                    : "transparent",
                  border: 0,
                  borderRadius: "var(--radius-md)",
                  cursor: "pointer",
                  display: "flex",
                  gap: 8,
                  padding: "8px 8px",
                  textAlign: "left",
                  width: "100%",
                }}
                type="button"
              >
                <Caret open={isOpen} size={10} />
                <AgentGlyph agent={agent} selected={isOpen} />
                <span
                  style={{
                    display: "flex",
                    flex: 1,
                    flexDirection: "column",
                    gap: 2,
                    minWidth: 0,
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{ ...type_.title, lineHeight: 1.2, ...truncate }}
                  >
                    {agent.name}
                  </span>
                  <span
                    style={{
                      alignItems: "center",
                      color: "var(--text-muted)",
                      display: "flex",
                      font: "400 10px/1.2 var(--font-mono)",
                      gap: 5,
                      ...truncate,
                    }}
                  >
                    <span style={{ color: "var(--text-secondary)" }}>
                      {agent.runtime}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{formatAge(agent.lastRunAt, props.now)}</span>
                  </span>
                </span>
                <StatusDot
                  label={agent.status}
                  size={6}
                  tone={agentTone(agent)}
                />
              </button>

              {isOpen ? (
                <div
                  style={{
                    borderLeft: hairline,
                    display: "flex",
                    flexDirection: "column",
                    gap: 1,
                    marginLeft: 25,
                    padding: "4px 0 8px 14px",
                  }}
                >
                  <button
                    className="oc-row"
                    onClick={() => props.onNewRun(agent.id)}
                    style={{
                      alignItems: "center",
                      background: "transparent",
                      border: 0,
                      borderRadius: "var(--radius-sm)",
                      color: "var(--accent-presence)",
                      cursor: "pointer",
                      display: "flex",
                      gap: 8,
                      padding: "6px 8px",
                      textAlign: "left",
                      width: "100%",
                    }}
                    type="button"
                  >
                    <span
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 12,
                      }}
                    >
                      <Plus size={11} />
                    </span>
                    <span
                      style={{
                        font: "500 12px/1.3 var(--font-ui)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      New run
                    </span>
                  </button>

                  {agentRuns.length === 0 ? (
                    <p
                      style={{
                        ...type_.body,
                        color: "var(--text-muted)",
                        font: "400 11px/1.5 var(--font-ui)",
                        padding: "4px 8px 2px",
                      }}
                    >
                      Runs you start appear here. The runner keeps the record;
                      this list is what this session has opened.
                    </p>
                  ) : (
                    agentRuns.map((run) => (
                      <button
                        className="oc-row"
                        key={run.snapshot.id}
                        onClick={() => props.onSelectRun(run.snapshot.id)}
                        style={{
                          alignItems: "center",
                          background:
                            run.snapshot.id === props.selectedRunId
                              ? "var(--bg-raised)"
                              : "transparent",
                          border: 0,
                          borderRadius: "var(--radius-sm)",
                          cursor: "pointer",
                          display: "flex",
                          gap: 8,
                          padding: "7px 8px",
                          textAlign: "left",
                          width: "100%",
                        }}
                        type="button"
                      >
                        <StatusDot
                          label={run.snapshot.status}
                          size={6}
                          tone={statusTone(run.snapshot.status)}
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
                          <span
                            style={{
                              color: "var(--text-secondary)",
                              font: "400 12px/1.35 var(--font-ui)",
                              ...truncate,
                            }}
                          >
                            {run.snapshot.task}
                          </span>
                          <span style={type_.meta}>
                            {formatAge(run.snapshot.createdAt, props.now)}
                          </span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}
            </div>
          );
        })}

        {props.agents.length === 0 ? (
          <p
            style={{
              ...type_.body,
              color: "var(--text-muted)",
              font: "400 12px/1.55 var(--font-ui)",
              padding: "10px 9px",
            }}
          >
            No profiles yet. An agent is an execution contract — forge one to
            start a run.
          </p>
        ) : null}
      </div>

      <div style={{ borderTop: hairline, flex: "none", padding: "8px 10px" }}>
        <button
          className="oc-newagent"
          onClick={props.onCreateAgent}
          style={{
            alignItems: "center",
            background: "transparent",
            border:
              "1px dashed color-mix(in oklch, var(--accent-presence) 45%, transparent)",
            borderRadius: "var(--radius-md)",
            color: "var(--accent-presence)",
            cursor: "pointer",
            display: "flex",
            gap: 9,
            padding: "8px 9px",
            textAlign: "left",
            transition:
              "background var(--duration-fast) var(--ease-standard), border-color var(--duration-fast) var(--ease-standard)",
            width: "100%",
          }}
          type="button"
        >
          <span
            style={{
              border:
                "1px dashed color-mix(in oklch, var(--accent-presence) 55%, transparent)",
              borderRadius: "var(--radius-control)",
              display: "grid",
              flex: "none",
              height: 24,
              placeItems: "center",
              width: 24,
            }}
          >
            <Plus size={12} />
          </span>
          <span style={{ font: "500 12px/1.2 var(--font-ui)" }}>New agent</span>
        </button>
      </div>

      <button
        className="oc-row"
        onClick={props.onOpenAccount}
        style={{
          alignItems: "center",
          background: "var(--bg-sunken)",
          border: 0,
          borderTop: hairline,
          cursor: "pointer",
          display: "flex",
          flex: "none",
          gap: 10,
          padding: "10px 12px",
          textAlign: "left",
          width: "100%",
        }}
        type="button"
      >
        <span
          style={{
            ...well(false, 28),
            borderRadius: "var(--radius-pill)",
          }}
        >
          <AccountAvatar size={28} src={props.avatarSrc} />
        </span>
        <span
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            gap: 2,
            minWidth: 0,
          }}
        >
          <span style={{ ...type_.label, ...truncate }}>{props.who}</span>
          <span style={type_.meta}>
            {props.agents.length} profiles · {props.runs.length} runs open
          </span>
        </span>
        <ChevronsUpDown color="var(--text-muted)" size={13} />
      </button>
    </aside>
  );
}
