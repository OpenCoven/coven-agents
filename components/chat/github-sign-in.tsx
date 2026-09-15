"use client";

import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { useCallback, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  APPLICATION_CALLBACK_PARAM,
  safeApplicationCallbackPath,
} from "@/lib/application-path";

/**
 * One-click sign-in.
 *
 * Use the provider selected by the server login page. WorkOS owns waitlist registration
 * when enabled; the legacy component name preserves existing callers.
 */
export function GithubSignIn({
  callbackUrl = "/",
  provider = "github",
}: {
  callbackUrl?: string;
  provider?: "github" | "workos";
}) {
  const safeCallbackUrl = safeApplicationCallbackPath(
    callbackUrl,
    process.env.NEXT_PUBLIC_BASE_PATH ?? ""
  );
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const start = useCallback(
    async (screenHint?: "sign-up") => {
      if (pendingRef.current) {
        return;
      }

      pendingRef.current = true;
      setPending(true);
      setError(null);

      const showRetry = () => {
        pendingRef.current = false;
        setPending(false);
        setError(
          `We couldn’t start ${provider === "workos" ? "WorkOS" : "GitHub"} sign-in. Please try again.`
        );
      };

      try {
        const result = await signIn(
          provider,
          {
            redirect: false,
            redirectTo: safeCallbackUrl,
          },
          screenHint ? { screen_hint: screenHint } : {}
        );

        if (!(result.ok && result.url)) {
          showRetry();
          return;
        }

        const authorizationUrl = new URL(result.url, window.location.href);
        const loopsToCurrentPage =
          authorizationUrl.origin === window.location.origin &&
          authorizationUrl.pathname === window.location.pathname;

        if (
          !["http:", "https:"].includes(authorizationUrl.protocol) ||
          loopsToCurrentPage
        ) {
          showRetry();
          return;
        }

        window.location.assign(authorizationUrl.href);
      } catch {
        showRetry();
      }
    },
    [safeCallbackUrl, provider]
  );

  const startSignIn = useCallback(() => start(), [start]);
  const joinWaitlist = useCallback(() => start("sign-up"), [start]);

  return (
    <div className="flex flex-col gap-4">
      <Button
        className="h-10 w-full rounded-[8px] border-border bg-secondary font-semibold text-[13px] hover:border-[var(--oc-text-3)]"
        disabled={pending}
        onClick={startSignIn}
        type="button"
        variant="outline"
      >
        {provider === "github" ? (
          <svg
            aria-hidden="true"
            className="size-4"
            fill="currentColor"
            viewBox="0 0 16 16"
          >
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
        ) : null}
        {pending
          ? "Redirecting…"
          : provider === "workos"
            ? "Continue with WorkOS"
            : provider === "github"
              ? "Continue with GitHub"
              : "Loading sign-in…"}
      </Button>
      {provider === "workos" ? (
        <Button disabled={pending} onClick={joinWaitlist} type="button">
          Join the waitlist
        </Button>
      ) : null}
      {error ? (
        <p
          aria-live="assertive"
          className="text-destructive text-sm"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function GithubSignInWithCallback({
  provider = "github",
}: {
  provider?: "github" | "workos";
}) {
  const searchParams = useSearchParams();
  const callbackUrl = safeApplicationCallbackPath(
    searchParams.get(APPLICATION_CALLBACK_PARAM),
    process.env.NEXT_PUBLIC_BASE_PATH ?? ""
  );

  return (
    <>
      {searchParams.get("reason") === "session-expired" ? (
        <p className="mb-4 text-sm" role="status">
          Your session has expired. Sign in again to continue.
        </p>
      ) : null}
      <GithubSignIn callbackUrl={callbackUrl} provider={provider} />
    </>
  );
}
