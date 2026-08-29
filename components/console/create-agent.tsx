// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import type { CreateAgentInput, Runtime } from "@opencoven/agent-contracts";
import { HARNESS_SPECS } from "@opencoven/harness";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { Btn, Eyebrow } from "@/components/console/primitives";
import {
  hairline,
  tabular,
  truncate,
  type as type_,
  well,
} from "@/components/console/styles";
import { FORMATIONS, type Formation, TEMPLATES } from "@/lib/agents/formations";
import { glyphFor } from "@/lib/console/format";

/**
 * Forging an execution profile.
 *
 * A profile is a bounded execution contract, not a personality. The three tabs
 * are three ways to arrive at the same object: take a role as written, take a
 * complementary set of them, or write the contract yourself.
 */

type Tab = "crew" | "forge" | "role";

const DEFAULT_MODEL = "auto";
const DEFAULT_WORKSPACE = "/workspace";
const NAME_LIMIT = 64;
const INSTRUCTIONS_LIMIT = 12_000;

const RUNNABLE = HARNESS_SPECS.filter((spec) => spec.supported);
const REFUSED = HARNESS_SPECS.filter((spec) => !spec.supported);

const TABS: { hint: string; id: Tab; label: string }[] = [
  { hint: "Take one as written", id: "role", label: "Start from a role" },
  { hint: "A complementary set", id: "crew", label: "Create a crew" },
  { hint: "Write the contract", id: "forge", label: "Forge a profile" },
];

function Field({
  children,
  hint,
  label,
}: {
  children: React.ReactNode;
  hint?: string;
  label: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control arrives as children and is nested inside this label, which is the implicit association the rule cannot see through a prop.
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 7,
        width: "100%",
      }}
    >
      <Eyebrow>{label}</Eyebrow>
      {children}
      {hint ? (
        <span
          style={{
            color: "var(--text-muted)",
            font: "400 11px/1.5 var(--font-ui)",
          }}
        >
          {hint}
        </span>
      ) : null}
    </label>
  );
}

/**
 * Secondary context, collapsed until sought.
 *
 * These used to be always-open note boxes — three paragraphs of explanation
 * standing between the person and the action. The information is real, so it
 * is not deleted; it is behind a one-line disclosure, which is the difference
 * between an interface that explains itself when asked and one that lectures.
 */
function FinePrint({
  children,
  label,
  tone = "muted",
}: {
  children: React.ReactNode;
  label: string;
  tone?: "muted" | "warning";
}) {
  return (
    <details style={{ marginTop: 14 }}>
      <summary
        style={{
          alignItems: "center",
          color:
            tone === "warning" ? "var(--color-warning)" : "var(--text-muted)",
          cursor: "pointer",
          display: "flex",
          font: "500 10px/1 var(--font-mono)",
          gap: 7,
          letterSpacing: "0.1em",
          listStyle: "none",
          textTransform: "uppercase",
          width: "fit-content",
        }}
      >
        {label}
      </summary>
      <p
        style={{
          ...type_.body,
          font: "400 12px/1.55 var(--font-ui)",
          marginTop: 8,
          maxWidth: "62ch",
        }}
      >
        {children}
      </p>
    </details>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg-sunken)",
  border: hairline,
  borderRadius: "var(--radius-control)",
  color: "var(--text-primary)",
  font: "400 13px/1.4 var(--font-ui)",
  outline: "none",
  padding: "9px 11px",
  width: "100%",
};

export function CreateAgent({
  busy,
  onCancel,
  onCreate,
  onCreateFormation,
}: {
  busy: boolean;
  onCancel: () => void;
  onCreate: (input: CreateAgentInput) => void;
  onCreateFormation: (formation: Formation) => void;
}) {
  const [tab, setTab] = useState<Tab>("role");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [runtime, setRuntime] = useState<Runtime>(
    (RUNNABLE[0]?.id as Runtime) ?? "copilot"
  );
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);

  const forgeBlocker = name.trim()
    ? instructions.trim().length < 20
      ? "The operating contract is what governs the run — write it."
      : null
    : "A profile needs a name.";

  const submitForge = () => {
    onCreate({
      backend: "cloud",
      description: description.trim(),
      instructions: instructions.trim(),
      model: model.trim() || DEFAULT_MODEL,
      name: name.trim(),
      runtime,
      workspace: workspace.trim() || DEFAULT_WORKSPACE,
    });
  };

  return (
    <div
      className="oc-create-agent"
      style={{
        background: "var(--bg-panel)",
        display: "flex",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        className="oc-create-agent-nav"
        style={{
          borderRight: hairline,
          display: "flex",
          flex: "none",
          flexDirection: "column",
          gap: 6,
          padding: "16px 12px",
          width: 236,
        }}
      >
        <Eyebrow style={{ letterSpacing: "0.14em", padding: "0 8px 8px" }}>
          New execution profile
        </Eyebrow>
        {TABS.map((entry, index) => (
          <button
            className="oc-row"
            key={entry.id}
            onClick={() => setTab(entry.id)}
            style={{
              alignItems: "center",
              background:
                tab === entry.id
                  ? "color-mix(in oklch, var(--accent-presence) 14%, transparent)"
                  : "transparent",
              border: 0,
              borderRadius: "var(--radius-md)",
              cursor: "pointer",
              display: "flex",
              gap: 10,
              padding: "9px 8px",
              textAlign: "left",
              width: "100%",
            }}
            type="button"
          >
            <span style={well(tab === entry.id, 22)}>{index + 1}</span>
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
              <span style={{ font: "500 13px/1.25 var(--font-ui)" }}>
                {entry.label}
              </span>
              <span
                style={{
                  color: "var(--text-muted)",
                  font: "400 11px/1.4 var(--font-ui)",
                }}
              >
                {entry.hint}
              </span>
            </span>
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <Btn fullWidth onClick={onCancel} variant="secondary">
          Cancel
        </Btn>
      </div>

      <div
        className="oc-create-agent-content oc-scroll"
        style={{
          background: "var(--bg-base)",
          flex: 1,
          minWidth: 0,
          overflowY: "auto",
          padding: "26px 30px",
        }}
      >
        <div style={{ maxWidth: 720 }}>
          {tab === "role" ? (
            <>
              <h2 style={{ ...type_.display, marginBottom: 5 }}>
                Start from a role
              </h2>
              <p style={{ ...type_.body, marginBottom: 16, maxWidth: "62ch" }}>
                Each role is an operating contract with a different bias. Pick
                one, then adjust — a role is a starting point, not a class.
              </p>
              <div
                style={{
                  background: "var(--border-hairline)",
                  border: hairline,
                  borderRadius: "var(--radius-card)",
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  overflow: "hidden",
                }}
              >
                {TEMPLATES.map((template) => (
                  <button
                    className="oc-row oc-rowscope"
                    disabled={busy}
                    key={template.id}
                    onClick={() =>
                      onCreate({
                        backend: "cloud",
                        description: template.blurb,
                        instructions: template.instructions,
                        model: DEFAULT_MODEL,
                        name: template.name,
                        runtime,
                        workspace: DEFAULT_WORKSPACE,
                      })
                    }
                    style={{
                      alignItems: "center",
                      background: "var(--bg-raised)",
                      border: 0,
                      cursor: busy ? "wait" : "pointer",
                      display: "flex",
                      gap: 12,
                      padding: "12px 14px",
                      textAlign: "left",
                      width: "100%",
                    }}
                    type="button"
                  >
                    <span style={well(false, 26)}>
                      {glyphFor(template.name)}
                    </span>
                    <span
                      style={{
                        ...type_.title,
                        flex: "none",
                        textAlign: "left",
                        width: 64,
                      }}
                    >
                      {template.name}
                    </span>
                    <span
                      style={{
                        color: "var(--text-muted)",
                        flex: 1,
                        font: "400 12px/1.45 var(--font-ui)",
                        textAlign: "left",
                        ...truncate,
                      }}
                    >
                      {template.blurb}
                    </span>
                    <span
                      className="oc-reveal"
                      style={{
                        color: "var(--accent-presence)",
                        flex: "none",
                        font: "500 11px/1 var(--font-mono)",
                      }}
                    >
                      use →
                    </span>
                  </button>
                ))}
              </div>
              <FinePrint label="How read-only is enforced">
                Read-only roles are enforced by their contract, not by the
                sandbox. Scout and Critic are told to change nothing; the
                container would still let them.
              </FinePrint>
            </>
          ) : null}

          {tab === "crew" ? (
            <>
              <h2 style={{ ...type_.display, marginBottom: 5 }}>
                Create a crew
              </h2>
              <p style={{ ...type_.body, marginBottom: 18, maxWidth: "60ch" }}>
                A crew is a complementary <em>set</em> of profiles created
                together. Members never hand work to each other — you dispatch
                each one yourself.
              </p>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 12 }}
              >
                {FORMATIONS.map((formation) => (
                  <div
                    key={formation.id}
                    style={{
                      background: "var(--bg-raised)",
                      border: hairline,
                      borderRadius: "var(--radius-card)",
                      overflow: "hidden",
                    }}
                  >
                    <div
                      style={{
                        alignItems: "center",
                        borderBottom: hairline,
                        display: "flex",
                        gap: 10,
                        padding: "12px 14px",
                      }}
                    >
                      <span style={type_.title}>{formation.name}</span>
                      <span style={{ ...type_.meta, ...tabular }}>
                        {formation.members.length} profiles
                      </span>
                      <div style={{ flex: 1 }} />
                      <Btn
                        disabled={busy}
                        onClick={() => onCreateFormation(formation)}
                        variant="secondary"
                      >
                        <Sparkles size={12} />
                        Create set
                      </Btn>
                    </div>
                    <div
                      style={{
                        alignItems: "center",
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 8,
                        padding: "13px 14px",
                      }}
                    >
                      {formation.members.map((member) => (
                        <span
                          key={member.id}
                          style={{
                            alignItems: "center",
                            background: "var(--bg-elevated)",
                            border: hairline,
                            borderRadius: "var(--radius-pill)",
                            display: "inline-flex",
                            gap: 7,
                            padding: "6px 11px 6px 7px",
                          }}
                        >
                          <span style={well(false, 20)}>
                            {glyphFor(member.name)}
                          </span>
                          <span style={type_.label}>{member.name}</span>
                        </span>
                      ))}
                    </div>
                    <p
                      style={{
                        ...type_.body,
                        font: "400 12px/1.5 var(--font-ui)",
                        padding: "0 14px 13px",
                      }}
                    >
                      {formation.blurb}
                    </p>
                  </div>
                ))}
              </div>
              <FinePrint label="Proposed: sequenced mode">
                Sequenced mode would run a crew in order and pass each
                member&rsquo;s evidence to the next. Nothing in the runner
                orchestrates handoffs today, so it stays a proposal rather than
                a switch you can flip.
              </FinePrint>
            </>
          ) : null}

          {tab === "forge" ? (
            <>
              <h2 style={{ ...type_.display, marginBottom: 5 }}>
                Forge a profile
              </h2>
              <p style={{ ...type_.body, marginBottom: 20, maxWidth: "56ch" }}>
                Everything the agent will be governed by, written out. The
                contract is the only thing standing between the mission and the
                container.
              </p>

              <div
                style={{ display: "flex", flexDirection: "column", gap: 18 }}
              >
                <Field label="Name">
                  <input
                    maxLength={NAME_LIMIT}
                    onChange={(event) => setName(event.target.value)}
                    style={inputStyle}
                    value={name}
                  />
                </Field>
                <Field
                  hint="Shown under the name in the rail. Optional."
                  label="Description"
                >
                  <input
                    maxLength={240}
                    onChange={(event) => setDescription(event.target.value)}
                    style={inputStyle}
                    value={description}
                  />
                </Field>
                <div style={{ display: "flex", gap: 14 }}>
                  <Field
                    hint={`Refused by the runner: ${REFUSED.map((spec) => spec.label).join(", ")}.`}
                    label="Harness"
                  >
                    <select
                      onChange={(event) => {
                        setRuntime(event.target.value as Runtime);
                        // The model list is per-harness; carrying a selection
                        // across harnesses would let a model the new CLI does
                        // not accept survive into the definition.
                        setModel(DEFAULT_MODEL);
                      }}
                      style={inputStyle}
                      value={runtime}
                    >
                      {RUNNABLE.map((spec) => (
                        <option key={spec.id} value={spec.id}>
                          {spec.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    hint="Only what the pinned CLI accepts. `auto` lets the harness choose."
                    label="Model"
                  >
                    {/* A select, deliberately not free text. The value is
                        passed verbatim to the CLI's --model flag, so a typo
                        was a failed run with a model error nobody had reason
                        to expect. The options come from the harness spec,
                        which is maintained beside the CLI version pin. */}
                    <select
                      onChange={(event) => setModel(event.target.value)}
                      style={inputStyle}
                      value={model}
                    >
                      {(
                        RUNNABLE.find((spec) => spec.id === runtime)
                          ?.models ?? ["auto"]
                      ).map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field
                  hint="The one root every command and edit is bounded to."
                  label="Workspace"
                >
                  <input
                    onChange={(event) => setWorkspace(event.target.value)}
                    style={inputStyle}
                    value={workspace}
                  />
                </Field>
                <Field
                  hint="What the agent must and must not do. This is the contract."
                  label="Operating contract"
                >
                  <textarea
                    maxLength={INSTRUCTIONS_LIMIT}
                    onChange={(event) => setInstructions(event.target.value)}
                    rows={9}
                    style={{
                      ...inputStyle,
                      font: "400 12px/1.6 var(--font-ui)",
                      resize: "vertical",
                    }}
                    value={instructions}
                  />
                </Field>
              </div>

              {/* Warning-toned because it is the one fact about a profile
                  with safety weight, but still a disclosure: the composer
                  restates it at the moment of running, which is where it
                  actually matters. */}
              <FinePrint label="Zero approval" tone="warning">
                Tool approvals are off for every profile — this is how OpenCoven
                runs, not an error. Runs stay inside their container.
              </FinePrint>

              <div
                style={{
                  alignItems: "center",
                  borderTop: hairline,
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 10,
                  marginTop: 18,
                  paddingTop: 16,
                }}
              >
                <Btn
                  disabled={busy || forgeBlocker !== null}
                  onClick={submitForge}
                  size="md"
                  variant="primary"
                >
                  <Sparkles size={14} />
                  Create profile
                </Btn>
                <Btn onClick={onCancel} size="md" variant="ghost">
                  Cancel
                </Btn>
                {forgeBlocker ? (
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      font: "400 11px/1.5 var(--font-ui)",
                    }}
                  >
                    {forgeBlocker}
                  </span>
                ) : null}
                <div style={{ flex: 1 }} />
                <span style={{ ...type_.meta, ...tabular }}>
                  {instructions.length} / {INSTRUCTIONS_LIMIT}
                </span>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
