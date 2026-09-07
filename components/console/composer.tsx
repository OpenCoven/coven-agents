// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import {
  type AgentDefinition,
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { type KeyboardEvent, useRef } from "react";
import {
  Btn,
  Eyebrow,
  StatusDot,
  statusTone,
} from "@/components/console/primitives";
import { truncate, type as type_ } from "@/components/console/styles";
import { executionProfileForAgent } from "@/lib/console/agent-profile";
import { formatAge } from "@/lib/console/format";
import { quickPromptsForAgent } from "@/lib/console/quick-prompts";
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
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const profile = executionProfileForAgent(agent);
  const quickPrompts = quickPromptsForAgent(agent);
  const safeAgentName = sanitizeEvidenceText(agent.name);
  const tooShort = draft.trim().length < MIN_MISSION;
  const disabled = tooShort || starting || blocked !== null;
  const remainingCharacters = Math.max(0, MIN_MISSION - draft.trim().length);

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
    <div className="oc-composer oc-scroll">
      <div
        className="oc-composer-grid"
        data-empty={runs.length === 0 ? "" : undefined}
      >
        <section className="oc-composer-main">
          <header className="oc-composer-heading">
            <Eyebrow>New autonomous run</Eyebrow>
            <h2 style={type_.display}>What should {safeAgentName} prove?</h2>
            <p style={type_.body}>{profile.composerGuidance}</p>
          </header>

          <div className="oc-composer-context">
            {[
              ["role", profile.label],
              // `mode` is deliberately absent: it is an instruction in the
              // profile text, not something the sandbox enforces, and it read
              // as a permission sitting beside runtime, model and workspace,
              // which are enforced.
              ["runtime", agent.runtime],
              ["model", sanitizeEvidenceText(agent.model)],
              [
                "workspace",
                sanitizeEvidencePath(agent.workspace ?? "/workspace"),
              ],
            ].map(([label, value]) => (
              <div className="oc-composer-context-item" key={label}>
                <span className="oc-composer-context-label">{label}</span>
                <strong title={value}>{value}</strong>
              </div>
            ))}
          </div>

          <section
            aria-label={`Quick chats for ${safeAgentName}`}
            className="oc-quick-chats"
          >
            <div className="oc-quick-chats__heading">
              <Eyebrow>Quick chats</Eyebrow>
              <span>Recommended for {safeAgentName}</span>
            </div>
            <div className="oc-quick-chats__grid">
              {quickPrompts.map((prompt, index) => (
                <button
                  className="oc-quick-chat"
                  key={prompt}
                  onClick={() => {
                    onDraft(prompt);
                    requestAnimationFrame(() => {
                      briefRef.current?.focus();
                      briefRef.current?.setSelectionRange(
                        prompt.length,
                        prompt.length
                      );
                    });
                  }}
                  type="button"
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  {prompt}
                </button>
              ))}
            </div>
          </section>

          <div className="oc-composer-brief">
            <label htmlFor="oc-mission">Proof brief</label>
            <textarea
              id="oc-mission"
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Describe the outcome, the constraints, and the evidence you would accept…"
              ref={briefRef}
              value={draft}
            />

            <div className="oc-composer-controls">
              <span>
                {remainingCharacters > 0
                  ? `${remainingCharacters} more character${remainingCharacters === 1 ? "" : "s"}`
                  : "Ctrl/⌘ + Enter to run"}
              </span>
              {blocked ? (
                <span className="oc-composer-blocked">{blocked}</span>
              ) : null}
              <Btn
                disabled={disabled}
                onClick={onStart}
                title="⌘/Ctrl + Enter"
                variant={disabled ? "secondary" : "primary"}
              >
                <Sparkles size={13} />
                {starting ? "Starting…" : "Run autonomously"}
              </Btn>
            </div>
          </div>

          <footer className="oc-composer-footnote">
            <span aria-hidden="true" className="oc-composer-footnote-dot" />
            {profile.safetyNote}
          </footer>
        </section>

        <aside aria-label="Runs in this session" className="oc-session-ledger">
          <header className="oc-session-ledger-head">
            <div>
              <Eyebrow>This session</Eyebrow>
              <h3>Run ledger</h3>
            </div>
            <span className="oc-session-count">
              {runs.length} {runs.length === 1 ? "run" : "runs"}
            </span>
          </header>

          <div className="oc-session-ledger-rule">
            <span>proof</span>
            <span aria-hidden="true" />
            <span>receipt</span>
          </div>

          <div className="oc-session-list oc-scroll">
            {runs.length === 0 ? (
              <div className="oc-session-empty">
                <strong>No receipts yet</strong>
                <p style={type_.body}>
                  Your first run will appear here with its status and evidence.
                </p>
              </div>
            ) : (
              runs.map((run, index) => (
                <button
                  className="oc-row oc-rowscope"
                  key={run.snapshot.id}
                  onClick={() => onOpenRun(run.snapshot.id)}
                  type="button"
                >
                  <span className="oc-session-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="oc-session-run">
                    <span className="oc-session-run-title">
                      <StatusDot
                        label={run.snapshot.status}
                        size={5}
                        tone={statusTone(run.snapshot.status)}
                      />
                      <span style={truncate}>
                        {sanitizeEvidenceText(run.snapshot.task)}
                      </span>
                    </span>
                    <small>{formatAge(run.snapshot.createdAt, now)}</small>
                  </span>
                  <ArrowUpRight className="oc-reveal" size={14} />
                </button>
              ))
            )}
          </div>

          <footer className="oc-session-ledger-foot">
            Browser-local history · the receipt is the durable record
          </footer>
        </aside>
      </div>
    </div>
  );
}
