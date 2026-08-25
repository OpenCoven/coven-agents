import {
  type DemoTranscript,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { Clock3, ShieldCheck, Sparkles } from "lucide-react";
import { ReplayPlayer } from "@/components/demo/replay-player";
import { Badge } from "@/components/ui/badge";
import type { resolveDemoView } from "@/lib/demo/root";

type DemoView = ReturnType<typeof resolveDemoView>;

function formatRecordedAt(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function DemoFrame({ children }: { children: React.ReactNode }) {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-[#050807] text-[#edf8f4]">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_65%_-20%,rgba(56,189,148,0.14),transparent_38%),linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:auto,42px_42px,42px_42px]" />
      <header className="relative border-white/8 border-b bg-black/20 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-4 sm:px-8">
          <div className="grid size-9 place-items-center rounded-xl border border-emerald-300/20 bg-emerald-300/10 text-emerald-300">
            <Sparkles aria-hidden="true" className="size-4" />
          </div>
          <div>
            <div className="font-semibold tracking-[-0.02em]">OpenCoven</div>
            <div className="font-mono text-[10px] text-emerald-200/55 uppercase tracking-[0.22em]">
              Recorded agent run
            </div>
          </div>
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
          className="border-amber-300/15 bg-amber-300/10 text-amber-100"
          variant="outline"
        >
          Recorded replay
        </Badge>
        <h1
          className="mt-5 text-2xl font-semibold tracking-[-0.03em]"
          id="demo-unavailable-title"
        >
          {title}
        </h1>
        <p className="mt-3 text-sm text-white/60">{description}</p>
        <div className="mt-6 flex items-center gap-2 border-white/8 border-t pt-5 text-white/45 text-xs">
          <ShieldCheck aria-hidden="true" className="size-4 text-emerald-300" />
          This page never falls through to a live agent run.
        </div>
      </section>
    </DemoFrame>
  );
}

function RecordedRun({ transcript }: { transcript: DemoTranscript }) {
  const recordedAt = formatRecordedAt(transcript.recordedAt);

  return (
    <DemoFrame>
      <section aria-labelledby="demo-task">
        <Badge
          className="border-emerald-300/20 bg-emerald-300/10 text-emerald-200"
          variant="outline"
        >
          Recorded replay
        </Badge>
        <h1
          className="mt-5 max-w-3xl text-balance text-3xl font-semibold tracking-[-0.04em] sm:text-4xl"
          id="demo-task"
        >
          {sanitizeEvidenceText(transcript.task)}
        </h1>
        <p className="mt-4 max-w-2xl text-sm text-white/60 sm:text-base">
          This is a recorded agent run replayed from committed evidence. It
          makes no live runner, authentication, or database request.
        </p>
        <div className="mt-5 flex items-center gap-2 font-mono text-emerald-100/50 text-xs">
          <Clock3 aria-hidden="true" className="size-3.5" />
          <span>Recorded</span>
          <time dateTime={transcript.recordedAt}>{recordedAt} UTC</time>
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
    <RecordedRun transcript={view.transcript} />
  ) : (
    <DemoUnavailable {...view} />
  );
}
