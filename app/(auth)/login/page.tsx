"use client";

import { Suspense } from "react";
import { BetaNotice } from "@/components/chat/beta-notice";
import { GithubSignInWithCallback } from "@/components/chat/github-sign-in";

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
        in never starts an agent or a run. Sandbox warming begins only from an
        authenticated subscriber console.
      </p>
      {/* The boundary, stated where a stranger first meets the product. */}
      <p className="font-mono text-[11px] text-muted-foreground">
        Agents run in isolated Daytona sandboxes — never on your machine.
      </p>

      <div className="pt-2">
        <Suspense fallback={null}>
          <GithubSignInWithCallback />
        </Suspense>
      </div>
    </>
  );
}
