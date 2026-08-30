import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/brand/brand-mark";

export const metadata: Metadata = {
  description:
    "How OpenCoven bounds autonomous agent execution: tenant-scoped Daytona sandboxes, same-origin authority, and transient credentials.",
  title: "Security",
};

/**
 * The outward statement of the execution boundary.
 *
 * A distillation of the internal threat model, deliberately not the document
 * itself: this page names the guarantees and where they end, and omits
 * internals — configuration names, limits, incident history — that would
 * brief an attacker without informing a customer. Every sentence here is a
 * claim the codebase enforces, most of them structurally; nothing is
 * aspirational.
 *
 * Static and public on purpose. A security posture only readable from inside
 * the beta gate persuades nobody.
 */

const SECTIONS: { body: string[]; title: string }[] = [
  {
    body: [
      "Each agent executes in one tenant-scoped persistent Daytona sandbox. Runs reuse that isolated workspace through short-lived process sessions; nothing executes on your machine.",
      "Approval prompts are disabled by design. The boundary is not “the model cannot run a dangerous command” — it is which identity may request execution, which tenant receives it, which credentials enter it, and what evidence may leave it.",
    ],
    title: "The container is the blast radius",
  },
  {
    body: [
      "A caller cannot act as another tenant or reach another tenant's agents, sandboxes, credentials, or runs. Durable records and provider identifiers are tenant-scoped and fenced before use.",
      "Browser requests reach Daytona only through the same-origin Next.js API. Current Auth.js account authority is revalidated before execution, and provider credentials remain server-side.",
    ],
    title: "Tenants are isolated by construction",
  },
  {
    body: [
      "Your harness credential is envelope-encrypted at rest, acquired only by the server for one fenced launch, staged in a mode-0600 file, and removed before the harness process starts. It is never returned to the browser or shared with another account.",
      "Secret-shaped output is redacted before evidence is persisted or shown. A credential that appears in a command's output does not survive into the record.",
    ],
    title: "Credentials never outlive a run",
  },
  {
    body: [
      "Every run closes with a receipt: the commands it ran, their exit codes, the files it touched, and the claim it makes about what it did. A confident report on its own does not count — the receipt is what you audit against.",
      "Sign-in is GitHub-only. Missing identity, keys, or configuration fails closed. Request admission is rate-limited per identity, and execution time inside the sandbox is bounded, so a wedged process becomes a failed run rather than a stuck agent.",
    ],
    title: "Evidence over assurance",
  },
  {
    body: [
      "The internal security of GitHub, Daytona, Stripe, and model providers — we build on their guarantees and say so rather than restating them as our own.",
      "Preventing an authorized agent from changing files inside the workspace it was granted — that is what a run is for. And natural-language prompts are never treated as trusted instructions.",
    ],
    title: "What this does not claim",
  },
];

export default function SecurityPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3">
        <Link
          aria-label="OpenCoven home"
          className="mb-5 flex w-fit items-center gap-2 text-foreground transition-opacity hover:opacity-75"
          href="/"
        >
          <BrandMark className="size-5 text-[var(--oc-accent)]" />
          <span className="font-medium text-[13px] tracking-[-0.01em]">
            OpenCoven
          </span>
        </Link>
        <p className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
          Security
        </p>
        <h1 className="font-semibold text-2xl tracking-tight">
          Autonomous agents, bounded by infrastructure.
        </h1>
        <p className="text-muted-foreground text-sm leading-relaxed">
          OpenCoven runs coding agents without approval prompts. That only works
          if the boundary is real. This page says where it is.
        </p>
      </header>

      {SECTIONS.map((section) => (
        <section className="flex flex-col gap-3" key={section.title}>
          <h2 className="font-mono text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
            {section.title}
          </h2>
          {section.body.map((paragraph) => (
            <p
              className="text-[13px] text-foreground/80 leading-relaxed"
              key={paragraph.slice(0, 32)}
            >
              {paragraph}
            </p>
          ))}
        </section>
      ))}

      <footer className="border-border border-t pt-6">
        <p className="font-mono text-[11px] text-muted-foreground">
          Questions about this posture: security@opencoven.ai
        </p>
      </footer>
    </main>
  );
}
