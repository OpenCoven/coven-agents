// biome-ignore-all lint/performance/noJsxPropsBind: selector handlers close over local dialog and profile state.

"use client";

import {
  type AgentDefinition,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { Check, ChevronDown, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatusDot } from "@/components/console/primitives";
import { well } from "@/components/console/styles";
import { executionProfileForAgent } from "@/lib/console/agent-profile";
import { glyphFor } from "@/lib/console/format";

type ProfileSelectorProps = {
  agents: AgentDefinition[];
  currentAgent: AgentDefinition;
  onCreate: () => void;
  onSelect: (agentId: string) => void;
};

const PROFILE_GROUPS = [
  { id: "running", label: "Active" },
  { id: "idle", label: "Ready" },
  { id: "error", label: "Needs attention" },
] as const;

function agentTone(agent: AgentDefinition) {
  if (agent.status === "running") {
    return "warning" as const;
  }
  return agent.status === "error" ? ("danger" as const) : ("muted" as const);
}

function accessibleAgentLabel(
  agent: AgentDefinition,
  agents: AgentDefinition[]
): string {
  const profile = executionProfileForAgent(agent);
  const base = `${sanitizeEvidenceText(agent.name)}, ${profile.label}, ${profile.mode}, ${agent.status}`;
  const peers = agents.filter((candidate) => {
    const candidateProfile = executionProfileForAgent(candidate);
    return (
      `${sanitizeEvidenceText(candidate.name)}, ${candidateProfile.label}, ${candidateProfile.mode}, ${candidate.status}` ===
      base
    );
  });
  if (peers.length < 2) {
    return base;
  }
  return `${base}, profile ${peers.findIndex((candidate) => candidate.id === agent.id) + 1} of ${peers.length}`;
}

export function ProfileSelector({
  agents,
  currentAgent,
  onCreate,
  onSelect,
}: ProfileSelectorProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const currentProfile = executionProfileForAgent(currentAgent);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const groupedAgents = useMemo(
    () =>
      PROFILE_GROUPS.map((group) => ({
        ...group,
        agents: agents.filter((agent) => {
          if (agent.status !== group.id) {
            return false;
          }
          if (!normalizedQuery) {
            return true;
          }
          const profile = executionProfileForAgent(agent);
          return [
            agent.name,
            agent.description,
            profile.label,
            profile.mode,
            profile.outcome,
            profile.purpose,
          ]
            .map((value) => sanitizeEvidenceText(value).toLocaleLowerCase())
            .some((value) => value.includes(normalizedQuery));
        }),
      })).filter((group) => group.agents.length > 0),
    [agents, normalizedQuery]
  );

  const close = (restoreFocus = true) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  const selectAgent = (agentId: string) => {
    setOpen(false);
    setQuery("");
    onSelect(agentId);
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>("#oc-mission")?.focus();
    });
  };

  return (
    <div className="oc-profile-selector">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Choose execution profile"
        className="oc-profile-selector__trigger"
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        type="button"
      >
        <span style={well(true, 30)}>
          {glyphFor(sanitizeEvidenceText(currentAgent.name))}
        </span>
        <span className="oc-profile-selector__current">
          <strong>{sanitizeEvidenceText(currentAgent.name)}</strong>
          <span>
            {currentProfile.label} · {currentProfile.mode}
          </span>
        </span>
        <ChevronDown
          aria-hidden="true"
          className="oc-profile-selector__chevron"
          size={14}
        />
      </button>

      {open ? (
        <>
          <button
            aria-label="Close profile selector"
            className="oc-profile-selector__backdrop"
            onClick={() => close()}
            type="button"
          />
          {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: the dialog owns Escape and focus containment. */}
          <dialog
            aria-label="Choose execution profile"
            className="oc-profile-selector__dialog"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                close();
                return;
              }
              if (event.key !== "Tab") {
                return;
              }
              const focusable = [
                ...(
                  event.currentTarget as HTMLElement
                ).querySelectorAll<HTMLElement>(
                  'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
                ),
              ];
              const [first] = focusable;
              const last = focusable.at(-1);
              if (!(first && last)) {
                return;
              }
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            open
          >
            <header className="oc-profile-selector__heading">
              <div>
                <span>Execution profiles</span>
                <strong>Choose who should run</strong>
              </div>
              <button
                className="oc-profile-selector__create"
                onClick={() => {
                  close(false);
                  onCreate();
                }}
                type="button"
              >
                <Plus size={12} />
                Create profile
              </button>
            </header>

            <search className="oc-profile-selector__search">
              <Search aria-hidden="true" size={13} />
              <input
                aria-label="Search execution profiles"
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search by name, role, or purpose"
                ref={searchRef}
                type="search"
                value={query}
              />
            </search>

            <div className="oc-profile-selector__list">
              {groupedAgents.map((group) => (
                <section className="oc-profile-selector__group" key={group.id}>
                  <h2>
                    <span>{group.label}</span>
                    <span>{group.agents.length}</span>
                  </h2>
                  {group.agents.map((agent) => {
                    const profile = executionProfileForAgent(agent);
                    const selected = agent.id === currentAgent.id;
                    return (
                      <button
                        aria-current={selected ? "true" : undefined}
                        aria-label={accessibleAgentLabel(agent, agents)}
                        className="oc-profile-selector__option"
                        data-selected={selected ? "true" : "false"}
                        key={agent.id}
                        onClick={() => selectAgent(agent.id)}
                        type="button"
                      >
                        <span className="oc-profile-selector__glyph">
                          <span style={well(selected, 34)}>
                            {glyphFor(sanitizeEvidenceText(agent.name))}
                          </span>
                          <StatusDot
                            label={agent.status}
                            size={7}
                            tone={agentTone(agent)}
                          />
                        </span>
                        <span className="oc-profile-selector__copy">
                          <span>
                            <strong>{sanitizeEvidenceText(agent.name)}</strong>
                            <small>{profile.mode}</small>
                          </span>
                          <span>{profile.purpose}</span>
                        </span>
                        {selected ? (
                          <Check
                            aria-hidden="true"
                            className="oc-profile-selector__check"
                            size={14}
                          />
                        ) : null}
                      </button>
                    );
                  })}
                </section>
              ))}

              {groupedAgents.length === 0 ? (
                <p role="status">
                  No execution profiles match “
                  {sanitizeEvidenceText(query.trim())}”.
                </p>
              ) : null}
            </div>
          </dialog>
        </>
      ) : null}
    </div>
  );
}
