"use client";

import { Check, ExternalLink } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "@/components/chat/toast";
import { Button } from "@/components/ui/button";
import {
  createDeviceFlowAttempt,
  requestDeviceFlowStart,
  type StartedDeviceFlow,
} from "@/lib/credentials/device-flow-attempt";

/**
 * One-click Copilot connection.
 *
 * The tenant never sees a token. They click, approve on GitHub, and the
 * access and refresh tokens go straight into encrypted storage — the refresh
 * token being what keeps the credential alive past its eight-hour lifetime.
 *
 * The paste field remains beneath this, because device flow is interactive by
 * design and a fine-grained PAT is still the right answer for anyone
 * configuring a machine rather than themselves.
 */
export function ConnectCopilot({
  configured,
  onConnected,
}: {
  configured: boolean;
  onConnected: () => void;
}) {
  const [started, setStarted] = useState<StartedDeviceFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const [startAttempt] = useState(() =>
    createDeviceFlowAttempt(() => crypto.randomUUID())
  );
  const stopped = useRef(false);

  /**
   * Polls for the authorization result.
   *
   * Self-scheduling rather than a loop: each attempt must observe the result
   * of the last, and GitHub answers `slow_down` if asked faster than the
   * interval it named. Backing off on that is what keeps the flow landing --
   * continuing at the old rate earns `slow_down` indefinitely.
   */
  const poll = useCallback(
    (session: StartedDeviceFlow) => {
      const deadline = Date.now() + 15 * 60 * 1000;
      let waitMs = session.interval * 1000;

      const attempt = () => {
        if (stopped.current || Date.now() > deadline) {
          return;
        }

        const ask = async (): Promise<{ status?: string } | null> => {
          const response = await fetch("/api/credentials/device", {
            body: JSON.stringify({ deviceCode: session.deviceCode }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          });

          return (await response.json().catch(() => null)) as {
            status?: string;
          } | null;
        };

        ask()
          .then((body) => {
            if (stopped.current) {
              return;
            }

            if (body?.status === "authorized") {
              toast({ description: "Copilot connected.", type: "success" });
              setStarted(null);
              onConnected();
              return;
            }

            if (body?.status === "denied") {
              toast({
                description: "Authorization was declined.",
                type: "error",
              });
              setStarted(null);
              return;
            }

            if (body?.status === "expired") {
              toast({
                description: "That code expired. Try again.",
                type: "error",
              });
              setStarted(null);
              return;
            }

            if (body?.status === "slow_down") {
              waitMs += 5000;
            }

            setTimeout(attempt, waitMs);
          })
          .catch(() => {
            setTimeout(attempt, waitMs);
          });
      };

      setTimeout(attempt, waitMs);
    },
    [onConnected]
  );

  const connect = useCallback(async () => {
    setBusy(true);
    stopped.current = false;

    try {
      const session = await requestDeviceFlowStart({
        attempt: startAttempt,
        fetcher: fetch,
      });

      setStarted(session);
      window.open(session.verificationUri, "_blank", "noopener,noreferrer");
      poll(session);
    } catch {
      toast({
        description: "Could not start the GitHub connection.",
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  }, [poll, startAttempt]);

  if (started) {
    return (
      <div className="flex flex-col gap-3 rounded-[8px] border border-[var(--oc-accent-line)] bg-[var(--oc-accent-soft)] p-5">
        <p className="text-[13px]">
          Enter this code on GitHub, then come back — this page updates itself.
        </p>

        <div className="font-mono text-[24px] tracking-[0.2em]">
          {started.userCode}
        </div>

        <a
          className="flex w-fit items-center gap-1.5 text-[13px] text-[var(--oc-accent)] underline-offset-4 hover:underline"
          href={started.verificationUri}
          rel="noopener noreferrer"
          target="_blank"
        >
          Open github.com/login/device
          <ExternalLink className="size-3.5" />
        </a>
      </div>
    );
  }

  return (
    <Button
      className="h-10 w-full rounded-[8px] font-semibold text-[13px]"
      disabled={busy}
      onClick={connect}
      type="button"
      variant={configured ? "outline" : "default"}
    >
      {configured ? (
        <>
          <Check className="size-4" />
          Reconnect GitHub Copilot
        </>
      ) : (
        "Connect GitHub Copilot"
      )}
    </Button>
  );
}
