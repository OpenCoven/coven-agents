// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import type { FileEvidence } from "@opencoven/agent-contracts";
import { useState } from "react";
import { BrandMark } from "@/components/brand/brand-mark";
import { MarkdownPreview } from "@/components/console/markdown-preview";
import { Btn, Caret, Eyebrow } from "@/components/console/primitives";
import {
  card,
  dot,
  hairline,
  pill,
  tabular,
  truncate,
  type as type_,
  well,
} from "@/components/console/styles";
import type { ThreadBlock } from "@/lib/console/blocks";
import { formatDuration, splitPath } from "@/lib/console/format";

/**
 * The run record.
 *
 * Depth carries meaning here: the mission and the receipt sit above the plane
 * on an elevated surface, ordinary steps sit on it, and raw machine output is
 * cut into it. A reader can tell a claim from a transcript without reading
 * either.
 */

const MONO = "var(--font-mono)";

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

function DisclosureRow({
  children,
  onToggle,
  open,
}: {
  children: React.ReactNode;
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <button
      aria-expanded={open}
      onClick={onToggle}
      style={{
        alignItems: "center",
        background: "transparent",
        border: 0,
        cursor: "pointer",
        display: "flex",
        gap: 9,
        padding: "9px 13px",
        textAlign: "left",
        width: "100%",
      }}
      type="button"
    >
      <Caret open={open} />
      {children}
    </button>
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
        <div style={{ flex: 1 }} />
        <span style={type_.meta}>{block.who}</span>
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
    <div
      style={{
        alignItems: "center",
        display: "flex",
        gap: 10,
        padding: "1px 0",
        width: "fit-content",
      }}
    >
      <span
        style={dot(
          block.status === "running"
            ? "warning"
            : block.status === "completed"
              ? "success"
              : block.status === "failed"
                ? "danger"
                : "muted",
          6
        )}
      />
      <span
        style={{
          color: "var(--text-secondary)",
          font: "400 12px/1 var(--font-ui)",
          whiteSpace: "nowrap",
        }}
      >
        {block.label}
      </span>
      {block.detail ? <span style={type_.meta}>{block.detail}</span> : null}
      <Duration ms={block.durationMs} />
    </div>
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
        margin: "0 9px 9px",
        maxHeight: 220,
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

function CommandBlock({
  block,
}: {
  block: Extract<ThreadBlock, { kind: "command" }>;
}) {
  // Failures open by default. A non-zero exit is the one thing a reader always
  // wants the detail of, and making them click for it hides the reason a run
  // stopped behind a chevron.
  const [open, setOpen] = useState(
    block.exitCode !== null && block.exitCode !== 0
  );
  const output = [block.stdout, block.stderr].filter(Boolean).join("\n");
  const failed = block.exitCode !== null && block.exitCode !== 0;

  return (
    <div
      style={{
        ...card,
        border: failed
          ? "1px solid var(--danger-border)"
          : "1px solid var(--border-hairline)",
      }}
    >
      <DisclosureRow onToggle={() => setOpen((value) => !value)} open={open}>
        <span style={{ ...type_.label, whiteSpace: "nowrap" }}>
          Ran command
        </span>
        <span
          style={{
            color: "var(--text-secondary)",
            flex: 1,
            font: `400 11px/1 ${MONO}`,
            ...truncate,
          }}
        >
          {block.command}
        </span>
        <span
          style={pill(
            block.exitCode === null ? "warning" : failed ? "danger" : "success"
          )}
        >
          {block.exitCode === null ? "running" : `exit ${block.exitCode}`}
        </span>
        <Duration ms={block.durationMs} />
      </DisclosureRow>
      {open ? (
        output ? (
          <OutputWell text={output} />
        ) : (
          <p
            style={{
              ...type_.body,
              font: "400 12px/1.5 var(--font-ui)",
              padding: "0 13px 11px 36px",
            }}
          >
            {block.live
              ? "No output yet."
              : "The command produced no output on either stream."}
          </p>
        )
      ) : null}
      {block.live ? (
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 7,
            padding: "0 13px 9px 36px",
          }}
        >
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
    <div style={card}>
      <DisclosureRow onToggle={() => setOpen((value) => !value)} open={open}>
        <span style={type_.label}>{block.label}</span>
        <span
          style={{
            color: "var(--text-muted)",
            flex: 1,
            font: `400 11px/1 ${MONO}`,
            ...truncate,
          }}
        >
          {block.files.map((file) => splitPath(file.path).leaf).join(", ")}
        </span>
        <Duration ms={block.durationMs} />
      </DisclosureRow>
      {open ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "2px 13px 12px 36px",
          }}
        >
          {block.files.map((file) => (
            <FileRow file={file} key={`${file.operation}:${file.path}`} />
          ))}
          <p
            style={{
              ...type_.body,
              color: "var(--text-muted)",
              font: "400 11px/1.55 var(--font-ui)",
              paddingTop: 2,
            }}
          >
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
    <div style={{ display: "flex", gap: 11, padding: "2px 0" }}>
      <span style={well(false, 24)}>
        <BrandMark style={{ height: 11, width: 12 }} />
      </span>
      <MarkdownPreview live={block.live}>{block.text}</MarkdownPreview>
    </div>
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
          gap: 9,
          padding: "11px 14px",
        }}
      >
        <span style={dot("danger")} />
        <span
          style={{
            color: "var(--danger-text)",
            font: "600 12px/1 var(--font-ui)",
          }}
        >
          {block.retryable ? "Run stopped — retryable" : "Run stopped"}
        </span>
        <div style={{ flex: 1 }} />
        <span
          style={{
            color: "var(--danger-text)",
            font: `500 10px/1 ${MONO}`,
            letterSpacing: "0.1em",
            opacity: 0.75,
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
  return (
    <div
      className="oc-lift"
      style={{
        background: "var(--bg-elevated)",
        border:
          "1px solid color-mix(in oklch, var(--color-success) 26%, var(--border-hairline))",
        borderRadius: "var(--radius-card)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          alignItems: "center",
          background:
            "color-mix(in oklch, var(--color-success) 7%, transparent)",
          borderBottom: hairline,
          display: "flex",
          gap: 9,
          padding: "11px 14px",
        }}
      >
        <span style={dot("success")} />
        <span
          style={{
            color: "var(--text-primary)",
            font: "600 12px/1 var(--font-ui)",
          }}
        >
          Evidence
        </span>
        <span style={type_.meta}>{block.meta}</span>
        <div style={{ flex: 1 }} />
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

      <div
        style={{
          borderBottom: hairline,
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
        }}
      >
        {block.stats.map((stat, index) => (
          <div
            key={stat.label}
            style={{
              borderLeft: index === 0 ? undefined : hairline,
              display: "flex",
              flexDirection: "column",
              gap: 5,
              padding: "11px 14px",
            }}
          >
            <Eyebrow style={{ color: "var(--text-muted)" }}>
              {stat.label}
            </Eyebrow>
            <span
              style={{
                color: "var(--text-primary)",
                font: "500 14px/1.2 var(--font-ui)",
                ...tabular,
              }}
            >
              {stat.value}
            </span>
          </div>
        ))}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: "13px 14px",
        }}
      >
        {block.claim ? (
          <div className="oc-evidence-report">
            <div className="oc-evidence-report__kicker">
              <span className="oc-evidence-report__label">Claim</span>
              <span className="oc-evidence-report__meta">Run report</span>
            </div>
            <MarkdownPreview variant="report">{block.claim}</MarkdownPreview>
          </div>
        ) : null}

        {block.touched.length > 0 ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {block.touched.map((file) => (
              <FileRow file={file} key={`${file.operation}:${file.path}`} />
            ))}
          </div>
        ) : null}

        <div
          style={{
            alignItems: "center",
            borderTop: hairline,
            display: "flex",
            gap: 8,
            paddingTop: 8,
          }}
        >
          <span style={{ ...type_.meta, lineHeight: 1.6 }}>
            {block.provenance}
          </span>
          <div style={{ flex: 1 }} />
          <Btn onClick={onFollowUp} variant="secondary">
            Start a follow-up run
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
