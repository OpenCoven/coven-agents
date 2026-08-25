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

      <h1 className="font-semibold text-2xl tracking-tight">Welcome</h1>
      <p className="text-muted-foreground text-sm">
        Sign in to continue to OpenCoven Agents.
      </p>

      <div className="pt-2">
        <GithubSignIn callbackUrl="/agents" />
      </div>
    </>
  );
}
