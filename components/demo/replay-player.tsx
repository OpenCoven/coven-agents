"use client";

import {
  type DemoTranscript,
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import {
  Activity,
  CheckCircle2,
  CircleX,
  FileCode2,
  Play,
  RotateCcw,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { planPlayback } from "@/lib/demo/player";
import { schedulePlayback } from "@/lib/demo/replay";

type RunEvent = DemoTranscript["events"][number]["event"];

function assertNever(value: never): never {
  throw new Error(`Unsupported replay event: ${String(value)}`);
}

function EvidenceBlock({
  children,
  label,
  tone = "neutral",
}: {
  children: React.ReactNode;
  label: string;
  tone?: "error" | "neutral";
}) {
  return (
    <div className="mt-3">
      <div className="mb-1.5 font-mono text-[10px] text-[var(--text-muted)] uppercase tracking-[0.16em]">
        {label}
      </div>
      <pre
        className={`overflow-x-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-mono text-xs leading-5 ${
          tone === "error"
            ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger-text)]"
            : "border-[var(--border-hairline)] bg-[var(--code-surface)] text-[var(--text-secondary)]"
        }`}
      >
        {children}
      </pre>
    </div>
  );
}

function EventBody({ event }: { event: RunEvent }) {
  switch (event.type) {
    case "accepted":
      return (
        <p className="mt-2 text-[var(--text-muted)] text-xs">
          Run {sanitizeEvidenceText(event.runId)} was accepted.
        </p>
      );
    case "status":
      return (
        <p className="mt-2 text-[var(--text-secondary)] text-sm">
          Agent status changed to{" "}
          <span className="font-medium text-white">{event.status}</span>.
        </p>
      );
    case "output":
      return (
        <EvidenceBlock label="Agent output">
          {sanitizeEvidenceText(event.output)}
        </EvidenceBlock>
      );
    case "command":
      return (
        <>
          <EvidenceBlock label="Command">
            $ {sanitizeEvidenceText(event.evidence.command)}
          </EvidenceBlock>
          {event.evidence.stdout ? (
            <EvidenceBlock label="Standard output">
              {sanitizeEvidenceText(event.evidence.stdout)}
            </EvidenceBlock>
          ) : null}
          {event.evidence.stderr ? (
            <EvidenceBlock label="Standard error" tone="error">
              {sanitizeEvidenceText(event.evidence.stderr)}
            </EvidenceBlock>
          ) : null}
          <p className="mt-2 text-[var(--text-muted)] text-xs">
            Exit code: {event.evidence.exitCode ?? "not reported"}
          </p>
        </>
      );
    case "file":
      return (
        <p className="mt-2 break-all font-mono text-[var(--text-muted)] text-xs">
          {event.evidence.operation} {sanitizeEvidencePath(event.evidence.path)}
          {event.evidence.byteLength === undefined
            ? ""
            : ` · ${event.evidence.byteLength.toLocaleString("en")} bytes`}
        </p>
      );
    case "completed":
      return (
        <>
          <p className="mt-2 text-[var(--text-secondary)] text-sm">
            Run completed with {event.run.commandEvidence.length} command
            {event.run.commandEvidence.length === 1 ? "" : "s"} and{" "}
            {event.run.fileEvidence.length} file operation
            {event.run.fileEvidence.length === 1 ? "" : "s"}.
          </p>
          {event.run.output ? (
            <EvidenceBlock label="Completion summary">
              {sanitizeEvidenceText(event.run.output)}
            </EvidenceBlock>
          ) : null}
        </>
      );
    case "failed":
      return (
        <>
          <p className="mt-2 text-[var(--danger-text)] text-sm">
            {sanitizeEvidenceText(event.error.message)}
          </p>
          <p className="mt-2 font-mono text-[var(--color-danger)] text-xs">
            {sanitizeEvidenceText(event.error.code)}
            {event.error.retryable ? " · retryable" : ""}
          </p>
          {event.error.details ? (
            <EvidenceBlock label="Failure details" tone="error">
              {sanitizeEvidenceText(event.error.details)}
            </EvidenceBlock>
          ) : null}
        </>
      );
    default:
      return assertNever(event);
  }
}

function eventPresentation(event: RunEvent) {
  switch (event.type) {
    case "accepted":
      return {
        icon: Play,
        label: "Run accepted",
        tone: "text-[var(--text-muted)]",
      };
    case "status":
      return {
        icon: Activity,
        label: "Status update",
        tone: "text-[var(--color-warning)]",
      };
    case "output":
      return {
        icon: Activity,
        label: "Agent output",
        tone: "text-[var(--accent-presence)]",
      };
    case "command":
      return {
        icon: Terminal,
        label: "Command finished",
        tone: "text-[var(--accent-signal)]",
      };
    case "file":
      return {
        icon: FileCode2,
        label: "File changed",
        tone: "text-[var(--accent-presence)]",
      };
    case "completed":
      return {
        icon: CheckCircle2,
        label: "Run completed",
        tone: "text-[var(--color-success)]",
      };
    case "failed":
      return {
        icon: CircleX,
        label: "Run failed",
        tone: "text-[var(--color-danger)]",
      };
    default:
      return assertNever(event);
  }
}

function EventCard({ event }: { event: RunEvent }) {
  const presentation = eventPresentation(event);
  const Icon = presentation.icon;

  return (
    <li
      className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-raised)] p-4 shadow-lg shadow-black/10"
      role={event.type === "failed" ? "alert" : undefined}
    >
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Icon aria-hidden="true" className={`size-4 ${presentation.tone}`} />
          <h3 className="font-medium text-sm">{presentation.label}</h3>
        </div>
        <span className="font-mono text-[10px] text-[var(--text-muted)]">
          #{event.id}
        </span>
      </div>
      <EventBody event={event} />
    </li>
  );
}

export function ReplayPlayer({ transcript }: { transcript: DemoTranscript }) {
  const [replayKey, setReplayKey] = useState(0);
  const playback = useMemo(
    () => ({
      key: replayKey,
      steps: planPlayback(transcript.events),
    }),
    [replayKey, transcript.events]
  );
  const [visibleEvents, setVisibleEvents] = useState<RunEvent[]>([]);
  const [isComplete, setIsComplete] = useState(false);
  const playbackGeneration = useRef(0);

  useEffect(() => {
    playbackGeneration.current += 1;
    const generation = playbackGeneration.current;
    setVisibleEvents([]);
    setIsComplete(false);
    return schedulePlayback(
      playback.steps,
      {
        onComplete: () => setIsComplete(true),
        onReveal: (event) => setVisibleEvents((current) => [...current, event]),
      },
      undefined,
      () => playbackGeneration.current === generation
    );
  }, [playback]);

  const restart = useCallback(() => {
    setReplayKey((current) => current + 1);
  }, []);

  return (
    <section
      aria-labelledby="replay-heading"
      className="overflow-hidden rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] shadow-2xl shadow-black/25 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between gap-4 border-[var(--border-hairline)] border-b px-4 py-3 sm:px-5">
        <div>
          <h2 className="font-medium text-sm" id="replay-heading">
            Replay timeline
          </h2>
          <p className="mt-0.5 text-[var(--text-muted)] text-xs">
            {visibleEvents.length} of {playback.steps.length} recorded events
          </p>
        </div>
        {isComplete ? (
          <Button
            aria-label="Replay guest run"
            className="border-[var(--border-hairline)] bg-[var(--bg-raised)] text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            onClick={restart}
            size="sm"
            variant="outline"
          >
            <RotateCcw aria-hidden="true" />
            Replay
          </Button>
        ) : (
          <span className="flex items-center gap-2 text-[var(--text-muted)] text-xs">
            <span className="size-1.5 animate-pulse rounded-full bg-[var(--accent-presence)]" />
            Replaying
          </span>
        )}
      </div>
      <ol
        aria-label="Recorded run events"
        aria-live="polite"
        aria-relevant="additions"
        className="space-y-3 p-4 sm:p-5"
      >
        {visibleEvents.map((event) => (
          <EventCard event={event} key={event.id} />
        ))}
      </ol>
      {isComplete ? (
        <p
          className="border-[var(--border-hairline)] border-t px-5 py-3 text-[var(--text-muted)] text-xs"
          role="status"
        >
          Recorded run complete.
        </p>
      ) : null}
    </section>
  );
}
