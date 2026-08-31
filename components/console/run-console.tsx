// biome-ignore-all lint/performance/noJsxPropsBind: this console keeps each handler beside the control it drives; hoisting them would put the state they close over a screen away from the button that changes it.

"use client";

import type {
  AgentDefinition,
  CreateAgentInput,
  RunEvent,
  RunSnapshot,
} from "@opencoven/agent-contracts";
import {
  sanitizeEvidencePath,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";
import { MoreHorizontal, Search } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { BrandMark } from "@/components/brand/brand-mark";
import { AGENT_RAIL_WIDTHS, AgentRail } from "@/components/console/agent-rail";
import { Analytics } from "@/components/console/analytics";
import {
  CommandPalette,
  type PaletteItem,
} from "@/components/console/command-palette";
import { Composer } from "@/components/console/composer";
import { CreateAgent } from "@/components/console/create-agent";
import {
  Btn,
  Eyebrow,
  LifecycleBadge,
  Spinner,
} from "@/components/console/primitives";
import { ProfileSelector } from "@/components/console/profile-selector";
import { ReportReader } from "@/components/console/report-reader";
import {
  LiveActivityStatus,
  ThreadBlockView,
} from "@/components/console/run-thread";
import { RuntimeInspector } from "@/components/console/runtime-inspector";
import { Settings } from "@/components/console/settings";
import {
  STEPS_TIMELINE_WIDTHS,
  StepsTimeline,
} from "@/components/console/steps-timeline";
import {
  hairline,
  pill,
  tabular,
  truncate,
  type as type_,
  well,
} from "@/components/console/styles";
import { useSubscriptionAuthorityRefresh } from "@/hooks/use-subscription-authority-refresh";
import { RunnerApiError, RunnerClient } from "@/lib/agents/client";
import {
  type ApplicationRunnerStatusKind,
  applicationRunnerMessage,
  applicationRunnerStatusFromError,
} from "@/lib/agents/connection-status";
import type { Formation } from "@/lib/agents/formations";
import { memberName } from "@/lib/agents/formations";
import { browserApplicationLoginHref } from "@/lib/application-path";
import { avatarFor } from "@/lib/avatar";
import { isTerminal, projectRun } from "@/lib/console/blocks";
import { formatDuration, glyphFor, spanBetween } from "@/lib/console/format";
import type { SessionOperationContext } from "@/lib/console/session-operation";
import type { ConsoleRun } from "@/lib/console/types";
import {
  fetchHasCredential,
  resetCredentialCache,
  updateCredentialEligibility,
} from "@/lib/credentials/client";
import {
  effectiveSubscriptionAuthority,
  type SubscriptionAuthority,
  subscriptionAuthorityExpiryBoundary,
} from "@/lib/subscription-authority";

const TICK_MS = 1000;
const COMPACT_VIEWPORT_MAX = 720;
const NARROW_VIEWPORT_MAX = 980;
const MIN_RUN_RECORD_WIDTH = 360;
const OVERLAY_VIEWPORT_RATIO = 0.86;

function clampWidth(width: number, min: number, max: number) {
  return Math.min(max, Math.max(Math.min(min, max), width));
}

/**
 * The word the header pill wears.
 *
 * Written out rather than rendering the status kind directly: those are
 * protocol identifiers, and `SIGNED_OUT` in a pill is an implementation detail
 * leaking into the one place that is supposed to explain the state.
 */
const CONNECTION_LABELS: Record<ApplicationRunnerStatusKind, string> = {
  connected: "connected",
  connecting: "connecting",
  rate_limited: "rate limited",
  signed_out: "signed out",
  subscription_required: "no subscription",
  unavailable: "unreachable",
};

type View = "analytics" | "composer" | "create" | "settings" | "thread";

/**
 * The run console.
 *
 * Three panes: the profiles on the left, the record in the middle, the index of
 * it on the right. The record is the product — everything else is a way to get
 * to one, or a way to start one that will produce another.
 */
export function RunConsole({
  checkoutEnabled,
  subscriptionAuthority,
}: {
  checkoutEnabled: boolean;
  subscriptionAuthority: SubscriptionAuthority;
}) {
  const session = useSession();
  /**
   * Who the console attributes a mission to.
   *
   * Null when nobody is signed in, and the surface says so. The earlier
   * fallback was the string "signed in", which the rail then rendered as if it
   * were an account name — directly contradicting the header pill next to it.
   */
  const account = session.data?.user?.email ?? null;
  const who = account ?? "not signed in";
  /**
   * The account's picture, or null when nobody is signed in.
   *
   * Seeded by the user id rather than the email, so the identicon does not
   * change when someone changes their address.
   */
  const accountId = session.data?.user?.id ?? null;
  const serverAuthority = effectiveSubscriptionAuthority(
    subscriptionAuthority,
    accountId
  );
  const { authorityPending, authorityRevision, invalidateAndRefresh } =
    useSubscriptionAuthorityRefresh({
      authority: subscriptionAuthority,
      authVersion: session.data?.user?.authVersion,
      isSubscriber: serverAuthority.isSubscriber,
      status: session.status,
      subscribedUntil: subscriptionAuthorityExpiryBoundary(
        subscriptionAuthority,
        accountId
      ),
      type: session.data?.user?.type,
      userId: accountId,
    });
  const { isSubscriber, subscribedUntil } = effectiveSubscriptionAuthority(
    subscriptionAuthority,
    accountId,
    authorityPending
  );
  const sessionIdentity = [
    session.status,
    accountId ?? "",
    isSubscriber ? "subscriber" : "demo",
    session.data?.user?.authVersion ?? "",
    authorityRevision ?? "",
  ].join(":");
  const avatarSrc = accountId
    ? avatarFor({ id: accountId, image: session.data?.user?.image })
    : null;

  const [runnerStatus, setRunnerStatus] =
    useState<ApplicationRunnerStatusKind>("connecting");
  const [hasCredential, setHasCredential] = useState<boolean | null>(null);
  const [settingsOperationContext, setSettingsOperationContext] =
    useState<SessionOperationContext | null>(null);

  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ConsoleRun[]>([]);
  const [pendingRunHistoryAgentIds, setPendingRunHistoryAgentIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [threadOpenRevision, setThreadOpenRevision] = useState(0);
  const [streamingRunId, setStreamingRunId] = useState<string | null>(null);

  const [view, setView] = useState<View>("composer");
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);

  const [railCollapsed, setRailCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [agentRailWidth, setAgentRailWidth] = useState<number>(
    AGENT_RAIL_WIDTHS.default
  );
  const [stepsTimelineWidth, setStepsTimelineWidth] = useState<number>(
    STEPS_TIMELINE_WIDTHS.default
  );
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [reportReader, setReportReader] = useState<{
    content: string;
    title: string;
  } | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [runMenuOpen, setRunMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [removing, setRemoving] = useState(false);
  const [copiedReceipt, setCopiedReceipt] = useState(false);
  /**
   * The clock the elapsed figures are read against.
   *
   * Zero until the browser has it. Reading `Date.now()` while rendering would
   * be evaluated once during the prerender and then baked into the static
   * output, so every visitor would start counting from whenever the page was
   * built. Zero is the honest "not known yet", and the console prints an em
   * dash for it.
   */
  const [now, setNow] = useState(0);

  useEffect(() => {
    const compactViewport = window.matchMedia(
      `(max-width: ${COMPACT_VIEWPORT_MAX}px)`
    );
    const narrowViewport = window.matchMedia(
      `(max-width: ${NARROW_VIEWPORT_MAX}px)`
    );
    const collapseForViewport = () => {
      if (compactViewport.matches) {
        setRailCollapsed(true);
      }
      if (narrowViewport.matches) {
        setTimelineCollapsed(true);
      }
    };

    collapseForViewport();
    compactViewport.addEventListener("change", collapseForViewport);
    narrowViewport.addEventListener("change", collapseForViewport);
    return () => {
      compactViewport.removeEventListener("change", collapseForViewport);
      narrowViewport.removeEventListener("change", collapseForViewport);
    };
  }, []);

  useEffect(() => {
    const syncViewportWidth = () => setViewportWidth(window.innerWidth);
    syncViewportWidth();
    window.addEventListener("resize", syncViewportWidth);
    return () => window.removeEventListener("resize", syncViewportWidth);
  }, []);

  const stepsOverlay =
    viewportWidth > 0 && viewportWidth <= NARROW_VIEWPORT_MAX;
  const navigationOverlay =
    viewportWidth > 0 && viewportWidth <= COMPACT_VIEWPORT_MAX;
  const hasStepsTimeline = selectedRunId !== null;
  let agentRailWidthLimit: number = AGENT_RAIL_WIDTHS.max;
  let stepsTimelineWidthLimit: number = STEPS_TIMELINE_WIDTHS.max;
  let renderedAgentRailWidth = agentRailWidth;
  let renderedStepsTimelineWidth = stepsTimelineWidth;

  if (viewportWidth > 0) {
    const bothPanelsInFlow =
      !railCollapsed &&
      !navigationOverlay &&
      hasStepsTimeline &&
      !timelineCollapsed &&
      !stepsOverlay;

    if (bothPanelsInFlow) {
      const availableForPanels = Math.max(
        0,
        viewportWidth - MIN_RUN_RECORD_WIDTH
      );
      const reservedStepsWidth = Math.min(
        STEPS_TIMELINE_WIDTHS.min,
        availableForPanels
      );
      const initialAgentLimit = Math.min(
        AGENT_RAIL_WIDTHS.max,
        Math.max(0, availableForPanels - reservedStepsWidth)
      );
      renderedAgentRailWidth = clampWidth(
        agentRailWidth,
        AGENT_RAIL_WIDTHS.min,
        initialAgentLimit
      );
      stepsTimelineWidthLimit = Math.min(
        STEPS_TIMELINE_WIDTHS.max,
        Math.max(0, availableForPanels - renderedAgentRailWidth)
      );
      renderedStepsTimelineWidth = clampWidth(
        stepsTimelineWidth,
        STEPS_TIMELINE_WIDTHS.min,
        stepsTimelineWidthLimit
      );
      agentRailWidthLimit = Math.min(
        AGENT_RAIL_WIDTHS.max,
        Math.max(0, availableForPanels - renderedStepsTimelineWidth)
      );
      renderedAgentRailWidth = clampWidth(
        agentRailWidth,
        AGENT_RAIL_WIDTHS.min,
        agentRailWidthLimit
      );
    } else {
      const stepsFootprint = hasStepsTimeline
        ? timelineCollapsed
          ? STEPS_TIMELINE_WIDTHS.collapsed
          : 0
        : 0;
      agentRailWidthLimit = Math.min(
        AGENT_RAIL_WIDTHS.max,
        navigationOverlay
          ? Math.floor(viewportWidth * OVERLAY_VIEWPORT_RATIO)
          : Math.max(0, viewportWidth - stepsFootprint - MIN_RUN_RECORD_WIDTH)
      );
      renderedAgentRailWidth = clampWidth(
        agentRailWidth,
        AGENT_RAIL_WIDTHS.min,
        agentRailWidthLimit
      );

      const navigationFootprint = railCollapsed
        ? AGENT_RAIL_WIDTHS.collapsed
        : navigationOverlay
          ? 0
          : renderedAgentRailWidth;
      stepsTimelineWidthLimit = Math.min(
        STEPS_TIMELINE_WIDTHS.max,
        stepsOverlay
          ? Math.floor(viewportWidth * OVERLAY_VIEWPORT_RATIO)
          : Math.max(
              0,
              viewportWidth - navigationFootprint - MIN_RUN_RECORD_WIDTH
            )
      );
      renderedStepsTimelineWidth = clampWidth(
        stepsTimelineWidth,
        STEPS_TIMELINE_WIDTHS.min,
        stepsTimelineWidthLimit
      );
    }
  }

  const threadRef = useRef<HTMLDivElement>(null);
  const runsRef = useRef<ConsoleRun[]>([]);
  const credentialOwnerRef = useRef<string | null>(null);
  const activeSessionIdentityRef = useRef("");
  const latestSessionIdentityRef = useRef(sessionIdentity);
  const prewarmedIdentitiesRef = useRef(new Set<string>());
  const refreshGenerationRef = useRef(0);
  const sessionAbortRef = useRef<AbortController | null>(null);
  const sessionGenerationRef = useRef(0);
  latestSessionIdentityRef.current = sessionIdentity;
  runsRef.current = runs;

  const client = useMemo(() => new RunnerClient(), []);

  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedRun =
    runs.find((run) => run.snapshot.id === selectedRunId) ?? null;
  const runAgent = selectedRun
    ? (agents.find((agent) => agent.id === selectedRun.agentId) ?? null)
    : selectedAgent;

  const reportRunnerError = useCallback((error: unknown, fallback: string) => {
    if (error instanceof RunnerApiError) {
      const status = applicationRunnerStatusFromError(error);
      if (status) {
        setRunnerStatus(status);
      }
    }
    toast.error(
      error instanceof Error ? sanitizeEvidenceText(error.message) : fallback
    );
  }, []);

  const reconcileTerminalAgent = useCallback(
    (snapshot: Pick<RunSnapshot, "agentId" | "status">) => {
      if (!isTerminal(snapshot.status)) {
        return;
      }
      const status = snapshot.status === "failed" ? "error" : "idle";
      setAgents((current) =>
        current.map((agent) =>
          agent.id === snapshot.agentId ? { ...agent, status } : agent
        )
      );
    },
    []
  );

  /* ---------------------------------------------------------------- wiring */

  const onCredentialsChange = useCallback((harnessIds: readonly string[]) => {
    setHasCredential(updateCredentialEligibility(harnessIds));
  }, []);

  const isCurrentSession = useCallback(
    (generation: number, signal?: AbortSignal) =>
      sessionGenerationRef.current === generation &&
      activeSessionIdentityRef.current === latestSessionIdentityRef.current &&
      !signal?.aborted,
    []
  );

  const refresh = useCallback(
    async (generation: number, signal: AbortSignal) => {
      refreshGenerationRef.current += 1;
      const refreshGeneration = refreshGenerationRef.current;
      const isLatestRefresh = () =>
        refreshGenerationRef.current === refreshGeneration &&
        isCurrentSession(generation, signal);

      try {
        const next = await client.listAgents(signal);
        if (!isLatestRefresh()) {
          return;
        }
        setRunnerStatus("connected");
        setAgents(next);
        setPendingRunHistoryAgentIds(new Set(next.map((agent) => agent.id)));
        setSelectedAgentId((current) =>
          next.some((agent) => agent.id === current)
            ? current
            : (next[0]?.id ?? null)
        );

        // The runner remembers a bounded history per agent; without this a
        // reload shows an empty session list while the runs still exist.
        // Histories merge as each request resolves so one slow agent cannot
        // suppress every other profile's previews and search results.
        await Promise.all(
          next.map(async (agent) => {
            try {
              const snapshots = await client.listRuns(agent.id, signal);
              if (!isLatestRefresh()) {
                return;
              }
              const discovered = snapshots.map((snapshot) => ({
                agentId: agent.id,
                snapshot,
              }));
              setRuns((current) => {
                const known = new Set(current.map((run) => run.snapshot.id));
                return [
                  ...current,
                  ...discovered
                    .filter((run) => !known.has(run.snapshot.id))
                    .map((run) => ({ ...run, events: [], lastEventId: 0 })),
                ];
              });
              // A run that survived the refresh mid-flight resumes streaming;
              // its events replay from the start, so the transcript rebuilds.
              const live = discovered.find(
                (run) => !isTerminal(run.snapshot.status)
              )?.snapshot.id;
              if (live) {
                setStreamingRunId((current) => current ?? live);
              }
            } catch (error) {
              if (signal.aborted) {
                throw error;
              }
            } finally {
              if (isLatestRefresh()) {
                setPendingRunHistoryAgentIds((current) => {
                  const pending = new Set(current);
                  pending.delete(agent.id);
                  return pending;
                });
              }
            }
          })
        );
      } catch (error) {
        if (!isLatestRefresh()) {
          return;
        }
        setPendingRunHistoryAgentIds(new Set());
        setRunnerStatus(
          error instanceof RunnerApiError
            ? (applicationRunnerStatusFromError(error) ?? "unavailable")
            : "unavailable"
        );
        setAgents([]);
        reportRunnerError(error, "Could not reach the runner.");
      }
    },
    [client, isCurrentSession, reportRunnerError]
  );

  useEffect(() => {
    sessionGenerationRef.current += 1;
    refreshGenerationRef.current += 1;
    const generation = sessionGenerationRef.current;
    activeSessionIdentityRef.current = sessionIdentity;
    sessionAbortRef.current?.abort();
    const controller = new AbortController();
    sessionAbortRef.current = controller;

    setAgents([]);
    setSelectedAgentId(null);
    setRuns([]);
    setPendingRunHistoryAgentIds(new Set());
    setSelectedRunId(null);
    setStreamingRunId(null);
    setStarting(false);
    setBusy(false);
    setRenaming(false);
    setRemoving(false);
    setSettingsOperationContext(null);

    if (session.status === "loading") {
      setRunnerStatus("connecting");
      setHasCredential(null);
      return () => controller.abort();
    }
    if (session.status !== "authenticated" || !accountId) {
      setRunnerStatus("signed_out");
      setHasCredential(null);
      credentialOwnerRef.current = null;
      resetCredentialCache();
      return () => controller.abort();
    }
    if (!isSubscriber) {
      setRunnerStatus("subscription_required");
      setHasCredential(null);
      credentialOwnerRef.current = null;
      resetCredentialCache();
      return () => controller.abort();
    }

    setRunnerStatus("connecting");
    setSettingsOperationContext({
      generation,
      isCurrent: () => isCurrentSession(generation, controller.signal),
      signal: controller.signal,
    });
    if (credentialOwnerRef.current !== accountId) {
      credentialOwnerRef.current = accountId;
      resetCredentialCache();
    }
    fetchHasCredential()
      .then((has) => {
        if (!isCurrentSession(generation, controller.signal)) {
          return;
        }
        if (has === "subscription_required") {
          invalidateAndRefresh();
          return;
        }
        if (has !== null) {
          setHasCredential(has);
        }
      })
      .catch(() => undefined);
    if (!prewarmedIdentitiesRef.current.has(sessionIdentity)) {
      prewarmedIdentitiesRef.current.add(sessionIdentity);
      client.prewarmTenant(controller.signal).catch(() => undefined);
    }
    refresh(generation, controller.signal).catch(() => undefined);

    return () => controller.abort();
  }, [
    accountId,
    client,
    isCurrentSession,
    refresh,
    isSubscriber,
    invalidateAndRefresh,
    session.status,
    sessionIdentity,
  ]);

  const refreshCurrent = useCallback(() => {
    const controller = sessionAbortRef.current;
    if (!(controller && session.status === "authenticated" && isSubscriber)) {
      return Promise.resolve();
    }
    return refresh(sessionGenerationRef.current, controller.signal);
  }, [isSubscriber, refresh, session.status]);

  const currentSessionContext = useCallback(() => {
    const controller = sessionAbortRef.current;
    return controller && session.status === "authenticated" && isSubscriber
      ? {
          generation: sessionGenerationRef.current,
          signal: controller.signal,
        }
      : null;
  }, [isSubscriber, session.status]);

  useEffect(() => {
    if (session.status !== "authenticated" || runnerStatus !== "rate_limited") {
      return;
    }
    const timer = setTimeout(() => {
      refreshCurrent().catch(() => undefined);
    }, 60_000);
    return () => clearTimeout(timer);
  }, [refreshCurrent, runnerStatus, session.status]);

  /** Applies one streamed event to the run it belongs to. */
  const applyEvent = useCallback(
    (
      runId: string,
      event: RunEvent,
      options: Readonly<{ reconcileAgent?: boolean }> = {}
    ) => {
      const currentRun = runsRef.current.find(
        (run) => run.snapshot.id === runId
      );
      if (!currentRun || event.id <= currentRun.lastEventId) {
        return;
      }

      setRuns((current) =>
        current.map((run) => {
          if (run.snapshot.id !== runId || event.id <= run.lastEventId) {
            return run;
          }
          const snapshot =
            event.type === "completed"
              ? event.run
              : event.type === "status"
                ? { ...run.snapshot, status: event.status }
                : event.type === "failed"
                  ? { ...run.snapshot, status: "failed" as const }
                  : run.snapshot;
          return {
            ...run,
            events: [...run.events, event],
            lastEventId: event.id,
            snapshot,
          };
        })
      );
      if (options.reconcileAgent) {
        reconcileTerminalAgent({
          agentId:
            event.type === "completed" ? event.run.agentId : currentRun.agentId,
          status:
            event.type === "completed"
              ? event.run.status
              : event.type === "status"
                ? event.status
                : event.type === "failed"
                  ? "failed"
                  : currentRun.snapshot.status,
        });
      }
    },
    [reconcileTerminalAgent]
  );

  useEffect(() => {
    if (!streamingRunId || session.status !== "authenticated") {
      return;
    }
    const generation = sessionGenerationRef.current;
    const sessionController = sessionAbortRef.current;
    if (!sessionController || sessionController.signal.aborted) {
      return;
    }
    const sessionIsCurrent = () =>
      isCurrentSession(generation, sessionController.signal);
    const start = runsRef.current.find(
      (run) => run.snapshot.id === streamingRunId
    );
    if (!start || isTerminal(start.snapshot.status)) {
      if (sessionIsCurrent()) {
        setStreamingRunId(null);
      }
      return;
    }

    const controller = new AbortController();
    const abortForSession = () => controller.abort();
    sessionController.signal.addEventListener("abort", abortForSession, {
      once: true,
    });
    let cancelled = false;

    const follow = async () => {
      const cursor =
        runsRef.current.find((run) => run.snapshot.id === streamingRunId)
          ?.lastEventId ?? 0;
      try {
        const snapshot = await client.streamRunEvents(streamingRunId, {
          lastEventId: cursor,
          onEvent: (event) => {
            if (!cancelled && sessionIsCurrent()) {
              applyEvent(streamingRunId, event, { reconcileAgent: true });
            }
          },
          signal: controller.signal,
        });
        if (cancelled || !sessionIsCurrent()) {
          return;
        }
        setRuns((current) =>
          current.map((run) =>
            run.snapshot.id === streamingRunId ? { ...run, snapshot } : run
          )
        );
        reconcileTerminalAgent(snapshot);
        setStreamingRunId(null);
      } catch (error) {
        if (cancelled || controller.signal.aborted || !sessionIsCurrent()) {
          return;
        }
        setStreamingRunId(null);
        toast.error(
          error instanceof Error
            ? sanitizeEvidenceText(error.message)
            : "Lost the run's event stream."
        );
      }
    };

    follow().catch(() => undefined);

    return () => {
      cancelled = true;
      controller.abort();
      sessionController.signal.removeEventListener("abort", abortForSession);
    };
  }, [
    applyEvent,
    client,
    isCurrentSession,
    reconcileTerminalAgent,
    session.status,
    streamingRunId,
  ]);

  /**
   * Backfills the transcript of a finished run that was hydrated from the
   * runner's history. Hydration carries only the snapshot; the events still
   * live on the runner, and for a terminal run its stream replays them all
   * and closes, which makes it a one-shot transcript fetch. Live runs are
   * excluded — the streaming effect above owns those.
   */
  useEffect(() => {
    if (
      session.status !== "authenticated" ||
      !selectedRun ||
      selectedRun.events.length > 0 ||
      selectedRun.lastEventId > 0 ||
      !isTerminal(selectedRun.snapshot.status)
    ) {
      return;
    }
    const generation = sessionGenerationRef.current;
    const sessionController = sessionAbortRef.current;
    if (!sessionController || sessionController.signal.aborted) {
      return;
    }
    const runId = selectedRun.snapshot.id;
    const controller = new AbortController();
    const abortForSession = () => controller.abort();
    sessionController.signal.addEventListener("abort", abortForSession, {
      once: true,
    });
    client
      .streamRunEvents(runId, {
        onEvent: (event) => {
          if (isCurrentSession(generation, sessionController.signal)) {
            applyEvent(runId, event);
          }
        },
        signal: controller.signal,
      })
      .then((snapshot) => {
        if (!isCurrentSession(generation, sessionController.signal)) {
          return;
        }
        setRuns((current) =>
          current.map((run) =>
            run.snapshot.id === runId ? { ...run, snapshot } : run
          )
        );
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
      sessionController.signal.removeEventListener("abort", abortForSession);
    };
  }, [applyEvent, client, isCurrentSession, selectedRun, session.status]);

  const running = selectedRun
    ? !isTerminal(selectedRun.snapshot.status)
    : false;
  const threadRevision = selectedRun
    ? `${view}:${threadOpenRevision}:${selectedRun.snapshot.id}:${selectedRun.snapshot.status}:${selectedRun.events.length}`
    : "";

  useEffect(() => {
    setNow(Date.now());
  }, []);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  // Follow the tail while a run is live. Skipped once the reader scrolls up:
  // yanking someone back to the bottom mid-read is worse than a stale view.
  const pinnedRef = useRef(true);
  useEffect(() => {
    if (!threadRevision) {
      return;
    }
    const node = threadRef.current;
    if (node && pinnedRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [threadRevision]);

  /* --------------------------------------------------------------- actions */

  const blocked =
    runnerStatus === "connected"
      ? hasCredential === false
        ? "No harness credential stored — add one in account settings."
        : null
      : applicationRunnerMessage(runnerStatus);

  const startRun = async () => {
    if (!selectedAgent || blocked) {
      return;
    }
    const context = currentSessionContext();
    if (!context) {
      return;
    }
    const task = draft.trim();
    setStarting(true);
    try {
      const snapshot = await client.startRun(selectedAgent.id, task, {
        harnessId: selectedAgent.runtime,
        signal: context.signal,
      });
      if (!isCurrentSession(context.generation, context.signal)) {
        return;
      }
      setRuns((current) => [
        { agentId: selectedAgent.id, events: [], lastEventId: 0, snapshot },
        ...current,
      ]);
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selectedAgent.id
            ? { ...agent, status: "running" }
            : agent
        )
      );
      setSelectedRunId(snapshot.id);
      setStreamingRunId(snapshot.id);
      setView("thread");
      setDraft("");
      pinnedRef.current = true;
    } catch (error) {
      if (isCurrentSession(context.generation, context.signal)) {
        reportRunnerError(error, "The run could not start.");
      }
    } finally {
      if (isCurrentSession(context.generation, context.signal)) {
        setStarting(false);
      }
    }
  };

  const stopRun = async () => {
    if (!selectedRun) {
      return;
    }
    const context = currentSessionContext();
    if (!context) {
      return;
    }
    try {
      const snapshot = await client.stopRun(
        selectedRun.snapshot.id,
        context.signal
      );
      if (!isCurrentSession(context.generation, context.signal)) {
        return;
      }
      setRuns((current) =>
        current.map((run) =>
          run.snapshot.id === snapshot.id ? { ...run, snapshot } : run
        )
      );
      reconcileTerminalAgent(snapshot);
      toast.success("Run cancelled.");
    } catch (error) {
      if (isCurrentSession(context.generation, context.signal)) {
        reportRunnerError(error, "Could not stop the run.");
      }
    }
  };

  const createAgent = async (input: CreateAgentInput) => {
    const context = currentSessionContext();
    if (!context) {
      return;
    }
    setBusy(true);
    try {
      const created = await client.createAgent(input, context.signal);
      if (!isCurrentSession(context.generation, context.signal)) {
        return;
      }
      setAgents((current) => [created, ...current]);
      setSelectedAgentId(created.id);
      setView("composer");
      toast.success(`${sanitizeEvidenceText(created.name)} is ready.`);
    } catch (error) {
      if (isCurrentSession(context.generation, context.signal)) {
        reportRunnerError(error, "Agent creation failed.");
      }
    } finally {
      if (isCurrentSession(context.generation, context.signal)) {
        setBusy(false);
      }
    }
  };

  /**
   * Creates every member of a formation, one at a time.
   *
   * Sequential rather than parallel: each create writes the PostgreSQL-backed
   * agent catalog, and a burst of them races catalog updates. A failure halfway
   * leaves the members already created, which is the right outcome — they are
   * independently useful.
   */
  const createFormation = async (formation: Formation) => {
    const context = currentSessionContext();
    if (!context) {
      return;
    }
    setBusy(true);
    let created = 0;
    try {
      await formation.members.reduce(
        (previous, template) =>
          previous.then(async () => {
            if (!isCurrentSession(context.generation, context.signal)) {
              return;
            }
            const agent = await client.createAgent(
              {
                backend: "cloud",
                description: template.blurb,
                instructions: template.instructions,
                model: "auto",
                name: memberName(formation, template),
                runtime: "copilot",
                workspace: "/workspace",
              },
              context.signal
            );
            if (!isCurrentSession(context.generation, context.signal)) {
              return;
            }
            setAgents((current) => [...current, agent]);
            setSelectedAgentId(agent.id);
            created += 1;
          }),
        Promise.resolve()
      );
      if (!isCurrentSession(context.generation, context.signal)) {
        return;
      }
      toast.success(`${formation.name}: ${created} profiles created.`);
      setView("composer");
    } catch (error) {
      if (!isCurrentSession(context.generation, context.signal)) {
        return;
      }
      if (created > 0) {
        if (error instanceof RunnerApiError) {
          const status = applicationRunnerStatusFromError(error);
          if (status) {
            setRunnerStatus(status);
          }
        }
        toast.error(`Created ${created} of ${formation.members.length}.`);
      } else {
        reportRunnerError(error, "Could not create the crew.");
      }
    } finally {
      if (isCurrentSession(context.generation, context.signal)) {
        setBusy(false);
      }
    }
  };

  /**
   * Renames a profile.
   *
   * The endpoint replaces the whole definition, so the stored one is sent back
   * with only the name changed. Owner, `createdAt` and `lastRunAt` are carried
   * forward by the runner from stored state rather than from this body, so a
   * rename cannot move an agent between tenants or rewrite its history.
   */
  const commitRename = async () => {
    const next = renameDraft.trim();
    if (!selectedAgent || !next || next === selectedAgent.name) {
      setRenaming(false);
      return;
    }
    const context = currentSessionContext();
    if (!context) {
      return;
    }
    try {
      const updated = await client.updateAgent(
        selectedAgent.id,
        {
          backend: selectedAgent.backend,
          description: selectedAgent.description,
          instructions: selectedAgent.instructions,
          model: selectedAgent.model,
          name: next,
          runtime: selectedAgent.runtime,
          workspace: selectedAgent.workspace,
        },
        context.signal
      );
      if (!isCurrentSession(context.generation, context.signal)) {
        return;
      }
      setAgents((current) =>
        current.map((agent) => (agent.id === updated.id ? updated : agent))
      );
      toast.success(`Renamed to ${sanitizeEvidenceText(updated.name)}.`);
    } catch (error) {
      if (isCurrentSession(context.generation, context.signal)) {
        reportRunnerError(error, "Could not rename the agent.");
      }
    } finally {
      if (isCurrentSession(context.generation, context.signal)) {
        setRenaming(false);
      }
    }
  };

  const removeAgent = async () => {
    if (!selectedAgent) {
      return;
    }
    const context = currentSessionContext();
    if (!context) {
      return;
    }
    setBusy(true);
    try {
      await client.deleteAgent(selectedAgent.id, context.signal);
      if (!isCurrentSession(context.generation, context.signal)) {
        return;
      }
      const remaining = agents.filter((agent) => agent.id !== selectedAgent.id);
      setAgents(remaining);
      setRuns((current) =>
        current.filter((run) => run.agentId !== selectedAgent.id)
      );
      setSelectedAgentId(remaining[0]?.id ?? null);
      setSelectedRunId(null);
      setView("composer");
      toast.success(`${sanitizeEvidenceText(selectedAgent.name)} was removed.`);
    } catch (error) {
      if (isCurrentSession(context.generation, context.signal)) {
        reportRunnerError(error, "Could not remove the agent.");
      }
    } finally {
      if (isCurrentSession(context.generation, context.signal)) {
        setBusy(false);
        setRemoving(false);
      }
    }
  };

  const copyReceipt = async () => {
    if (!selectedRun) {
      return;
    }
    const { snapshot } = selectedRun;
    const receipt = [
      `run ${snapshot.id}`,
      `agent ${sanitizeEvidenceText(runAgent?.name ?? snapshot.agentId)} · ${runAgent?.runtime ?? ""}`,
      `status ${snapshot.status}`,
      `mission ${sanitizeEvidenceText(snapshot.task)}`,
      "",
      ...snapshot.commandEvidence.map(
        (evidence) =>
          `$ ${sanitizeEvidenceText(evidence.command)} → exit ${evidence.exitCode}`
      ),
      ...snapshot.fileEvidence.map(
        (evidence) =>
          `${evidence.operation} ${sanitizeEvidencePath(evidence.path)}`
      ),
      "",
      sanitizeEvidenceText(snapshot.output),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(receipt);
      setCopiedReceipt(true);
      setTimeout(() => setCopiedReceipt(false), 2000);
    } catch {
      toast.error("The browser refused clipboard access.");
    }
  };

  // Stable so the command palette's item list is not rebuilt on every render —
  // both only touch setters and refs, which React guarantees do not change.
  const openComposer = useCallback((agentId: string) => {
    setSelectedAgentId(agentId);
    setSelectedRunId(null);
    setReportReader(null);
    setSelectedBlockId(null);
    setView("composer");
  }, []);

  const openCreate = useCallback(() => {
    if (session.status !== "authenticated") {
      window.location.assign(
        browserApplicationLoginHref(
          `${window.location.pathname}${window.location.search}${window.location.hash}`
        )
      );
      return;
    }
    setView("create");
  }, [session.status]);

  const openRun = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setReportReader(null);
    setSelectedBlockId(null);
    setView("thread");
    setThreadOpenRevision((revision) => revision + 1);
    pinnedRef.current = true;
    const run = runsRef.current.find((entry) => entry.snapshot.id === runId);
    if (run && !isTerminal(run.snapshot.status)) {
      setStreamingRunId(runId);
    }
  }, []);

  /* ---------------------------------------------------------------- ⌘K */

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (reportReader) {
          return;
        }
        setPaletteOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setInspectorOpen(false);
        setRunMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reportReader]);

  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [
      {
        group: "action",
        id: "new-agent",
        label: "Create an agent",
        run: openCreate,
      },
      {
        group: "action",
        id: "toggle-rail",
        label: "Toggle the navigation rail",
        run: () => setRailCollapsed((value) => !value),
      },
      {
        group: "action",
        id: "toggle-steps",
        label: "Toggle the steps panel",
        run: () => setTimelineCollapsed((value) => !value),
      },
      {
        group: "action",
        hint: "runs per day",
        id: "analytics",
        label: "Open evidence analytics",
        run: () => setView("analytics"),
      },
      {
        group: "action",
        hint: "credentials, usage, data",
        id: "account",
        label: "Open settings",
        run: () => setView("settings"),
      },
    ];

    for (const agent of agents) {
      items.push({
        group: "agent",
        hint: `${agent.runtime} · ${sanitizeEvidenceText(agent.model)}`,
        id: `agent:${agent.id}`,
        label: sanitizeEvidenceText(agent.name),
        run: () => openComposer(agent.id),
      });
    }

    for (const run of runs) {
      items.push({
        group: "run",
        hint: run.snapshot.status,
        id: `run:${run.snapshot.id}`,
        label: sanitizeEvidenceText(run.snapshot.task),
        run: () => openRun(run.snapshot.id),
      });
    }

    return items;
  }, [agents, openComposer, openCreate, openRun, runs]);

  /* --------------------------------------------------------------- derived */

  const projection = useMemo(
    () =>
      projectRun({
        agent: runAgent,
        events: selectedRun?.events ?? [],
        run: selectedRun?.snapshot ?? null,
      }),
    [runAgent, selectedRun]
  );

  const elapsed = (() => {
    if (!selectedRun) {
      return "—";
    }
    const { snapshot } = selectedRun;
    const from = snapshot.startedAt ?? snapshot.createdAt;
    const to =
      snapshot.completedAt ?? (now ? new Date(now).toISOString() : null);
    const span = spanBetween(from, to);
    return span === null ? "—" : formatDuration(span);
  })();

  const agentRuns = runs.filter((run) => run.agentId === selectedAgentId);

  const connectionLabel = CONNECTION_LABELS[runnerStatus];

  /* ---------------------------------------------------------------- render */

  return (
    <main
      className="oc-console"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        overflow: "hidden",
      }}
    >
      <Toaster position="top-center" theme="dark" />

      <header
        className="oc-console-header"
        style={{
          alignItems: "center",
          background: "var(--bg-panel)",
          borderBottom: hairline,
          display: "flex",
          flex: "none",
          gap: 12,
          height: 52,
          padding: "0 14px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            flex: "1 1 0",
            gap: 9,
            minWidth: 0,
          }}
        >
          {/* The brand is the way back to runs — the one escape hatch every
              view shares, which is why the views carry no back buttons of
              their own. The href keeps middle-click and copy-link honest;
              a plain click stays in the console instead of reloading it. */}
          <Link
            aria-label="Back to runs"
            className="oc-tint"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              setView("composer");
            }}
            style={{
              alignItems: "center",
              borderRadius: "var(--radius-control)",
              color: "inherit",
              display: "flex",
              gap: 9,
              margin: "0 -6px",
              padding: "5px 6px",
              textDecoration: "none",
            }}
            title="Back to runs"
          >
            <BrandMark
              style={{
                color: "var(--accent-presence)",
                height: 14,
                width: 15,
              }}
            />
            <span className="oc-header-brand-copy" style={type_.title}>
              OpenCoven
            </span>
            <span className="oc-header-context">
              <Eyebrow style={{ color: "var(--text-muted)" }}>Runs</Eyebrow>
            </span>
          </Link>
        </div>

        <button
          aria-keyshortcuts="Meta+K"
          aria-label="Search or run a command"
          className="oc-tint"
          data-console-search
          onClick={() => setPaletteOpen(true)}
          style={{
            alignItems: "center",
            background: "var(--bg-sunken)",
            border: hairline,
            borderRadius: "var(--radius-control)",
            color: "var(--text-muted)",
            cursor: "pointer",
            display: "flex",
            flex: "0 1 660px",
            font: "400 12px/1 var(--font-ui)",
            gap: 8,
            height: 32,
            minWidth: 180,
            padding: "0 11px",
          }}
          type="button"
        >
          <Search size={13} />
          <span
            className="oc-header-search-label"
            style={{ flex: 1, textAlign: "left", ...truncate }}
          >
            Search runs, agents, and commands
          </span>
          <kbd
            className="oc-header-shortcut"
            style={{
              background: "var(--bg-raised)",
              border: hairline,
              borderRadius: 4,
              color: "var(--text-secondary)",
              font: "500 10px/1 var(--font-mono)",
              padding: "3px 5px",
            }}
          >
            ⌘K
          </kbd>
        </button>

        <div
          className="oc-header-actions"
          style={{
            alignItems: "center",
            display: "flex",
            flex: "1 1 0",
            gap: 9,
            justifyContent: "flex-end",
          }}
        >
          <button
            disabled
            style={{
              ...pill(
                runnerStatus === "connected"
                  ? "success"
                  : runnerStatus === "unavailable"
                    ? "danger"
                    : "warning"
              ),
              cursor: "default",
            }}
            title={applicationRunnerMessage(runnerStatus)}
            type="button"
          >
            {connectionLabel}
          </button>
        </div>
      </header>

      <div
        className="oc-console-body"
        style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}
      >
        {view === "analytics" ? (
          <Analytics />
        ) : view === "settings" ? (
          <Settings
            account={account}
            authorityRevision={authorityRevision}
            checkoutEnabled={checkoutEnabled}
            invalidateSubscriptionAuthority={invalidateAndRefresh}
            isSubscriber={isSubscriber}
            onCredentialsChange={onCredentialsChange}
            operationContext={settingsOperationContext}
            subscribedUntil={subscribedUntil}
          />
        ) : view === "create" ? (
          <CreateAgent
            busy={busy}
            onCancel={() => setView("composer")}
            onCreate={createAgent}
            onCreateFormation={createFormation}
          />
        ) : (
          <>
            <AgentRail
              agents={agents}
              avatarSrc={avatarSrc}
              collapsed={railCollapsed}
              now={now}
              onCreateAgent={openCreate}
              onNewRun={openComposer}
              onOpenAccount={() => setView("settings")}
              onSelectAgent={openComposer}
              onSelectRun={openRun}
              onToggle={() => setRailCollapsed((value) => !value)}
              onWidthChange={(width) =>
                setAgentRailWidth(
                  clampWidth(width, AGENT_RAIL_WIDTHS.min, agentRailWidthLimit)
                )
              }
              pendingRunHistoryAgentIds={pendingRunHistoryAgentIds}
              runs={runs}
              selectedAgentId={selectedAgentId}
              selectedRunId={selectedRunId}
              who={who}
              width={renderedAgentRailWidth}
              widthLimit={agentRailWidthLimit}
            />

            <section
              className="oc-console-main-pane"
              style={{
                background: "var(--bg-base)",
                display: "flex",
                flex: 1,
                flexDirection: "column",
                minWidth: 0,
              }}
            >
              {selectedAgent ? (
                <>
                  <div
                    style={{
                      alignItems: "center",
                      borderBottom: hairline,
                      display: "flex",
                      flex: "none",
                      gap: 10,
                      padding: "10px 16px",
                      position: "relative",
                    }}
                  >
                    {selectedRun || renaming ? (
                      <>
                        <span style={well(true, 30)}>
                          {glyphFor(
                            sanitizeEvidenceText(
                              runAgent?.name ?? selectedAgent.name
                            )
                          )}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              alignItems: "center",
                              display: "flex",
                              gap: 8,
                            }}
                          >
                            {renaming ? (
                              <>
                                <input
                                  aria-label="Agent name"
                                  autoFocus
                                  maxLength={64}
                                  onChange={(event) =>
                                    setRenameDraft(event.target.value)
                                  }
                                  onKeyDown={(event) => {
                                    if (event.key === "Enter") {
                                      commitRename().catch(() => undefined);
                                    }
                                    if (event.key === "Escape") {
                                      setRenaming(false);
                                    }
                                  }}
                                  style={{
                                    background: "var(--bg-sunken)",
                                    border: "1px solid var(--border-strong)",
                                    borderRadius: "var(--radius-control)",
                                    color: "var(--text-primary)",
                                    font: "500 13px/1 var(--font-ui)",
                                    outline: "none",
                                    padding: "6px 9px",
                                    width: 220,
                                  }}
                                  value={renameDraft}
                                />
                                <Btn
                                  onClick={() => {
                                    commitRename().catch(() => undefined);
                                  }}
                                  size="xs"
                                  variant="primary"
                                >
                                  Save
                                </Btn>
                                <Btn
                                  onClick={() => setRenaming(false)}
                                  size="xs"
                                  variant="ghost"
                                >
                                  Cancel
                                </Btn>
                              </>
                            ) : (
                              <span style={{ ...type_.title, ...truncate }}>
                                {sanitizeEvidenceText(
                                  runAgent?.name ?? selectedAgent.name
                                )}
                              </span>
                            )}
                            {selectedRun ? (
                              <LifecycleBadge
                                status={selectedRun.snapshot.status}
                              />
                            ) : null}
                            {running ? (
                              <span
                                style={{
                                  color: "var(--color-warning)",
                                  font: "500 11px/1 var(--font-mono)",
                                  ...tabular,
                                }}
                              >
                                {elapsed}
                              </span>
                            ) : null}
                          </div>
                          <div
                            style={{
                              ...type_.meta,
                              marginTop: 3,
                              ...truncate,
                            }}
                          >
                            {selectedRun
                              ? `run ${selectedRun.snapshot.id.slice(0, 8)} · ${runAgent?.runtime} · ${sanitizeEvidenceText(runAgent?.model ?? "")}`
                              : selectedAgent.description
                                ? sanitizeEvidenceText(
                                    selectedAgent.description
                                  )
                                : `${selectedAgent.runtime} · ${sanitizeEvidenceText(selectedAgent.model)}`}
                          </div>
                        </div>
                      </>
                    ) : (
                      <ProfileSelector
                        agents={agents}
                        currentAgent={selectedAgent}
                        onCreate={openCreate}
                        onSelect={openComposer}
                      />
                    )}

                    {running ? (
                      <Btn onClick={stopRun} variant="danger-ghost">
                        Stop
                      </Btn>
                    ) : null}

                    <button
                      aria-expanded={inspectorOpen}
                      className="oc-tint"
                      onClick={() => setInspectorOpen((value) => !value)}
                      style={{
                        background: inspectorOpen
                          ? "var(--bg-raised)"
                          : "transparent",
                        border: hairline,
                        borderRadius: "var(--radius-control)",
                        color: "var(--text-secondary)",
                        cursor: "pointer",
                        font: "500 11px/1 var(--font-ui)",
                        height: 28,
                        padding: "0 11px",
                      }}
                      title="Runtime configuration for this run"
                      type="button"
                    >
                      Runtime
                    </button>

                    <button
                      aria-expanded={runMenuOpen}
                      aria-label="More run actions"
                      className="oc-tint"
                      onClick={() => setRunMenuOpen((value) => !value)}
                      style={{
                        background: "transparent",
                        border: "1px solid transparent",
                        borderRadius: "var(--radius-control)",
                        color: "var(--text-muted)",
                        cursor: "pointer",
                        display: "grid",
                        flex: "none",
                        height: 28,
                        placeItems: "center",
                        width: 28,
                      }}
                      type="button"
                    >
                      <MoreHorizontal size={14} />
                    </button>

                    {runMenuOpen ? (
                      <>
                        <button
                          aria-label="Close the run menu"
                          onClick={() => setRunMenuOpen(false)}
                          style={{
                            background: "transparent",
                            border: 0,
                            cursor: "default",
                            inset: 0,
                            position: "fixed",
                            zIndex: 38,
                          }}
                          type="button"
                        />
                        <div
                          aria-label="Run actions"
                          role="menu"
                          style={{
                            background: "var(--bg-elevated)",
                            border: "1px solid var(--border-strong)",
                            borderRadius: "var(--radius-card)",
                            boxShadow: "var(--shadow-lg)",
                            display: "flex",
                            flexDirection: "column",
                            gap: 1,
                            padding: 5,
                            position: "absolute",
                            right: 14,
                            top: 44,
                            width: 214,
                            zIndex: 40,
                          }}
                        >
                          {[
                            {
                              go: () => {
                                setRunMenuOpen(false);
                                openComposer(selectedAgent.id);
                              },
                              label: "New run for this agent",
                            },
                            {
                              go: () => {
                                setRunMenuOpen(false);
                                copyReceipt().catch(() => undefined);
                              },
                              label: "Copy the run receipt",
                            },
                            {
                              go: () => {
                                setRunMenuOpen(false);
                                setRenameDraft(selectedAgent.name);
                                setRenaming(true);
                              },
                              label: "Rename this agent",
                            },
                            {
                              go: () => {
                                setRunMenuOpen(false);
                                refreshCurrent().catch(() => undefined);
                              },
                              label: "Reload profiles",
                            },
                            {
                              go: () => {
                                setRunMenuOpen(false);
                                setRemoving(true);
                              },
                              label: "Remove this agent…",
                            },
                          ].map((item) => (
                            <button
                              className="oc-row"
                              key={item.label}
                              onClick={item.go}
                              role="menuitem"
                              style={{
                                background: "transparent",
                                border: 0,
                                borderRadius: "var(--radius-sm)",
                                color: "var(--text-secondary)",
                                cursor: "pointer",
                                font: "400 12px/1.3 var(--font-ui)",
                                padding: "8px 9px",
                                textAlign: "left",
                                width: "100%",
                              }}
                              type="button"
                            >
                              {item.label}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : null}
                  </div>

                  {view === "composer" || !selectedRun ? (
                    <Composer
                      agent={selectedAgent}
                      blocked={blocked}
                      draft={draft}
                      now={now}
                      onDraft={setDraft}
                      onOpenRun={openRun}
                      onStart={() => {
                        startRun().catch(() => undefined);
                      }}
                      runs={agentRuns}
                      starting={starting}
                    />
                  ) : (
                    <>
                      <div
                        aria-label="Run record"
                        aria-live="polite"
                        className="oc-scroll"
                        onScroll={(event) => {
                          const node = event.currentTarget;
                          const distance =
                            node.scrollHeight -
                            node.scrollTop -
                            node.clientHeight;
                          pinnedRef.current = distance < 80;
                        }}
                        ref={threadRef}
                        role="log"
                        style={{
                          flex: 1,
                          minHeight: 0,
                          overflowY: "auto",
                          padding: "20px 24px 8px",
                        }}
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region has to be focusable or a keyboard-only reader cannot scroll the record at all (WCAG 2.1.1).
                        tabIndex={0}
                      >
                        <div
                          className="oc-thread"
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 13,
                            margin: "0 auto",
                            maxWidth: 820,
                            paddingLeft: 22,
                          }}
                        >
                          {projection.blocks.map((block) => (
                            <div
                              className="oc-block"
                              id={`block-${block.id}`}
                              key={block.id}
                            >
                              <ThreadBlockView
                                block={block}
                                handlers={{
                                  copiedReceipt,
                                  onAmend: () => {
                                    setDraft(selectedRun.snapshot.task);
                                    setView("composer");
                                  },
                                  onCopyReceipt: () => {
                                    copyReceipt().catch(() => undefined);
                                  },
                                  onFollowUp: () =>
                                    openComposer(selectedRun.agentId),
                                  onRetry: () => {
                                    setDraft(selectedRun.snapshot.task);
                                    setView("composer");
                                  },
                                }}
                              />
                            </div>
                          ))}
                          {projection.activity ? (
                            <LiveActivityStatus
                              activity={projection.activity}
                            />
                          ) : null}
                          <div style={{ height: 8 }} />
                        </div>
                      </div>

                      <div
                        style={{
                          background: "var(--bg-panel)",
                          borderTop: hairline,
                          flex: "none",
                          padding: "12px 24px 14px",
                        }}
                      >
                        <div style={{ margin: "0 auto", maxWidth: 820 }}>
                          {running ? (
                            <div
                              style={{
                                alignItems: "center",
                                background:
                                  "color-mix(in oklch, var(--color-warning) 7%, transparent)",
                                border:
                                  "1px solid color-mix(in oklch, var(--color-warning) 30%, var(--border-hairline))",
                                borderRadius: "var(--radius-card)",
                                display: "flex",
                                gap: 12,
                                padding: "11px 14px",
                              }}
                            >
                              <Spinner />
                              <span
                                style={{
                                  color: "var(--text-primary)",
                                  font: "500 13px/1 var(--font-ui)",
                                }}
                              >
                                {projection.nowDoing}
                              </span>
                              <div style={{ flex: 1 }} />
                              <Btn onClick={stopRun} variant="danger-ghost">
                                Stop run
                              </Btn>
                            </div>
                          ) : (
                            <div
                              style={{
                                alignItems: "center",
                                display: "flex",
                                gap: 9,
                                minWidth: 0,
                              }}
                            >
                              <Btn
                                onClick={() =>
                                  openComposer(selectedRun.agentId)
                                }
                                variant="primary"
                              >
                                New run for this agent
                              </Btn>
                              <Btn
                                onClick={() => {
                                  setDraft(selectedRun.snapshot.task);
                                  setView("composer");
                                }}
                                variant="ghost"
                              >
                                Retry the same mission
                              </Btn>
                              <div style={{ flex: 1, minWidth: 12 }} />
                              <span
                                style={{
                                  color: "var(--text-secondary)",
                                  font: "400 11px/1 var(--font-ui)",
                                  ...truncate,
                                }}
                              >
                                {selectedRun.snapshot.status === "completed"
                                  ? "Closed with a receipt. The evidence above is what it is claiming."
                                  : `Ended ${selectedRun.snapshot.status}. Nothing was retried automatically.`}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <EmptyConsole
                  blocked={blocked}
                  onCreate={openCreate}
                  signedOut={session.status !== "authenticated"}
                />
              )}
            </section>

            {selectedRun ? (
              <StepsTimeline
                collapsed={timelineCollapsed}
                elapsed={elapsed}
                onJump={(blockId) => {
                  setSelectedBlockId(blockId);
                  document
                    .getElementById(`block-${blockId}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                onOpenAnalytics={() => setView("analytics")}
                onOpenReport={(blockId) => {
                  const block = projection.blocks.find(
                    (candidate) => candidate.id === blockId
                  );
                  const content =
                    block?.kind === "text"
                      ? block.text
                      : block?.kind === "evidence"
                        ? block.claim ||
                          "## Run summary\n\nNo narrative report was produced for this run."
                        : null;
                  if (!content) {
                    return;
                  }
                  setSelectedBlockId(blockId);
                  setReportReader({
                    content,
                    title: sanitizeEvidenceText(selectedRun.snapshot.task),
                  });
                }}
                onToggle={() => setTimelineCollapsed((value) => !value)}
                onWidthChange={(width) =>
                  setStepsTimelineWidth(
                    clampWidth(
                      width,
                      STEPS_TIMELINE_WIDTHS.min,
                      stepsTimelineWidthLimit
                    )
                  )
                }
                running={running}
                selectedBlockId={selectedBlockId}
                steps={projection.steps}
                width={renderedStepsTimelineWidth}
                widthLimit={stepsTimelineWidthLimit}
              />
            ) : null}

            {inspectorOpen && (runAgent ?? selectedAgent) ? (
              <RuntimeInspector
                agent={(runAgent ?? selectedAgent) as AgentDefinition}
                onClose={() => setInspectorOpen(false)}
              />
            ) : null}
          </>
        )}

        {removing && selectedAgent ? (
          <ConfirmRemove
            busy={busy}
            name={sanitizeEvidenceText(selectedAgent.name)}
            onCancel={() => setRemoving(false)}
            onConfirm={() => {
              removeAgent().catch(() => undefined);
            }}
          />
        ) : null}

        {paletteOpen ? (
          <CommandPalette
            items={paletteItems}
            onClose={() => setPaletteOpen(false)}
          />
        ) : null}

        {reportReader ? (
          <ReportReader
            content={reportReader.content}
            onClose={() => setReportReader(null)}
            title={reportReader.title}
          />
        ) : null}
      </div>
    </main>
  );
}

/**
 * The one destructive action in the console.
 *
 * Deleting a profile does not delete the runs it produced — those live in the
 * runner's durable state — so the copy says what actually goes, rather than
 * letting someone infer that the evidence goes with it.
 */
function ConfirmRemove({
  busy,
  name,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        background: "oklch(0 0 0 / 0.42)",
        display: "flex",
        inset: 0,
        justifyContent: "center",
        padding: 16,
        position: "absolute",
        zIndex: 70,
      }}
    >
      <div
        aria-labelledby="confirm-remove-title"
        aria-modal="true"
        role="dialog"
        style={{
          background: "var(--bg-elevated)",
          border: "1px solid var(--danger-border)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-lg)",
          maxWidth: 440,
          padding: 18,
          width: "100%",
        }}
      >
        <h2
          id="confirm-remove-title"
          style={{
            color: "var(--danger-text)",
            font: "600 14px/1.3 var(--font-ui)",
            margin: "0 0 8px",
          }}
        >
          Remove {name}?
        </h2>
        <p style={{ ...type_.body, font: "400 12px/1.6 var(--font-ui)" }}>
          The profile is deleted from the runner. Runs it already produced keep
          their records; this console simply stops listing them.
        </p>
        <div
          style={{
            display: "flex",
            gap: 9,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <Btn onClick={onCancel} variant="ghost">
            Cancel
          </Btn>
          <Btn disabled={busy} onClick={onConfirm} variant="danger-ghost">
            Remove the profile
          </Btn>
        </div>
      </div>
    </div>
  );
}

function EmptyConsole({
  blocked,
  onCreate,
  signedOut,
}: {
  blocked: string | null;
  onCreate: () => void;
  signedOut: boolean;
}) {
  return (
    <div className="oc-empty-console">
      <div className="oc-empty-console-shell">
        <section className="oc-empty-console-copy">
          <Eyebrow
            style={{ color: "var(--text-muted)", letterSpacing: "0.14em" }}
          >
            Daytona sandboxes
          </Eyebrow>
          <h1 className="oc-empty-console-heading" style={type_.display}>
            Autonomous agents, bounded by infrastructure.
          </h1>
          <p className="oc-empty-console-intro" style={type_.body}>
            {blocked ??
              "Forge an execution profile, hand it a mission, and read the receipt it proves itself with."}
          </p>
          <div className="oc-empty-console-actions">
            <Btn
              disabled={blocked !== null && !signedOut}
              onClick={onCreate}
              size="md"
              variant="primary"
            >
              {signedOut ? "Sign in to forge" : "Forge an agent"}
            </Btn>
          </div>

          <div className="oc-empty-console-trust">
            <span
              aria-hidden="true"
              style={{
                background: "var(--color-success)",
                borderRadius: 999,
                height: 5,
                width: 5,
              }}
            />
            <span>isolated per agent · nothing reaches your machine</span>
          </div>
        </section>

        <aside
          aria-label="How a run is bounded"
          className="oc-empty-console-boundary"
        >
          <div className="oc-empty-console-boundary-head">
            <Eyebrow>Execution boundary</Eyebrow>
            <span>Daytona</span>
          </div>
          <ol className="oc-empty-console-boundary-list">
            <li>
              <span>01</span>
              <div>
                <strong>Constrain</strong>
                <p>
                  Profile, credentials, and mission are scoped before launch.
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <strong>Execute</strong>
                <p>Work stays inside one isolated sandbox for the agent.</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <strong>Prove</strong>
                <p>The environment closes; a redacted receipt remains.</p>
              </div>
            </li>
          </ol>
          <details className="oc-empty-console-details">
            <summary>Boundary details</summary>
            <p style={type_.body}>
              Every agent runs in its own Daytona sandbox. Filesystem and
              network access stay inside that provider boundary. Your harness
              credential is envelope-encrypted, staged only for execution, and
              redacted from the evidence. When the run closes, the receipt is
              what remains.
            </p>
          </details>
        </aside>
      </div>
    </div>
  );
}
