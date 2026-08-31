"use client";

import { Check, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "@/components/chat/toast";
import { Button } from "@/components/ui/button";
import type { StartedDeviceFlow } from "@/lib/credentials/device-flow-attempt";
import {
  createDeviceFlowController,
  type DeviceFlowAuthorityContext,
  type DeviceFlowController,
  type DeviceFlowViewState,
} from "@/lib/credentials/device-flow-client";

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
  authorityContextRevision,
  authorityRevision,
  configured,
  isSubscriber,
  onAuthorityInvalidated,
  onConnected,
}: {
  authorityContextRevision: string;
  authorityRevision: string | null;
  configured: boolean;
  isSubscriber: boolean;
  onAuthorityInvalidated: () => void;
  onConnected: () => void;
}) {
  const [started, setStarted] = useState<StartedDeviceFlow | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(false);
  const authorityContext: DeviceFlowAuthorityContext = {
    key: `${authorityContextRevision}:${isSubscriber ? "subscriber" : "demo"}`,
    revision: authorityRevision,
    valid: isSubscriber && authorityRevision !== null,
  };
  const authorityContextRef = useRef(authorityContext);
  authorityContextRef.current = authorityContext;
  const callbackRef = useRef({
    onAuthorityInvalidated,
    onConnected,
  });
  callbackRef.current = {
    onAuthorityInvalidated,
    onConnected,
  };
  const controllerRef = useRef<DeviceFlowController | null>(null);
  if (!controllerRef.current) {
    const publishState = (state: DeviceFlowViewState) => {
      if (!mountedRef.current) {
        return;
      }
      setBusy(state.busy);
      setStarted(state.started);
    };
    controllerRef.current = createDeviceFlowController({
      cancel: (handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      fetcher: fetch,
      generateKey: () => crypto.randomUUID(),
      getAuthority: () => authorityContextRef.current,
      onAuthorityInvalidated: () => {
        if (mountedRef.current) {
          callbackRef.current.onAuthorityInvalidated();
        }
      },
      onConnected: () => {
        if (mountedRef.current) {
          callbackRef.current.onConnected();
        }
      },
      onNotice: ({ message, type }) => {
        if (mountedRef.current) {
          toast({ description: message, type });
        }
      },
      onOpenVerification: (uri) => {
        if (mountedRef.current) {
          window.open(uri, "_blank", "noopener,noreferrer");
        }
      },
      onState: publishState,
      schedule: (callback, delay) =>
        setTimeout(() => {
          Promise.resolve(callback()).catch(() => undefined);
        }, delay),
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    controller.authorityChanged({
      key: authorityContext.key,
      revision: authorityRevision,
      valid: authorityContext.valid,
    });
  }, [
    authorityContext.key,
    authorityContext.valid,
    authorityRevision,
    controller,
  ]);

  const connect = useCallback(() => {
    controller.start().catch(() => {
      if (mountedRef.current) {
        toast({
          description: "Could not start the GitHub connection.",
          type: "error",
        });
      }
    });
  }, [controller]);

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
      disabled={busy || !authorityContext.valid}
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
