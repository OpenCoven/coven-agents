// biome-ignore-all lint/performance/noJsxPropsBind: the console keeps each handler beside the control it drives; hoisting them would separate the state a control changes from the control itself.

"use client";

import type { RunLiveView } from "@opencoven/agent-contracts";
import { ExternalLink, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Btn, Eyebrow, Spinner } from "@/components/console/primitives";
import { pill, type as type_ } from "@/components/console/styles";
import type { RunnerClient } from "@/lib/agents/client";

/**
 * A window onto the sandbox desktop while the agent works.
 *
 * Everything else in the console is credential-safe by construction — the
 * record is redacted before it is stored. This is the one surface that is
 * not: it is the raw desktop, signed for a few minutes, shown only to the
 * run's owner while the run is executing. The panel says so in words rather
 * than hoping the reader infers it.
 */

/** Refresh this long before the signed URL lapses, so the frame never dies. */
const REFRESH_MARGIN_MS = 45_000;

type LiveViewState =
  | { kind: "connecting" }
  | { kind: "error" }
  | { expiresAt: string; kind: "ready"; url: string }
  | {
      kind: "unavailable";
      reason: Extract<RunLiveView, { kind: "unavailable" }>["reason"];
    };

const UNAVAILABLE_COPY: Record<
  Extract<LiveViewState, { kind: "unavailable" }>["reason"],
  { detail: string; title: string }
> = {
  desktop_unavailable: {
    detail:
      "This sandbox image runs headless, so there is no screen to show. The record below is the live feed of what the agent does.",
    title: "No desktop in this sandbox",
  },
  not_configured: {
    detail:
      "This deployment has not enabled live sandbox views. The record below still updates as the agent works.",
    title: "Live view is off here",
  },
  not_running: {
    detail:
      "The sandbox is only viewable while the run is executing. Open live view again once the run is under way.",
    title: "Nothing running to watch",
  },
  provider_unavailable: {
    detail: "The sandbox provider did not answer. Try again in a moment.",
    title: "Could not reach the sandbox",
  },
  sandbox_missing: {
    detail:
      "The agent's sandbox has not been provisioned yet, or has been reclaimed. It appears here once the runner attaches to it.",
    title: "Sandbox not available",
  },
};

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((Date.parse(expiresAt) - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function LiveViewPanel({
  client,
  now,
  onClose,
  runId,
  running,
}: {
  client: Pick<RunnerClient, "getRunLiveView">;
  now: number;
  onClose: () => void;
  runId: string;
  running: boolean;
}) {
  const [state, setState] = useState<LiveViewState>({ kind: "connecting" });
  const reloadRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!running) {
      setState({ kind: "unavailable", reason: "not_running" });
      reloadRef.current = () => undefined;
      return;
    }
    let controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const load = () => {
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      setState((current) =>
        current.kind === "ready" ? current : { kind: "connecting" }
      );
      client
        .getRunLiveView(runId, signal)
        .then((view) => {
          if (signal.aborted || disposed) {
            return;
          }
          setState(view);
          if (view.kind === "ready") {
            // Re-sign before the URL lapses so the frame never goes dark.
            const delay = Math.max(
              5000,
              Date.parse(view.expiresAt) - Date.now() - REFRESH_MARGIN_MS
            );
            timer = setTimeout(load, delay);
          }
        })
        .catch(() => {
          if (!(signal.aborted || disposed)) {
            setState({ kind: "error" });
          }
        });
    };

    reloadRef.current = load;
    load();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [client, runId, running]);

  const retry = () => {
    setState({ kind: "connecting" });
    reloadRef.current();
  };

  return (
    <section aria-label="Live sandbox view" className="oc-live-view">
      <div className="oc-live-view__head">
        <Eyebrow>Live view</Eyebrow>
        <span style={pill("warning")}>Unredacted</span>
        <span className="oc-live-view__note">
          The sandbox screen as it is, before the record's redaction. Only you
          can see it, and only while this run executes.
        </span>
        <div style={{ flex: 1 }} />
        {state.kind === "ready" ? (
          <>
            <span
              className="oc-live-view__ttl"
              title="Time until this view is re-signed"
            >
              {remaining(state.expiresAt, now)}
            </span>
            <a
              className="oc-live-view__open"
              href={state.url}
              rel="noopener noreferrer"
              target="_blank"
              title="Open the live view in its own tab"
            >
              <ExternalLink aria-hidden="true" size={12} />
              Open in new tab
            </a>
          </>
        ) : null}
        <button
          aria-label="Close live view"
          className="oc-tint oc-live-view__close"
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={13} />
        </button>
      </div>

      <div className="oc-live-view__stage" data-state={state.kind}>
        {state.kind === "ready" ? (
          <iframe
            allow="clipboard-read; clipboard-write"
            className="oc-live-view__frame"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock"
            src={state.url}
            title="Live sandbox desktop"
          />
        ) : state.kind === "connecting" ? (
          <div className="oc-live-view__message">
            <Spinner />
            <span style={type_.label}>Connecting to the sandbox desktop</span>
            <span style={type_.meta}>
              Starting the display if it is not already up — this can take a few
              seconds.
            </span>
          </div>
        ) : state.kind === "error" ? (
          <div className="oc-live-view__message">
            <span style={type_.label}>Could not reach the runner</span>
            <span style={type_.meta}>
              The live view request did not complete. The record keeps streaming
              regardless.
            </span>
            <Btn onClick={retry} size="xs" variant="secondary">
              Try again
            </Btn>
          </div>
        ) : (
          <div className="oc-live-view__message">
            <span style={type_.label}>
              {UNAVAILABLE_COPY[state.reason].title}
            </span>
            <span style={{ ...type_.meta, maxWidth: "46ch" }}>
              {UNAVAILABLE_COPY[state.reason].detail}
            </span>
            {state.reason === "provider_unavailable" ||
            state.reason === "sandbox_missing" ? (
              <Btn onClick={retry} size="xs" variant="secondary">
                Try again
              </Btn>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}
