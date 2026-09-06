// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import type { CreateAgentInput, Runtime } from "@opencoven/agent-contracts";
import { HARNESS_SPECS } from "@opencoven/harness";
import {
  ArrowLeft,
  BriefcaseBusiness,
  Hammer,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FamiliarPortrait } from "@/components/console/familiar-portrait";
import { Btn, Eyebrow } from "@/components/console/primitives";
import {
  hairline,
  tabular,
  truncate,
  type as type_,
} from "@/components/console/styles";
import { FORMATIONS, type Formation, TEMPLATES } from "@/lib/agents/formations";
import { executionProfileForTemplate } from "@/lib/console/agent-profile";

/**
 * Forging an execution profile.
 *
 * A profile is a bounded execution contract, not a personality. The three
 * paths are parallel ways to arrive at the same object: take a role as written,
 * take a complementary set of them, or write the contract yourself.
 */

type CreationPath = "crew" | "forge" | "role";

const DEFAULT_MODEL = "auto";
const DEFAULT_WORKSPACE = "/workspace";
const NAME_LIMIT = 64;
const INSTRUCTIONS_LIMIT = 12_000;

const RUNNABLE = HARNESS_SPECS.filter((spec) => spec.supported);
const REFUSED = HARNESS_SPECS.filter((spec) => !spec.supported);

const PATHS = [
  {
    description: "Use a proven operating contract, then adjust it later.",
    eyebrow: "Proven contract",
    icon: BriefcaseBusiness,
    id: "role",
    label: "Start from a role",
    outcome: "1 profile · one action",
  },
  {
    description: "Create a complementary set for a specific kind of work.",
    eyebrow: "Complementary set",
    icon: UsersRound,
    id: "crew",
    label: "Create a crew",
    outcome: "2–3 profiles · one action",
  },
  {
    description:
      "Define every field and write the operating contract yourself.",
    eyebrow: "Blank contract",
    icon: Hammer,
    id: "forge",
    label: "Forge a profile",
    outcome: "1 profile · full control",
  },
] as const satisfies readonly {
  description: string;
  eyebrow: string;
  icon: typeof BriefcaseBusiness;
  id: CreationPath;
  label: string;
  outcome: string;
}[];

type PathDefinition = (typeof PATHS)[number];

function PathCard({
  disabled,
  disabledReason,
  onSelect,
  path,
  setRef,
}: {
  disabled: boolean;
  disabledReason: string | null;
  onSelect: () => void;
  path: PathDefinition;
  setRef: (node: HTMLButtonElement | null) => void;
}) {
  const Icon = path.icon;
  const outcome = disabledReason ?? path.outcome;

  return (
    <button
      aria-describedby={`${path.id}-path-description ${path.id}-path-outcome`}
      className="oc-create-path-card"
      disabled={disabled}
      onClick={onSelect}
      ref={setRef}
      type="button"
    >
      <span aria-hidden="true" className="oc-create-path-glyph">
        <Icon size={19} strokeWidth={1.5} />
      </span>
      <span className="oc-create-path-copy">
        <Eyebrow>{path.eyebrow}</Eyebrow>
        <span className="oc-create-path-title">{path.label}</span>
        <span
          className="oc-create-path-description"
          id={`${path.id}-path-description`}
        >
          {path.description}
        </span>
        <span
          className="oc-create-path-outcome"
          data-unavailable={disabledReason ? "" : undefined}
          id={`${path.id}-path-outcome`}
        >
          {outcome}
        </span>
        <span aria-hidden="true" className="oc-create-path-cta">
          Choose path <span>→</span>
        </span>
      </span>
    </button>
  );
}

function CreationFrame({
  children,
  headingRef,
  onCancel,
  onShowPaths,
  path,
}: {
  children: React.ReactNode;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  onCancel: () => void;
  onShowPaths: () => void;
  path: PathDefinition;
}) {
  return (
    <div
      className={`oc-create-agent-path-canvas oc-create-agent-path-${path.id}`}
    >
      <div className="oc-create-agent-path-toolbar">
        <Btn onClick={onShowPaths} variant="ghost">
          <ArrowLeft size={13} />
          All paths
        </Btn>
        <Btn onClick={onCancel} variant="secondary">
          Cancel
        </Btn>
      </div>
      <div className="oc-create-agent-path-body">
        <Eyebrow>{path.eyebrow}</Eyebrow>
        <h2
          className="oc-create-agent-path-heading"
          ref={headingRef}
          style={type_.display}
          tabIndex={-1}
        >
          {path.label}
        </h2>
        {children}
      </div>
    </div>
  );
}

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
  const [path, setPath] = useState<CreationPath | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [runtime, setRuntime] = useState<Runtime>(
    (RUNNABLE[0]?.id as Runtime) ?? "copilot"
  );
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const pathButtonRefs = useRef<Record<CreationPath, HTMLButtonElement | null>>(
    {
      crew: null,
      forge: null,
      role: null,
    }
  );
  const returnFocusPathRef = useRef<CreationPath | null>(null);

  useEffect(() => {
    if (path) {
      headingRef.current?.focus();
      return;
    }

    const returnPath = returnFocusPathRef.current;
    if (returnPath) {
      pathButtonRefs.current[returnPath]?.focus();
      returnFocusPathRef.current = null;
    }
  }, [path]);

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

  const showAllPaths = () => {
    returnFocusPathRef.current = path;
    setPath(null);
  };

  const selectedPath = PATHS.find((entry) => entry.id === path) ?? null;
  const hasRunnableHarness = RUNNABLE.length > 0;

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
      {selectedPath ? (
        <CreationFrame
          headingRef={headingRef}
          onCancel={onCancel}
          onShowPaths={showAllPaths}
          path={selectedPath}
        >
          {path === "role" ? (
            <>
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
                {TEMPLATES.map((template) => {
                  const profile = executionProfileForTemplate(template);
                  return (
                    <button
                      aria-label={`Create ${template.name}. ${profile.mode}. ${profile.outcome}. ${template.blurb}`}
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
                      <FamiliarPortrait
                        fallbackLabel={template.name}
                        profileId={template.id}
                        selected={false}
                        size={32}
                      />
                      <span
                        style={{
                          display: "grid",
                          flex: "none",
                          gap: 4,
                          textAlign: "left",
                          width: 84,
                        }}
                      >
                        <strong style={type_.title}>{template.name}</strong>
                        <small
                          style={{
                            color: "var(--text-muted)",
                            font: "500 9px/1 var(--font-mono)",
                            textTransform: "uppercase",
                          }}
                        >
                          {profile.mode}
                        </small>
                      </span>
                      <span
                        style={{
                          display: "grid",
                          flex: 1,
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
                          {template.blurb}
                        </span>
                        <small
                          style={{
                            color: "var(--text-muted)",
                            font: "500 10px/1.25 var(--font-ui)",
                            ...truncate,
                          }}
                        >
                          Returns {profile.outcome.toLocaleLowerCase()}
                        </small>
                      </span>
                      <span
                        className="oc-reveal"
                        style={{
                          color: "var(--accent-presence)",
                          flex: "none",
                          font: "500 11px/1 var(--font-mono)",
                        }}
                      >
                        {busy ? "Creating…" : `Create ${template.name}`} →
                      </span>
                    </button>
                  );
                })}
              </div>
              <FinePrint label="How read-only is enforced">
                Read-only roles are enforced by their contract, not by the
                sandbox. Scout and Critic are told to change nothing; the
                container would still let them.
              </FinePrint>
            </>
          ) : null}

          {path === "crew" ? (
            <>
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
                          <FamiliarPortrait
                            fallbackLabel={member.name}
                            profileId={member.id}
                            selected={false}
                            size={22}
                          />
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
              <FinePrint label="Sequenced runs live in Teams">
                Running members in order and passing each one&rsquo;s evidence
                to the next is what a team does. Build a team to sequence these
                profiles; a crew here starts them together.
              </FinePrint>
            </>
          ) : null}

          {path === "forge" ? (
            <>
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
        </CreationFrame>
      ) : (
        <div className="oc-create-agent-chooser oc-scroll">
          <div className="oc-create-agent-chooser-inner">
            <div className="oc-create-agent-chooser-toolbar">
              <div />
              <Btn onClick={onCancel} variant="secondary">
                Cancel
              </Btn>
            </div>
            <header className="oc-create-agent-chooser-header">
              <Eyebrow>New execution profile</Eyebrow>
              <h1 style={type_.display}>Choose how to begin</h1>
              <p style={type_.body}>
                Each path creates runnable execution profiles. Choose based on
                how quickly you want to start and how much control you need.
              </p>
            </header>
            {hasRunnableHarness ? null : (
              <p className="oc-create-agent-availability" role="status">
                No runnable harness is available. Add a supported harness before
                creating execution profiles.
              </p>
            )}
            <fieldset
              aria-label="Execution profile paths"
              className="oc-create-agent-paths"
            >
              {PATHS.map((entry) => {
                const disabledReason = hasRunnableHarness
                  ? entry.id === "crew" && FORMATIONS.length === 0
                    ? "Unavailable · no crew presets"
                    : null
                  : "Unavailable · no runnable harness";

                return (
                  <PathCard
                    disabled={disabledReason !== null}
                    disabledReason={disabledReason}
                    key={entry.id}
                    onSelect={() => setPath(entry.id)}
                    path={entry}
                    setRef={(node) => {
                      pathButtonRefs.current[entry.id] = node;
                    }}
                  />
                );
              })}
            </fieldset>
          </div>
        </div>
      )}
    </div>
  );
}
