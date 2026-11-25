import { Suspense } from "react";
import { BetaNotice } from "@/components/chat/beta-notice";
import { GithubSignInWithCallback } from "@/components/chat/github-sign-in";

export default function Page() {
  return (
    <>
      <Suspense fallback={null}>
        <BetaNotice />
      </Suspense>

      <h1 className="font-semibold text-2xl tracking-tight">
        Create or access your account
      </h1>
      <p className="text-muted-foreground text-sm">
        {process.env.WORKOS_AUTH_ENABLED === "1"
          ? "Continue with WorkOS to sign in or request access. Joining the waitlist does not start an agent or grant execution access."
          : "Continue with GitHub. New accounts start with guest access, and signing in never starts an agent or a run. Sandbox warming begins only from an authenticated subscriber console."}
      </p>
      {/* The boundary, stated where a stranger first meets the product. Set
          as a rule with a mark rather than loose fine print so it reads as a
          guarantee, not a disclaimer. */}
      <p className="flex items-center gap-2.5 border-border border-t pt-4 font-mono text-[11px] text-muted-foreground">
        <span
          aria-hidden="true"
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: "var(--oc-accent)" }}
        />
        Agents run in isolated Daytona sandboxes — never on your machine.
      </p>

      <div className="pt-2">
        <Suspense fallback={null}>
          <GithubSignInWithCallback
            provider={
              process.env.WORKOS_AUTH_ENABLED === "1" ? "workos" : "github"
            }
          />
        </Suspense>
      </div>
    </>
  );
}
