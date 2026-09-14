"use client";

import { getSession, useSession } from "next-auth/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  confirmSessionExpired,
  SESSION_REAUTHENTICATION_EVENT,
  SESSION_RECOVERY_TIMEOUT_MS,
  sessionExpiredLoginPath,
  synchronizeSessionProvider,
} from "@/lib/auth/session-recovery";

export function SessionRecovery() {
  const { status } = useSession();
  const previouslyAuthenticated = useRef(false);
  const attempted = useRef(false);
  const statusRef = useRef(status);
  const providerReadyRef = useRef<(() => void) | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const recover = useCallback(async () => {
    if (attempted.current) {
      return;
    }
    attempted.current = true;
    setRecovering(true);
    const signal = AbortSignal.timeout(SESSION_RECOVERY_TIMEOUT_MS);
    try {
      const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
      if (await confirmSessionExpired(globalThis.fetch, basePath, signal)) {
        setUnavailable(false);
        window.location.replace(
          sessionExpiredLoginPath(
            `${window.location.pathname}${window.location.search}${window.location.hash}`,
            basePath
          )
        );
      } else {
        if (statusRef.current !== "authenticated") {
          const providerReady = new Promise<void>((resolve) => {
            providerReadyRef.current = resolve;
          });
          // getSession's supported broadcast makes SessionProvider re-read
          // even its cached null. Wait for context too, not just a valid cookie.
          await synchronizeSessionProvider(getSession, providerReady, signal);
        }
        setUnavailable(false);
        attempted.current = false;
      }
    } catch {
      // Never sign out on network/DB/rate-limit failures. Retry is explicit so
      // concurrent API refusals cannot turn recovery into a request loop.
      setUnavailable(true);
    } finally {
      providerReadyRef.current = null;
      setRecovering(false);
    }
  }, []);

  useLayoutEffect(() => {
    const onRefusal = () => {
      recover();
    };
    window.addEventListener(SESSION_REAUTHENTICATION_EVENT, onRefusal);
    return () =>
      window.removeEventListener(SESSION_REAUTHENTICATION_EVENT, onRefusal);
  }, [recover]);

  useEffect(() => {
    statusRef.current = status;
    if (status === "authenticated") {
      previouslyAuthenticated.current = true;
      providerReadyRef.current?.();
    } else if (
      status === "unauthenticated" &&
      previouslyAuthenticated.current
    ) {
      recover();
    }
  }, [recover, status]);

  const retry = useCallback(() => {
    attempted.current = false;
    recover();
  }, [recover]);

  return unavailable ? (
    <div
      aria-busy={recovering}
      className="relative z-50 bg-background p-3 text-sm"
      role="status"
    >
      Session verification is temporarily unavailable. Your session has not been
      signed out.{" "}
      <button
        className="underline"
        disabled={recovering}
        onClick={retry}
        type="button"
      >
        Retry session verification
      </button>
    </div>
  ) : null;
}
