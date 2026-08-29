"use client";

import { Suspense } from "react";
import { BetaNotice } from "@/components/chat/beta-notice";
import { GithubSignIn } from "@/components/chat/github-sign-in";

/**
 * GitHub is the only way in.
 *
 * The password form is gone with the Credentials provider: there was no mail
 * delivery, so a forgotten password was unrecoverable, and two sign-in paths
 * meant two sets of rules about who may enter.
 */
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
        Continue with GitHub. New accounts start with guest access, and signing
        in never starts an agent, sandbox, or run.
      </p>
      <p className="font-mono text-[11px] text-muted-foreground/70">
        Agents run in isolated Daytona sandboxes — filesystem and network end
        with the sandbox.
      </p>

      <div className="pt-2">
        <GithubSignIn callbackUrl="/" />
      </div>
    </>
  );
}
