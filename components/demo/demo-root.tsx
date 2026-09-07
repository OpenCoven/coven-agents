import {
  type DemoTranscript,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { Clock3, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { BrandMark } from "@/components/brand/brand-mark";
import { ReplayPlayer } from "@/components/demo/replay-player";
import { Badge } from "@/components/ui/badge";
import type { resolveDemoView } from "@/lib/demo/root";

type DemoView = ReturnType<typeof resolveDemoView>;

function formatPreparedAt(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function DemoFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="oc-console relative min-h-dvh overflow-hidden">
      <header className="relative border-[var(--border-hairline)] border-b bg-[var(--bg-panel)]">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl border border-[var(--border-strong)] bg-[var(--fill-info)] text-[var(--accent-presence)]">
              <BrandMark className="size-4" />
            </div>
            <div>
              <div className="font-semibold tracking-[-0.02em]">OpenCoven</div>
              <div className="font-mono text-[10px] text-[var(--text-muted)] uppercase tracking-[0.22em]">
                Curated guest preview
              </div>
            </div>
          </div>
          <Link
            className="rounded-lg border border-[var(--border-strong)] bg-[var(--fill-info)] px-3 py-2 font-medium text-[var(--accent-presence)] text-xs transition-colors hover:border-[var(--accent-presence)] hover:bg-[var(--bg-hover)]"
            href="/login"
            prefetch={false}
          >
            Create guest account
          </Link>
        </div>
      </header>
      <div className="relative mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
        {children}
      </div>
    </main>
  );
}

function DemoUnavailable({
  description,
  title,
}: Extract<DemoView, { kind: "unavailable" }>) {
  return (
    <DemoFrame>
      <section
        aria-labelledby="demo-unavailable-title"
        className="mx-auto max-w-xl rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-raised)] p-7 shadow-2xl shadow-black/20 sm:p-9"
      >
        <Badge
          className="border-[var(--border-strong)] bg-[var(--fill-info)] text-[var(--accent-presence)]"
          variant="outline"
        >
          Safe guest replay
        </Badge>
        <h1
          className="mt-5 font-serif text-3xl tracking-[-0.02em]"
          id="demo-unavailable-title"
        >
          {title}
        </h1>
        <p className="mt-3 text-sm text-[var(--text-secondary)]">
          {description}
        </p>
        <div className="mt-6 flex items-center gap-2 border-[var(--border-hairline)] border-t pt-5 text-[var(--text-muted)] text-xs">
          <ShieldCheck
            aria-hidden="true"
            className="size-4 text-[var(--accent-presence)]"
          />
          This page never falls through to a live agent run.
        </div>
      </section>
    </DemoFrame>
  );
}

function CuratedRun({ transcript }: { transcript: DemoTranscript }) {
  const preparedAt = formatPreparedAt(transcript.recordedAt);

  return (
    <DemoFrame>
      <section aria-labelledby="demo-task">
        <Badge
          className="border-[var(--border-strong)] bg-[var(--fill-info)] text-[var(--accent-presence)]"
          variant="outline"
        >
          Safe guest replay
        </Badge>
        <h1
          className="mt-5 max-w-3xl text-balance font-serif text-4xl tracking-[-0.02em] sm:text-5xl"
          id="demo-task"
        >
          {sanitizeEvidenceText(transcript.task)}
        </h1>
        <p className="mt-4 max-w-2xl text-sm text-[var(--text-secondary)] sm:text-base">
          This is a deterministic example built from sanitized evidence. It
          makes no live runner, authentication, or database request.
        </p>
        <div className="mt-5 flex items-center gap-2 font-mono text-[var(--text-muted)] text-xs">
          <Clock3 aria-hidden="true" className="size-3.5" />
          <span>Prepared</span>
          <time dateTime={transcript.recordedAt}>{preparedAt} UTC</time>
        </div>
      </section>
      <div className="mt-9">
        <ReplayPlayer transcript={transcript} />
      </div>
    </DemoFrame>
  );
}

export function DemoRoot({ view }: { view: DemoView }) {
  return view.kind === "replay" ? (
    <CuratedRun transcript={view.transcript} />
  ) : (
    <DemoUnavailable {...view} />
  );
}
