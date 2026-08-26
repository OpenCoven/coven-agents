import {
  type DemoTranscript,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { Clock3, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
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
    <main className="relative min-h-dvh overflow-hidden bg-[#08060d] text-[#f3f0fa]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_65%_-20%,rgba(147,134,208,0.2),transparent_38%),linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:auto,42px_42px,42px_42px]" />
      <header className="relative border-white/8 border-b bg-black/20 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl border border-violet-300/25 bg-violet-300/10 text-violet-300">
              <Sparkles aria-hidden="true" className="size-4" />
            </div>
            <div>
              <div className="font-semibold tracking-[-0.02em]">OpenCoven</div>
              <div className="font-mono text-[10px] text-violet-200/60 uppercase tracking-[0.22em]">
                Curated guest preview
              </div>
            </div>
          </div>
          <Link
            className="rounded-lg border border-violet-300/25 bg-violet-300/10 px-3 py-2 font-medium text-violet-100 text-xs transition-colors hover:border-violet-200/45 hover:bg-violet-300/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-200/70"
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
        className="mx-auto max-w-xl rounded-2xl border border-white/10 bg-white/[0.035] p-7 shadow-2xl shadow-black/20 backdrop-blur-sm sm:p-9"
      >
        <Badge
          className="border-violet-300/20 bg-violet-300/10 text-violet-100"
          variant="outline"
        >
          Safe guest replay
        </Badge>
        <h1
          className="mt-5 text-2xl font-semibold tracking-[-0.03em]"
          id="demo-unavailable-title"
        >
          {title}
        </h1>
        <p className="mt-3 text-sm text-white/60">{description}</p>
        <div className="mt-6 flex items-center gap-2 border-white/8 border-t pt-5 text-white/45 text-xs">
          <ShieldCheck aria-hidden="true" className="size-4 text-violet-300" />
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
          className="border-violet-300/20 bg-violet-300/10 text-violet-200"
          variant="outline"
        >
          Safe guest replay
        </Badge>
        <h1
          className="mt-5 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.04em] sm:text-4xl"
          id="demo-task"
        >
          {sanitizeEvidenceText(transcript.task)}
        </h1>
        <p className="mt-4 max-w-2xl text-sm text-white/60 sm:text-base">
          This is a deterministic example built from sanitized evidence. It
          makes no live runner, authentication, or database request.
        </p>
        <div className="mt-5 flex items-center gap-2 font-mono text-violet-100/55 text-xs">
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
