// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import type { FileEvidence } from "@opencoven/agent-contracts";
import { CheckCircle2, CircleX } from "lucide-react";
import { useState } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { MarkdownPreview } from "@/components/console/markdown-preview";
import { Btn, Caret, Eyebrow, Spinner } from "@/components/console/primitives";
import {
  hairline,
  pill,
  type Tone,
  tabular,
  toneInk,
  truncate,
  type as type_,
} from "@/components/console/styles";
import type { LiveActivity, ThreadBlock } from "@/lib/console/blocks";
import { formatDuration, formatOffset, splitPath } from "@/lib/console/format";

/**
 * The run record.
 *
 * Depth carries meaning here: the mission and the receipt sit above the plane
 * on an elevated surface, ordinary steps sit on it, and raw machine output is
 * cut into it. A reader can tell a claim from a transcript without reading
 * either.
 *
 * The record reads like a flight recorder's tape. Down the left runs a clock —
 * every entry stamped with its offset from the moment the run was created —
 * and on the spine each entry carries a node coded by who acted: a hollow ring
 * when the runner changed state, a dot when the agent ran a command, a square
 * when it touched files, the brand glyph when it spoke. Only the premise, a
 * failure, and the receipt earn a card; everything else is a ledger row on
 * the plane, so the eye stops where it should.
 */

const MONO = "var(--font-mono)";
function EventGlyph({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: Tone;
}) {
  const ink = toneInk(tone);
  return (
    <span
      style={{
        alignItems: "center",
        background: `color-mix(in oklch, ${ink} 12%, transparent)`,
        border: `1px solid color-mix(in oklch, ${ink} 24%, transparent)`,
        borderRadius: 8,
        color: ink,
        display: "inline-flex",
        flex: "none",
        height: 26,
        justifyContent: "center",
        width: 26,
      }}
    >
      {children}
    </span>
  );
}

function Duration({ ms }: { ms: number | null }) {
  return (
    <span style={{ ...type_.meta, ...tabular }}>
      {ms === null ? "—" : formatDuration(ms)}
    </span>
  );
}

/** A path with its directory dimmed, so a column of them stays scannable. */
function PathNode({ path }: { path: string }) {
  const { dir, leaf } = splitPath(path);
  return (
    <span style={{ font: `400 11px/1.5 ${MONO}`, ...truncate }}>
      <span style={{ color: "var(--text-muted)" }}>{dir}</span>
      <span style={{ color: "var(--text-primary)" }}>{leaf}</span>
    </span>
  );
}

function MissionBlock({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "mission" }>;
}) {
  return (
    <div
      className="oc-lift"
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-strong)",
        borderRadius: "var(--radius-card)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background: "color-mix(in oklch, var(--bg-sunken) 55%, transparent)",
          borderBottom: hairline,
          display: "flex",
          gap: 8,
          padding: "8px 14px",
        }}
      >
        <Eyebrow style={{ letterSpacing: "0.14em" }}>Mission</Eyebrow>
      </div>
      <p
        style={{
          ...type_.body,
          color: "var(--text-primary)",
          padding: "12px 14px",
          whiteSpace: "pre-wrap",
        }}
      >
        {block.text}
      </p>
      {block.context.length > 0 ? (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: "0 14px 12px",
          }}
        >
          {block.context.map((item) => (
            <span
              key={item}
              style={{
                alignItems: "center",
                background: "var(--bg-sunken)",
                border: hairline,
                borderRadius: "var(--radius-control)",
                color: "var(--text-secondary)",
                display: "inline-flex",
                font: `400 11px/1 ${MONO}`,
                height: 22,
                maxWidth: "100%",
                padding: "0 9px",
                ...truncate,
              }}
            >
              {item}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LifecycleBlock({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "lifecycle" }>;
}) {
  return (
    <div className="oc-lifecycle-row">
      <span className="oc-lifecycle-row__label">{block.label}</span>
      {block.detail ? (
        <span className="oc-lifecycle-row__detail">{block.detail}</span>
      ) : null}
      <span aria-hidden="true" className="oc-lifecycle-row__rule" />
      <Duration ms={block.durationMs} />
    </div>
  );
}

export function LiveActivityStatus({ activity }: { activity: LiveActivity }) {
  return (
    <section
      aria-label="Live run activity"
      aria-live="off"
      className="oc-live-activity"
    >
      <div className="oc-live-activity__head">
        <Spinner />
        <Eyebrow>Live activity</Eyebrow>
        <div style={{ flex: 1 }} />
        <time dateTime={activity.lastSignalAt} style={type_.meta}>
          signal {activity.lastSignalAt.slice(11, 19)} UTC
        </time>
        <span style={pill("success")}>Credential-safe stream</span>
      </div>
      <div className="oc-live-activity__body">
        <div>
          <div className="oc-live-activity__title">{activity.headline}</div>
          <p className="oc-live-activity__detail">{activity.detail}</p>
        </div>
        <div className="oc-live-activity__metrics">
          {activity.metrics.map((metric) => (
            <div className="oc-live-activity__metric" key={metric.label}>
              <span style={type_.eyebrow}>{metric.label}</span>
              <span style={{ ...type_.label, ...tabular }}>{metric.value}</span>
            </div>
          ))}
        </div>
        <p className="oc-live-activity__safety">
          Credentials, authorization headers, cookies, environment dumps,
          private keys, terminal control sequences, and unsafe markup are
          removed before display.
        </p>
      </div>
    </section>
  );
}

/**
 * Colours one line of machine output.
 *
 * Read off the line itself rather than from a stream label, because the runner
 * hands over stdout and stderr whole; a failing line inside stdout still needs
 * to look like a failing line.
 */
function outputInk(line: string): string {
  if (/^\s*(?:✗|×|FAIL|ERROR|error\b)/i.test(line)) {
    return "oklch(0.86 0.06 24)";
  }
  if (/^\s*(?:✓|✔|PASS|ok\b)/i.test(line)) {
    return "oklch(0.86 0.05 158)";
  }
  return "var(--text-secondary)";
}

function OutputWell({ text }: { text: string }) {
  const lines = text.replace(/\n+$/, "").split("\n");
  return (
    <div
      className="oc-scroll oc-well"
      style={{
        background: "var(--code-surface)",
        border: hairline,
        borderRadius: "var(--radius-md)",
        margin: "0 8px 2px",
        maxHeight: 260,
        overflow: "auto",
        padding: "10px 12px",
      }}
    >
      {lines.map((line, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: output lines have no identity beyond their position, and the array is replaced wholesale on each update.
          key={index}
          style={{
            color: outputInk(line),
            font: `400 11px/1.65 ${MONO}`,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {line || " "}
        </div>
      ))}
    </div>
  );
}

function CommandTitle({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "command" }>;
}) {
  const rest = block.command.trim().slice(block.head.length);
  return (
    <span className="oc-ledger-row__title">
      <span className="oc-ledger-row__head">{block.head}</span>
      <span className="oc-ledger-row__rest">{rest}</span>
    </span>
  );
}

function CommandBlock({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "command" }>;
}) {
  // Failures open by default. A non-zero exit is the one thing a reader always
  // wants the detail of, and making them click for it hides the reason a run
  // stopped behind a chevron.
  const failed = block.exitCode !== null && block.exitCode !== 0;
  const [open, setOpen] = useState(failed);
  const output = [block.stdout, block.stderr].filter(Boolean).join("\n");
  const tone: Tone = failed ? "danger" : block.live ? "warning" : "muted";

  return (
    <div
      className="oc-ledger"
      data-open={open}
      data-tone={failed ? "danger" : block.live ? "running" : "success"}
    >
      <button
        aria-expanded={open}
        className="oc-ledger-row"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Caret open={open} />
        <CommandTitle block={block} />
        {block.exitCode === null ? (
          <span style={pill("warning")}>running</span>
        ) : failed ? (
          <span style={pill("danger")}>exit {block.exitCode}</span>
        ) : (
          <span className="oc-ledger-row__exit">exit 0</span>
        )}
        <Duration ms={block.durationMs} />
      </button>
      {open || !block.summary ? null : (
        <div
          className="oc-ledger-row__summary"
          style={{ color: toneInk(tone) }}
        >
          <span aria-hidden="true">↳</span>
          <span style={truncate}>{block.summary}</span>
        </div>
      )}
      {open ? (
        output ? (
          <OutputWell text={output} />
        ) : (
          <p className="oc-ledger__empty">
            {block.live
              ? "No output yet."
              : "The command produced no output on either stream."}
          </p>
        )
      ) : null}
      {block.live ? (
        <div className="oc-ledger__live">
          <span
            className="oc-caret"
            style={{
              background: "var(--color-warning)",
              display: "inline-block",
              height: 12,
              width: 6,
            }}
          />
          <span style={type_.meta}>streaming</span>
        </div>
      ) : null}
    </div>
  );
}

const OPERATION_TONE = {
  create: "success",
  delete: "danger",
  modify: "accent",
} as const;

function FileRow({ file }: { file: FileEvidence }) {
  return (
    <div style={{ alignItems: "center", display: "flex", gap: 9 }}>
      <span
        style={{
          ...pill(OPERATION_TONE[file.operation]),
          height: 18,
          letterSpacing: "0.06em",
          padding: "0 7px",
        }}
      >
        {file.operation}
      </span>
      <PathNode path={file.path} />
      <div style={{ flex: 1 }} />
      <span style={{ ...type_.meta, ...tabular }}>
        {file.byteLength === undefined ? "" : `${file.byteLength} B`}
      </span>
    </div>
  );
}

function FilesBlock({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "files" }>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="oc-ledger" data-open={open} data-tone="muted">
      <button
        aria-expanded={open}
        className="oc-ledger-row"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Caret open={open} />
        <span className="oc-ledger-row__title">
          <span
            className="oc-ledger-row__head"
            style={{ fontFamily: "var(--font-ui)" }}
          >
            {block.label}
          </span>
          <span className="oc-ledger-row__rest">
            {block.files.map((file) => splitPath(file.path).leaf).join(", ")}
          </span>
        </span>
        <Duration ms={block.durationMs} />
      </button>
      {open ? (
        <div className="oc-ledger__files">
          {block.files.map((file) => (
            <FileRow file={file} key={`${file.operation}:${file.path}`} />
          ))}
          <p className="oc-ledger__note">
            The runner reports which files changed and by how much, not their
            contents. Open the workspace to read the diff.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function TextBlock({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "text" }>;
}) {
  return (
    <article className="oc-passage">
      <div className="oc-passage__head">
        <span className="oc-passage__voice">Agent</span>
        <div style={{ flex: 1 }} />
        {block.live ? <span style={pill("warning")}>streaming</span> : null}
        <Duration ms={block.durationMs} />
      </div>
      <MarkdownPreview live={block.live}>{block.text}</MarkdownPreview>
    </article>
  );
}

function ErrorBlock({
  block,
  onAmend,
  onCopyReceipt,
  onRetry,
}: {
  block: Extract<ThreadBlock, { kind: "error" }>;
  onAmend: () => void;
  onCopyReceipt: () => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="oc-run-event-card"
      role="alert"
      style={{
        background: "var(--danger-bg)",
        border: "1px solid var(--danger-border)",
        borderRadius: "var(--radius-card)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          alignItems: "center",
          borderBottom: "1px solid var(--danger-border)",
          display: "flex",
          flexWrap: "wrap",
          gap: 9,
          padding: "11px 14px",
        }}
      >
        <EventGlyph tone="danger">
          <CircleX aria-hidden="true" size={14} />
        </EventGlyph>
        <h3
          style={{
            color: "var(--danger-text)",
            font: "600 12px/1 var(--font-ui)",
          }}
        >
          {block.retryable ? "Run stopped — retryable" : "Run stopped"}
        </h3>
        <div style={{ flex: 1 }} />
        <span
          style={{
            color: "var(--danger-text)",
            font: `500 10px/1 ${MONO}`,
            letterSpacing: "0.1em",
            maxWidth: "100%",
            opacity: 0.75,
            overflowWrap: "anywhere",
            textTransform: "uppercase",
          }}
        >
          {block.code}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "12px 14px",
        }}
      >
        <p style={type_.body}>{block.message}</p>
        {block.details ? (
          <pre
            className="oc-scroll oc-well"
            style={{
              background: "var(--code-surface)",
              border: "1px solid var(--danger-border)",
              borderRadius: "var(--radius-md)",
              color: "oklch(0.86 0.06 24)",
              font: `400 11px/1.65 ${MONO}`,
              margin: 0,
              maxHeight: 140,
              overflow: "auto",
              padding: "10px 12px",
              whiteSpace: "pre-wrap",
            }}
          >
            {block.details}
          </pre>
        ) : null}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {/* One action leads, chosen by what the error said about itself: a
              retryable failure invites the retry, a permanent one invites
              the edit that could change the outcome. The same three doors
              exist either way — only the emphasis moves. */}
          {block.retryable ? (
            <>
              <Btn onClick={onRetry} variant="primary">
                Retry mission
              </Btn>
              <Btn onClick={onAmend} variant="secondary">
                Edit mission
              </Btn>
            </>
          ) : (
            <>
              <Btn onClick={onAmend} variant="primary">
                Edit mission
              </Btn>
              <Btn onClick={onRetry} variant="secondary">
                Retry anyway
              </Btn>
            </>
          )}
          <Btn onClick={onCopyReceipt} variant="ghost">
            Copy failure report
          </Btn>
        </div>
      </div>
    </div>
  );
}

function EvidenceBlock({
  block,
  copied,
  onCopyReceipt,
  onFollowUp,
}: {
  block: Extract<ThreadBlock, { kind: "evidence" }>;
  copied: boolean;
  onCopyReceipt: () => void;
  onFollowUp: () => void;
}) {
  const commandCount =
    block.stats.find((stat) => stat.label === "Commands")?.value ?? "0";
  const fileCount =
    block.stats.find((stat) => stat.label === "Files")?.value ?? "0";
  const wallClock =
    block.stats.find((stat) => stat.label === "Wall clock")?.value ?? "—";
  const compact =
    block.hasAnswer &&
    commandCount === "0" &&
    fileCount === "0" &&
    block.touched.length === 0 &&
    !block.claim.includes("\n") &&
    block.claim.trim().length <= 160;

  return (
    <div
      className="oc-evidence-card oc-lift oc-run-event-card"
      data-layout={compact ? "compact" : "report"}
      style={{
        background: "var(--bg-elevated)",
        border:
          "1px solid color-mix(in oklch, var(--color-success) 26%, var(--border-hairline))",
        borderRadius: "var(--radius-card)",
        overflow: "hidden",
      }}
    >
      <div
        className="oc-evidence-card__header"
        style={{
          alignItems: "center",
          background:
            "color-mix(in oklch, var(--color-success) 7%, transparent)",
          borderBottom: hairline,
          display: "flex",
          flexWrap: "wrap",
          gap: 9,
          padding: "11px 14px",
        }}
      >
        <EventGlyph tone="success">
          <CheckCircle2 aria-hidden="true" size={14} />
        </EventGlyph>
        <h3
          style={{
            color: "var(--text-primary)",
            font: "600 12px/1 var(--font-ui)",
          }}
        >
          Run completed
        </h3>
        <span
          style={{
            ...type_.meta,
            flex: "1 1 120px",
            ...truncate,
          }}
        >
          {block.meta}
        </span>
        {copied ? (
          <span
            role="status"
            style={{
              color: "var(--color-success)",
              font: `500 10px/1 ${MONO}`,
            }}
          >
            Copied
          </span>
        ) : null}
        <Btn onClick={onCopyReceipt} size="xs" variant="secondary">
          Copy receipt
        </Btn>
      </div>

      {compact ? null : (
        <div className="oc-evidence-stats">
          {block.stats.map((stat) => (
            <div className="oc-evidence-stat" key={stat.label}>
              <span className="oc-evidence-stat__value">{stat.value}</span>
              <Eyebrow style={{ color: "var(--text-muted)" }}>
                {stat.label}
              </Eyebrow>
            </div>
          ))}
        </div>
      )}

      <div className="oc-evidence-card__body">
        {block.claim ? (
          <div className="oc-evidence-report">
            <div className="oc-evidence-report__kicker">
              <span className="oc-evidence-report__label">Result</span>
              <span className="oc-evidence-report__meta">
                {compact ? "Final answer" : "Run report"}
              </span>
            </div>
            <MarkdownPreview variant="report">{block.claim}</MarkdownPreview>
          </div>
        ) : null}

        {compact ? (
          <div className="oc-evidence-summary">
            <span>Direct response</span>
            <span>Completed in {wallClock}</span>
            <span>No file changes reported</span>
          </div>
        ) : null}

        {block.touched.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {block.touched.map((file) => (
              <FileRow file={file} key={`${file.operation}:${file.path}`} />
            ))}
          </div>
        ) : null}

        <div className="oc-evidence-card__footer">
          <span style={{ ...type_.meta, lineHeight: 1.6 }}>
            {block.provenance}
          </span>
          <div style={{ flex: 1 }} />
          <Btn onClick={onFollowUp} variant="secondary">
            Ask a follow-up
          </Btn>
        </div>
      </div>
    </div>
  );
}

export type ThreadHandlers = {
  copiedReceipt: boolean;
  onAmend: () => void;
  onCopyReceipt: () => void;
  onFollowUp: () => void;
  onRetry: () => void;
};

/** The tone a block's spine node carries; state, never identity. */
function blockTone(block: ThreadBlock): string {
  switch (block.kind) {
    case "lifecycle":
      return block.status === "running"
        ? "running"
        : block.status === "completed"
          ? "success"
          : block.status === "failed"
            ? "danger"
            : "muted";
    case "command":
      return block.exitCode === null
        ? "running"
        : block.exitCode === 0
          ? "muted"
          : "danger";
    case "error":
      return "danger";
    case "evidence":
      return "success";
    case "text":
      return block.live ? "running" : "muted";
    default:
      return "muted";
  }
}

function SpineNode({ block }: { block: ThreadBlock }) {
  switch (block.kind) {
    case "text":
      return (
        <span className="oc-block__node">
          <BrandMark aria-hidden="true" style={{ height: 10, width: 11 }} />
        </span>
      );
    case "error":
      return (
        <span className="oc-block__node">
          <CircleX aria-hidden="true" size={13} />
        </span>
      );
    case "evidence":
      return (
        <span className="oc-block__node">
          <CheckCircle2 aria-hidden="true" size={13} />
        </span>
      );
    default:
      return <span aria-hidden="true" className="oc-block__node" />;
  }
}

/**
 * One entry on the tape: the clock stamp and spine node in the gutter, the
 * block itself beside them. `data-kind` and `data-tone` drive the node's
 * shape and colour from CSS so the vocabulary lives in one place.
 */
export function ThreadEntry({
  block,
  handlers,
}: {
  block: ThreadBlock;
  handlers: ThreadHandlers;
}) {
  return (
    <div
      className="oc-block"
      data-kind={block.kind}
      data-tone={blockTone(block)}
      id={`block-${block.id}`}
    >
      <div className="oc-block__gutter">
        {block.atMs === null ? (
          <span className="oc-block__stamp" />
        ) : (
          <span className="oc-block__stamp">{formatOffset(block.atMs)}</span>
        )}
        <SpineNode block={block} />
      </div>
      <div className="oc-block__body">
        <ThreadBlockView block={block} handlers={handlers} />
      </div>
    </div>
  );
}

export function ThreadBlockView({
  block,
  handlers,
}: {
  block: ThreadBlock;
  handlers: ThreadHandlers;
}) {
  switch (block.kind) {
    case "mission":
      return <MissionBlock block={block} />;
    case "lifecycle":
      return <LifecycleBlock block={block} />;
    case "command":
      return <CommandBlock block={block} />;
    case "files":
      return <FilesBlock block={block} />;
    case "text":
      return <TextBlock block={block} />;
    case "error":
      return (
        <ErrorBlock
          block={block}
          onAmend={handlers.onAmend}
          onCopyReceipt={handlers.onCopyReceipt}
          onRetry={handlers.onRetry}
        />
      );
    case "evidence":
      return (
        <EvidenceBlock
          block={block}
          copied={handlers.copiedReceipt}
          onCopyReceipt={handlers.onCopyReceipt}
          onFollowUp={handlers.onFollowUp}
        />
      );
    default:
      return null;
  }
}
