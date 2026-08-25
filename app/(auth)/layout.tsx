import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { SessionProvider } from "next-auth/react";

/**
 * The signed-out surface, styled to the canonical component library
 * (OpenCoven/ui).
 *
 * The brand tokens come from `data-brand="opencoven"` on <html>, so `Button`,
 * `Input` and `Label` inherit the palette without being restyled.
 *
 * `SessionProvider` lives here rather than at the root because the demo route
 * renders with no session at all; hoisting it back would give every demo
 * visitor a session context they are defined not to have.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider
      basePath={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth`}
    >
      <div className="relative flex min-h-dvh w-full flex-col items-center justify-center bg-background px-6 py-12">
        {/* A single soft accent wash, matching the library's restraint with
            colour: one accent, used sparingly, never as a gradient field. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-64 opacity-70"
          style={{
            background:
              "radial-gradient(60% 100% at 50% 0%, var(--oc-accent-soft), transparent 70%)",
          }}
        />

        <div className="relative flex w-full max-w-[420px] flex-col gap-6">
          <Link
            className="flex w-fit items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            href="/"
          >
            <ArrowLeftIcon className="size-3.5" />
            Back
          </Link>

          <div
            className="flex flex-col gap-6 rounded-[var(--radius)] border border-border bg-card p-8"
            style={{ boxShadow: "var(--oc-shadow-2)" }}
          >
            <div className="flex items-center gap-3">
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-[8px] font-semibold text-[15px]"
                style={{
                  background: "var(--oc-accent-soft)",
                  border: "1px solid var(--oc-accent-line)",
                  color: "var(--oc-accent)",
                }}
              >
                ◆
              </span>
              <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.14em]">
                OpenCoven Agents
              </span>
            </div>

            {children}
          </div>

          <p className="text-center text-[12px] text-muted-foreground">
            Agents run in isolated sandboxes with credentials you supply.
          </p>
        </div>
      </div>
    </SessionProvider>
  );
}
