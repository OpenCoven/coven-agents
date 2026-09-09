// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import {
  type AgentDefinition,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { ChevronsUpDown, PanelLeft, Plus, Search } from "lucide-react";
import { useRef, useState } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { FamiliarPortrait } from "@/components/console/familiar-portrait";
import {
  AccountAvatar,
  StatusDot,
  statusTone,
} from "@/components/console/primitives";
import {
  hairline,
  truncate,
  type as type_,
  well,
} from "@/components/console/styles";
import { executionProfileForAgent } from "@/lib/console/agent-profile";
import { formatAge } from "@/lib/console/format";
import type { ConsoleRun } from "@/lib/console/types";

/**
 * Agents, and under the selected one, its runs.
 *
 * The nesting is the point: a run has no meaning apart from the profile that
 * produced it, so the rail refuses to show a flat list of runs the way a chat
 * app shows a flat list of threads.
 */

export const AGENT_RAIL_WIDTHS = {
  collapsed: 58,
  default: 296,
  max: 420,
  min: 248,
} as const;

const KEY_STEP = 16;
const AGENT_SECTIONS = [
  { id: "active", label: "Active" },
  { id: "profiles", label: "Profiles" },
  { id: "attention", label: "Needs attention" },
] as const;

type AgentSectionId = (typeof AGENT_SECTIONS)[number]["id"];

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
  onWidthChange: (width: number) => void;
  /** The browser's clock, or 0 before it is known. */
  now: number;
  onToggle: () => void;
  failedRunHistoryAgentIds: ReadonlySet<string>;
  pendingRunHistoryAgentIds: ReadonlySet<string>;
  runs: ConsoleRun[];
  selectedAgentId: string | null;
  selectedRunId: string | null;
  width: number;
  widthLimit: number;
  who: string;
};

function agentTone(agent: AgentDefinition) {
  if (agent.status === "running") {
    return "warning" as const;
  }
  // Idle is dim, deliberately. The accent is identity — the brand, the
  // selected row — and an idle agent wearing it read as a third state nobody
  // could name. A never-run agent is idle, full stop.
  return agent.status === "error" ? ("danger" as const) : ("muted" as const);
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
  const profile = executionProfileForAgent(agent);
  return (
    <FamiliarPortrait
      fallbackLabel={sanitizeEvidenceText(agent.name)}
      familiarId={agent.familiarId}
      profileId={profile.id}
      selected={selected}
      size={size}
    />
  );
}

function sectionForAgent(agent: AgentDefinition): AgentSectionId {
  if (agent.status === "running") {
    return "active";
  }
  return agent.status === "error" ? "attention" : "profiles";
}

function matchesRailQuery(
  agent: AgentDefinition,
  agentRuns: ConsoleRun[],
  query: string
): boolean {
  if (!query) {
    return true;
  }

  return [
    agent.name,
    agent.description,
    agent.runtime,
    ...agentRuns.map((run) => run.snapshot.task),
  ]
    .map((value) => sanitizeEvidenceText(value).toLocaleLowerCase())
    .some((value) => value.includes(query));
}

function disambiguatedLabel(
  agent: AgentDefinition,
  agents: AgentDefinition[],
  labelFor: (candidate: AgentDefinition) => string
): string {
  const label = labelFor(agent);
  const matches = agents.filter((candidate) => labelFor(candidate) === label);
  if (matches.length < 2) {
    return label;
  }
  return `${label}, profile ${matches.findIndex((candidate) => candidate.id === agent.id) + 1} of ${matches.length}`;
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
      className="oc-agent-mini-rail"
      style={{
        alignItems: "center",
        background: "var(--bg-panel)",
        borderRight: hairline,
        display: "flex",
        flex: "none",
        flexDirection: "column",
        gap: 7,
        padding: "11px 0",
        width: AGENT_RAIL_WIDTHS.collapsed,
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
            aria-label={disambiguatedLabel(
              agent,
              agents,
              (candidate) =>
                `${sanitizeEvidenceText(candidate.name)}, ${candidate.runtime}, ${candidate.status}`
            )}
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
            title={`${sanitizeEvidenceText(agent.name)} · ${agent.status}`}
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

export function AgentRail(props: RailProps) {
  const [query, setQuery] = useState("");
  const dragFrom = useRef<{
    pointerId: number;
    startWidth: number;
    startX: number;
  } | null>(null);

  if (props.collapsed) {
    return <MiniRail {...props} />;
  }

  const minWidth = Math.min(AGENT_RAIL_WIDTHS.min, props.widthLimit);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const runsByAgent = new Map<string, ConsoleRun[]>();
  for (const run of props.runs) {
    const agentRuns = runsByAgent.get(run.agentId) ?? [];
    agentRuns.push(run);
    runsByAgent.set(run.agentId, agentRuns);
  }
  for (const agentRuns of runsByAgent.values()) {
    agentRuns.sort(
      (left, right) =>
        Date.parse(right.snapshot.createdAt) -
        Date.parse(left.snapshot.createdAt)
    );
  }

  const sections = AGENT_SECTIONS.map((section) => ({
    ...section,
    agents: props.agents.filter((agent) => {
      const agentRuns = runsByAgent.get(agent.id) ?? [];
      return (
        sectionForAgent(agent) === section.id &&
        matchesRailQuery(agent, agentRuns, normalizedQuery)
      );
    }),
  })).filter((section) => section.agents.length > 0);
  const visibleCount = sections.reduce(
    (count, section) => count + section.agents.length,
    0
  );

  return (
    <aside
      aria-label="Navigation"
      className="oc-agent-rail"
      id="agent-navigation-rail"
      style={{
        background: "var(--bg-panel)",
        borderRight: hairline,
        display: "flex",
        flex: "none",
        flexDirection: "column",
        width: props.width,
      }}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: role="separator" is the ARIA splitter pattern for a focusable resize handle. */}
      <div
        aria-controls="agent-navigation-rail"
        aria-label="Resize the navigation rail"
        aria-orientation="vertical"
        aria-valuemax={props.widthLimit}
        aria-valuemin={minWidth}
        aria-valuenow={props.width}
        onKeyDown={(event) => {
          if (event.key === "Home") {
            props.onWidthChange(minWidth);
          }
          if (event.key === "End") {
            props.onWidthChange(props.widthLimit);
          }
          if (event.key === "ArrowLeft") {
            props.onWidthChange(Math.max(minWidth, props.width - KEY_STEP));
          }
          if (event.key === "ArrowRight") {
            props.onWidthChange(
              Math.min(props.widthLimit, props.width + KEY_STEP)
            );
          }
        }}
        onLostPointerCapture={(event) => {
          if (dragFrom.current?.pointerId === event.pointerId) {
            dragFrom.current = null;
          }
        }}
        onPointerCancel={(event) => {
          if (dragFrom.current?.pointerId === event.pointerId) {
            dragFrom.current = null;
          }
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          dragFrom.current = {
            pointerId: event.pointerId,
            startWidth: props.width,
            startX: event.clientX,
          };
        }}
        onPointerMove={(event) => {
          const from = dragFrom.current;
          if (!from || from.pointerId !== event.pointerId) {
            return;
          }
          const next = from.startWidth + (event.clientX - from.startX);
          props.onWidthChange(
            Math.min(props.widthLimit, Math.max(minWidth, next))
          );
        }}
        onPointerUp={(event) => {
          if (dragFrom.current?.pointerId === event.pointerId) {
            dragFrom.current = null;
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        role="separator"
        style={{
          bottom: 0,
          cursor: "col-resize",
          position: "absolute",
          right: -3,
          top: 0,
          touchAction: "none",
          width: 7,
          zIndex: 6,
        }}
        tabIndex={0}
        title="Drag, or use the arrow keys, to resize"
      />

      <div className="oc-agent-rail__header">
        <span className="oc-agent-rail__identity">
          <span className="oc-agent-rail__brand">
            <BrandMark style={{ height: 14, width: 15 }} />
          </span>
          <span>
            <span className="oc-agent-rail__title">OpenCoven</span>
            <span className="oc-agent-rail__subtitle">Execution profiles</span>
          </span>
        </span>
        <button
          aria-label="New agent"
          className="oc-tint oc-agent-rail__action"
          onClick={props.onCreateAgent}
          title="New agent"
          type="button"
        >
          <Plus size={15} />
        </button>
        <button
          aria-label="Collapse the navigation"
          className="oc-tint oc-agent-rail__action"
          onClick={props.onToggle}
          title="Collapse the navigation"
          type="button"
        >
          <PanelLeft size={15} />
        </button>
      </div>

      <search className="oc-agent-rail__search">
        <Search aria-hidden="true" size={14} />
        <input
          aria-label="Search profiles and runs"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search profiles and runs"
          type="search"
          value={query}
        />
      </search>

      <div
        className="oc-scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "6px 8px 14px",
        }}
      >
        <div>
          {sections.flatMap((section) => [
            <h2
              className="oc-agent-group__heading"
              key={`section-${section.id}`}
            >
              <span>{section.label}</span>
              <span>{section.agents.length}</span>
            </h2>,
            ...section.agents.map((agent) => {
              const isOpen = agent.id === props.selectedAgentId;
              const agentRuns = runsByAgent.get(agent.id) ?? [];
              const historyFailed = props.failedRunHistoryAgentIds.has(
                agent.id
              );
              const historyPending = props.pendingRunHistoryAgentIds.has(
                agent.id
              );
              const [latestRun] = agentRuns;
              const preview = sanitizeEvidenceText(
                latestRun?.snapshot.task ||
                  agent.description ||
                  `${agent.runtime} execution profile`
              );
              const recency = latestRun?.snapshot.createdAt ?? agent.lastRunAt;
              const name = sanitizeEvidenceText(agent.name);
              const accessibleLabel = disambiguatedLabel(
                agent,
                props.agents,
                (candidate) => {
                  const candidateRuns = runsByAgent.get(candidate.id) ?? [];
                  const [candidateLatestRun] = candidateRuns;
                  const candidatePreview = sanitizeEvidenceText(
                    candidateLatestRun?.snapshot.task ||
                      candidate.description ||
                      `${candidate.runtime} execution profile`
                  );
                  return `${sanitizeEvidenceText(candidate.name)}, ${candidatePreview}, ${candidate.runtime}, ${candidate.status}`;
                }
              );

              return (
                <div className="oc-agent-conversation" key={agent.id}>
                  <button
                    aria-expanded={isOpen}
                    aria-label={accessibleLabel}
                    className="oc-row oc-agent-conversation__button"
                    data-selected={isOpen ? "true" : "false"}
                    onClick={() => props.onSelectAgent(agent.id)}
                    type="button"
                  >
                    <span className="oc-agent-conversation__glyph">
                      <AgentGlyph agent={agent} selected={isOpen} size={34} />
                      <span className="oc-agent-conversation__beacon">
                        <StatusDot
                          label={agent.status}
                          size={7}
                          tone={agentTone(agent)}
                        />
                      </span>
                    </span>
                    <span className="oc-agent-conversation__copy">
                      <span className="oc-agent-conversation__topline">
                        <span className="oc-agent-conversation__name">
                          {name}
                        </span>
                        <span className="oc-agent-conversation__time">
                          {formatAge(recency, props.now)}
                        </span>
                      </span>
                      <span className="oc-agent-conversation__preview">
                        {preview}
                      </span>
                    </span>
                  </button>

                  {isOpen ? (
                    <div className="oc-agent-runs">
                      <div className="oc-agent-runs__heading">
                        <span>Recent runs</span>
                        <button
                          className="oc-tint"
                          onClick={() => props.onNewRun(agent.id)}
                          type="button"
                        >
                          <Plus size={11} />
                          New run
                        </button>
                      </div>

                      {agentRuns.length === 0 ? (
                        <p>
                          {historyPending
                            ? "Loading recent runs…"
                            : historyFailed
                              ? "Recent runs could not be loaded."
                              : "No runs in this session."}
                        </p>
                      ) : (
                        agentRuns.map((run) => (
                          <button
                            className="oc-row oc-agent-run"
                            data-selected={
                              run.snapshot.id === props.selectedRunId
                                ? "true"
                                : "false"
                            }
                            key={run.snapshot.id}
                            onClick={() => props.onSelectRun(run.snapshot.id)}
                            type="button"
                          >
                            <StatusDot
                              label={run.snapshot.status}
                              size={6}
                              tone={statusTone(run.snapshot.status)}
                            />
                            <span>
                              {sanitizeEvidenceText(run.snapshot.task)}
                            </span>
                            <time dateTime={run.snapshot.createdAt}>
                              {formatAge(run.snapshot.createdAt, props.now)}
                            </time>
                          </button>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
              );
            }),
          ])}
        </div>

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
        {props.agents.length > 0 && visibleCount === 0 ? (
          <p className="oc-agent-search-empty" role="status">
            {normalizedQuery && props.pendingRunHistoryAgentIds.size > 0
              ? "Searching run history…"
              : `No profiles or runs match “${sanitizeEvidenceText(query.trim())}”.`}
          </p>
        ) : null}
      </div>

      <button
        aria-label="Account and settings"
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
        title={props.who}
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
