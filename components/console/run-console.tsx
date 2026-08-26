// biome-ignore-all lint/performance/noJsxPropsBind: this console keeps each handler beside the control it drives; hoisting them would put the state they close over a screen away from the button that changes it.

"use client";

import type {
  AgentDefinition,
  CreateAgentInput,
  RunEvent,
  RunSnapshot,
} from "@opencoven/agent-contracts";
import { MoreHorizontal, Search } from "lucide-react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import { AgentRail } from "@/components/console/agent-rail";
import { Analytics } from "@/components/console/analytics";
import {
  CommandPalette,
  type PaletteItem,
} from "@/components/console/command-palette";
import { Composer } from "@/components/console/composer";
import { ConnectRunner } from "@/components/console/connect-runner";
import { CreateAgent } from "@/components/console/create-agent";
import {
  AccountAvatar,
  Btn,
  Eyebrow,
  LifecycleBadge,
  Spinner,
} from "@/components/console/primitives";
import { ThreadBlockView } from "@/components/console/run-thread";
import { RuntimeInspector } from "@/components/console/runtime-inspector";
import { Settings } from "@/components/console/settings";
import { StepsTimeline } from "@/components/console/steps-timeline";
import {
  hairline,
  pill,
  tabular,
  truncate,
  type as type_,
  well,
} from "@/components/console/styles";
import { RunnerClient, type RunnerConnection } from "@/lib/agents/client";
import {
  type ConnectionStatusKind,
  connectionMessage,
} from "@/lib/agents/connection-status";
import type { Formation } from "@/lib/agents/formations";
import { memberName } from "@/lib/agents/formations";
import { createIdentityMinter } from "@/lib/agents/identity";
import {
  fetchHasCredential,
  provisionConnection,
} from "@/lib/agents/provision";
import { avatarFor } from "@/lib/avatar";
import { isTerminal, projectRun } from "@/lib/console/blocks";
import { formatDuration, glyphFor, spanBetween } from "@/lib/console/format";
import type { ConsoleRun } from "@/lib/console/types";

const CLOUD_ENDPOINT =
  process.env.NEXT_PUBLIC_CLOUD_RUNNER_URL ?? "http://127.0.0.1:8787";

const EMPTY_CONNECTION: RunnerConnection = {
  endpoint: CLOUD_ENDPOINT,
  token: "",
};

const TICK_MS = 1000;

/**
 * Where a manually entered connection is kept.
 *
 * Session storage, not local storage: the token is a deployment gate and it
 * should not outlive the tab that was told it.
 */
const CONNECTION_KEY = "opencoven-runner-cloud";

function loadStoredConnection(): RunnerConnection | null {
  const stored = window.sessionStorage.getItem(CONNECTION_KEY);
  if (!stored) {
    return null;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<RunnerConnection>;
    if (
      typeof parsed.endpoint === "string" &&
      typeof parsed.token === "string"
    ) {
      return { endpoint: parsed.endpoint, token: parsed.token };
    }
  } catch {
    // A malformed entry is not worth keeping and would fail the same way on
    // every load.
  }
  window.sessionStorage.removeItem(CONNECTION_KEY);
  return null;
}

/** What to say about a connection state, including the one that is fine. */
function statusMessage(kind: ConnectionStatusKind): string {
  return kind === "provisioned"
    ? "The runner answered and this session is authenticated."
    : connectionMessage(kind);
}

/**
 * The word the header pill wears.
 *
 * Written out rather than rendering the status kind directly: those are
 * protocol identifiers, and `SIGNED_OUT` in a pill is an implementation detail
 * leaking into the one place that is supposed to explain the state.
 */
const CONNECTION_LABELS: Record<ConnectionStatusKind, string> = {
  provisioned: "connected",
  rate_limited: "rate limited",
  signed_out: "signed out",
  subscription_required: "no subscription",
  unavailable: "unreachable",
  unconfigured: "not configured",
};

type View = "analytics" | "composer" | "create" | "settings" | "thread";

/**
 * The run console.
 *
 * Three panes: the profiles on the left, the record in the middle, the index of
 * it on the right. The record is the product — everything else is a way to get
 * to one, or a way to start one that will produce another.
 */
export function RunConsole() {
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
  const avatarSrc = accountId
    ? avatarFor({ id: accountId, image: session.data?.user?.image })
    : null;

  const [connection, setConnection] =
    useState<RunnerConnection>(EMPTY_CONNECTION);
  const [cloudStatus, setCloudStatus] =
    useState<ConnectionStatusKind>("unavailable");
  const [hasCredential, setHasCredential] = useState<boolean | null>(null);

  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [runs, setRuns] = useState<ConsoleRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [streamingRunId, setStreamingRunId] = useState<string | null>(null);

  const [view, setView] = useState<View>("composer");
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);

  const [railCollapsed, setRailCollapsed] = useState(false);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
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

  const threadRef = useRef<HTMLDivElement>(null);
  const runsRef = useRef<ConsoleRun[]>([]);
  runsRef.current = runs;

  const mintIdentity = useMemo(() => createIdentityMinter(), []);
  const client = useMemo(
    () => new RunnerClient(connection, undefined, { mintIdentity }),
    [connection, mintIdentity]
  );

  const selectedAgent =
    agents.find((agent) => agent.id === selectedAgentId) ?? null;
  const selectedRun =
    runs.find((run) => run.snapshot.id === selectedRunId) ?? null;
  const runAgent = selectedRun
    ? (agents.find((agent) => agent.id === selectedRun.agentId) ?? null)
    : selectedAgent;

  /* ---------------------------------------------------------------- wiring */

  useEffect(() => {
    let cancelled = false;

    // A connection entered by hand is used until the server answers, so a
    // deployment with no provisioning still reaches its runner immediately.
    const stored = loadStoredConnection();
    if (stored) {
      setConnection(stored);
    }

    fetchHasCredential()
      .then((has) => {
        if (!cancelled && has !== null) {
          setHasCredential(has);
        }
      })
      .catch(() => undefined);

    provisionConnection()
      .then((status) => {
        if (cancelled) {
          return;
        }
        setCloudStatus(status.kind);
        if (status.kind === "provisioned") {
          setConnection({ endpoint: status.endpoint, token: status.token });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCloudStatus("unavailable");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!connection.token) {
      setAgents([]);
      return;
    }
    try {
      const next = await client.listAgents();
      setAgents(next);
      setSelectedAgentId((current) =>
        next.some((agent) => agent.id === current)
          ? current
          : (next[0]?.id ?? null)
      );

      // The runner remembers a bounded history per agent; without this a
      // reload shows an empty session list while the runs still exist. Each
      // agent's listing fails soft — a runner without the route (or one
      // agent's directory hiccup) costs history, never the console.
      const discovered = (
        await Promise.all(
          next.map((agent) =>
            client.listRuns(agent.id).then(
              (snapshots) =>
                snapshots.map((snapshot) => ({ agentId: agent.id, snapshot })),
              () => []
            )
          )
        )
      ).flat();
      setRuns((current) => {
        const known = new Set(current.map((run) => run.snapshot.id));
        return [
          ...current,
          ...discovered
            .filter((run) => !known.has(run.snapshot.id))
            .map((run) => ({ ...run, events: [], lastEventId: 0 })),
        ];
      });
      // A run that survived the refresh mid-flight resumes streaming; its
      // events replay from the start, so the transcript rebuilds itself.
      const live = discovered.find((run) => !isTerminal(run.snapshot.status))
        ?.snapshot.id;
      if (live) {
        setStreamingRunId((current) => current ?? live);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not reach the runner."
      );
    }
  }, [client, connection.token]);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  /** Applies one streamed event to the run it belongs to. */
  const applyEvent = useCallback((runId: string, event: RunEvent) => {
    setRuns((current) =>
      current.map((run) => {
        if (run.snapshot.id !== runId || event.id <= run.lastEventId) {
          return run;
        }
        const snapshot: RunSnapshot =
          event.type === "completed"
            ? event.run
            : event.type === "status"
              ? { ...run.snapshot, status: event.status }
              : run.snapshot;

        return {
          ...run,
          events: [...run.events, event],
          lastEventId: event.id,
          snapshot,
        };
      })
    );

    if (event.type === "completed" || event.type === "failed") {
      // The rail's dot is read off the agent, not the run, so it has to be
      // told as well or a finished run leaves its profile spinning.
      setAgents((current) =>
        current.map((agent) =>
          agent.id ===
          runsRef.current.find((r) => r.snapshot.id === runId)?.agentId
            ? {
                ...agent,
                status: event.type === "failed" ? "error" : "idle",
              }
            : agent
        )
      );
    }
  }, []);

  useEffect(() => {
    if (!streamingRunId) {
      return;
    }
    const start = runsRef.current.find(
      (run) => run.snapshot.id === streamingRunId
    );
    if (!start || isTerminal(start.snapshot.status)) {
      setStreamingRunId(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    /**
     * A loop, not a single pass retriggered through state.
     *
     * The worker closes an idle stream after sixty seconds, and the first
     * version of this effect handled that by re-reading the snapshot and
     * calling `setStreamingRunId(streamingRunId)` — the same value, which
     * React treats as no change, so the effect never re-ran and the stream
     * never reopened. A quiet minute mid-run left the console permanently
     * blind to a run that was still executing; the first real cloud run
     * demonstrated it live. Looping inside the effect makes the reconnect a
     * fact of control flow instead of a hope about state identity.
     *
     * The cursor is re-read from `runsRef` each pass, so a reconnect resumes
     * after the last applied event rather than replaying from the start.
     */
    const RECONNECT_DELAY_MS = 1000;

    const follow = async () => {
      while (!cancelled) {
        const cursor =
          runsRef.current.find((run) => run.snapshot.id === streamingRunId)
            ?.lastEventId ?? 0;

        try {
          // biome-ignore lint/performance/noAwaitInLoops: each stream must end before the snapshot re-read that decides whether to open the next one.
          await client.streamRunEvents(streamingRunId, {
            lastEventId: cursor,
            onEvent: (event) => {
              if (!cancelled) {
                applyEvent(streamingRunId, event);
              }
            },
            signal: controller.signal,
          });
        } catch (error) {
          if (cancelled || controller.signal.aborted) {
            return;
          }
          toast.error(
            error instanceof Error
              ? error.message
              : "Lost the run's event stream."
          );
        }

        if (cancelled) {
          return;
        }

        // The worker closes an idle stream as well as a finished one, so the
        // close is not an outcome. Re-read the snapshot and let its status
        // decide whether to reconnect.
        try {
          const snapshot = await client.getRun(
            streamingRunId,
            controller.signal
          );
          if (cancelled) {
            return;
          }
          setRuns((current) =>
            current.map((run) =>
              run.snapshot.id === streamingRunId ? { ...run, snapshot } : run
            )
          );
          if (isTerminal(snapshot.status)) {
            setStreamingRunId(null);
            return;
          }
        } catch {
          setStreamingRunId(null);
          return;
        }

        // A pause before reconnecting, so a stream the worker closes
        // immediately cannot turn this loop into a request-per-tick hammer.
        await new Promise((resolve) => {
          setTimeout(resolve, RECONNECT_DELAY_MS);
        });
      }
    };

    follow().catch(() => undefined);

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [applyEvent, client, streamingRunId]);

  /**
   * Backfills the transcript of a finished run that was hydrated from the
   * runner's history. Hydration carries only the snapshot; the events still
   * live on the worker, and for a terminal run its stream replays them all
   * and closes, which makes it a one-shot transcript fetch. Live runs are
   * excluded — the streaming effect above owns those.
   */
  useEffect(() => {
    if (
      !selectedRun ||
      selectedRun.events.length > 0 ||
      selectedRun.lastEventId > 0 ||
      !isTerminal(selectedRun.snapshot.status)
    ) {
      return;
    }
    const runId = selectedRun.snapshot.id;
    const controller = new AbortController();
    client
      .streamRunEvents(runId, {
        onEvent: (event) => applyEvent(runId, event),
        signal: controller.signal,
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [applyEvent, client, selectedRun]);

  const running = selectedRun
    ? !isTerminal(selectedRun.snapshot.status)
    : false;

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
    const node = threadRef.current;
    if (node && pinnedRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, []);

  /* --------------------------------------------------------------- actions */

  const blocked = connection.token
    ? hasCredential === false
      ? "No harness credential stored — add one in account settings."
      : null
    : statusMessage(cloudStatus);

  const startRun = async () => {
    if (!selectedAgent || blocked) {
      return;
    }
    const task = draft.trim();
    setStarting(true);
    try {
      const snapshot = await client.startRun(selectedAgent.id, task);
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
      toast.error(
        error instanceof Error ? error.message : "The run could not start."
      );
    } finally {
      setStarting(false);
    }
  };

  const stopRun = async () => {
    if (!selectedRun) {
      return;
    }
    try {
      const snapshot = await client.stopRun(selectedRun.snapshot.id);
      setRuns((current) =>
        current.map((run) =>
          run.snapshot.id === snapshot.id ? { ...run, snapshot } : run
        )
      );
      toast.success("Run cancelled.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not stop the run."
      );
    }
  };

  const createAgent = async (input: CreateAgentInput) => {
    setBusy(true);
    try {
      const created = await client.createAgent(input);
      setAgents((current) => [created, ...current]);
      setSelectedAgentId(created.id);
      setView("composer");
      toast.success(`${created.name} is ready.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Agent creation failed."
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Creates every member of a formation, one at a time.
   *
   * Sequential rather than parallel: each create is a durable-object write and
   * a burst of them races the directory. A failure halfway leaves the members
   * already created, which is the right outcome — they are independently useful.
   */
  const createFormation = async (formation: Formation) => {
    setBusy(true);
    let created = 0;
    try {
      await formation.members.reduce(
        (previous, template) =>
          previous.then(async () => {
            const agent = await client.createAgent({
              backend: "cloud",
              description: template.blurb,
              instructions: template.instructions,
              model: "auto",
              name: memberName(formation, template),
              runtime: "copilot",
              workspace: "/workspace",
            });
            setAgents((current) => [...current, agent]);
            setSelectedAgentId(agent.id);
            created += 1;
          }),
        Promise.resolve()
      );
      toast.success(`${formation.name}: ${created} profiles created.`);
      setView("composer");
    } catch (error) {
      toast.error(
        created > 0
          ? `Created ${created} of ${formation.members.length}.`
          : error instanceof Error
            ? error.message
            : "Could not create the crew."
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Renames a profile.
   *
   * The endpoint replaces the whole definition, so the stored one is sent back
   * with only the name changed. Owner, `createdAt` and `lastRunAt` are carried
   * forward by the worker from stored state rather than from this body, so a
   * rename cannot move an agent between tenants or rewrite its history.
   */
  const commitRename = async () => {
    const next = renameDraft.trim();
    if (!selectedAgent || !next || next === selectedAgent.name) {
      setRenaming(false);
      return;
    }
    try {
      const updated = await client.updateAgent(selectedAgent.id, {
        backend: selectedAgent.backend,
        description: selectedAgent.description,
        instructions: selectedAgent.instructions,
        model: selectedAgent.model,
        name: next,
        runtime: selectedAgent.runtime,
        workspace: selectedAgent.workspace,
      });
      setAgents((current) =>
        current.map((agent) => (agent.id === updated.id ? updated : agent))
      );
      toast.success(`Renamed to ${updated.name}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not rename the agent."
      );
    } finally {
      setRenaming(false);
    }
  };

  const removeAgent = async () => {
    if (!selectedAgent) {
      return;
    }
    setBusy(true);
    try {
      await client.deleteAgent(selectedAgent.id);
      const remaining = agents.filter((agent) => agent.id !== selectedAgent.id);
      setAgents(remaining);
      setRuns((current) =>
        current.filter((run) => run.agentId !== selectedAgent.id)
      );
      setSelectedAgentId(remaining[0]?.id ?? null);
      setSelectedRunId(null);
      setView("composer");
      toast.success(`${selectedAgent.name} was removed.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not remove the agent."
      );
    } finally {
      setBusy(false);
      setRemoving(false);
    }
  };

  const copyReceipt = async () => {
    if (!selectedRun) {
      return;
    }
    const { snapshot } = selectedRun;
    const receipt = [
      `run ${snapshot.id}`,
      `agent ${runAgent?.name ?? snapshot.agentId} · ${runAgent?.runtime ?? ""}`,
      `status ${snapshot.status}`,
      `mission ${snapshot.task}`,
      "",
      ...snapshot.commandEvidence.map(
        (evidence) => `$ ${evidence.command} → exit ${evidence.exitCode}`
      ),
      ...snapshot.fileEvidence.map(
        (evidence) => `${evidence.operation} ${evidence.path}`
      ),
      "",
      snapshot.output,
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
    setView("composer");
  }, []);

  const openRun = useCallback((runId: string) => {
    setSelectedRunId(runId);
    setView("thread");
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
  }, []);

  const paletteItems: PaletteItem[] = useMemo(() => {
    const items: PaletteItem[] = [
      {
        group: "action",
        id: "new-agent",
        label: "Create an agent",
        run: () => setView("create"),
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
        hint: `${agent.runtime} · ${agent.model}`,
        id: `agent:${agent.id}`,
        label: agent.name,
        run: () => openComposer(agent.id),
      });
    }

    for (const run of runs) {
      items.push({
        group: "run",
        hint: run.snapshot.status,
        id: `run:${run.snapshot.id}`,
        label: run.snapshot.task,
        run: () => openRun(run.snapshot.id),
      });
    }

    return items;
  }, [agents, openComposer, openRun, runs]);

  /* --------------------------------------------------------------- derived */

  const projection = useMemo(
    () =>
      projectRun({
        agent: runAgent,
        events: selectedRun?.events ?? [],
        run: selectedRun?.snapshot ?? null,
        who,
      }),
    [runAgent, selectedRun, who]
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

  const connectionLabel = connection.token
    ? CONNECTION_LABELS.provisioned
    : CONNECTION_LABELS[cloudStatus];

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
            <span style={{ color: "var(--accent-presence)", fontSize: 13 }}>
              ◆
            </span>
            <span style={type_.title}>OpenCoven</span>
            <Eyebrow style={{ color: "var(--text-muted)" }}>Runs</Eyebrow>
          </Link>
        </div>

        <button
          aria-keyshortcuts="Meta+K"
          aria-label="Search or run a command"
          className="oc-tint"
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
          <span style={{ flex: 1, textAlign: "left", ...truncate }}>
            Search runs, agents, and commands
          </span>
          <kbd
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
          style={{
            alignItems: "center",
            display: "flex",
            flex: "1 1 0",
            gap: 9,
            justifyContent: "flex-end",
          }}
        >
          <button
            onClick={() => setConnectOpen(true)}
            style={{
              ...pill(
                connection.token
                  ? "success"
                  : cloudStatus === "unavailable"
                    ? "danger"
                    : "warning"
              ),
              cursor: "pointer",
            }}
            title={statusMessage(cloudStatus)}
            type="button"
          >
            {connectionLabel}
          </button>
          <button
            aria-label="Account and settings"
            className="oc-tint"
            onClick={() => setView("settings")}
            style={{
              ...well(false, 26),
              borderRadius: "var(--radius-control)",
              cursor: "pointer",
            }}
            title={who}
            type="button"
          >
            <AccountAvatar size={24} src={avatarSrc} />
          </button>
        </div>
      </header>

      <div
        style={{ display: "flex", flex: 1, minHeight: 0, position: "relative" }}
      >
        {view === "analytics" ? (
          <Analytics />
        ) : view === "settings" ? (
          <Settings account={account} />
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
              onCreateAgent={() => setView("create")}
              onNewRun={openComposer}
              onOpenAccount={() => setView("settings")}
              onSelectAgent={openComposer}
              onSelectRun={openRun}
              onToggle={() => setRailCollapsed((value) => !value)}
              runs={runs}
              selectedAgentId={selectedAgentId}
              selectedRunId={selectedRunId}
              who={who}
            />

            <section
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
                    <span style={well(true, 30)}>
                      {glyphFor(runAgent?.name ?? selectedAgent.name)}
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
                            {runAgent?.name ?? selectedAgent.name}
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
                          ? `run ${selectedRun.snapshot.id.slice(0, 8)} · ${runAgent?.runtime} · ${runAgent?.model}`
                          : selectedAgent.description ||
                            `${selectedAgent.runtime} · ${selectedAgent.model}`}
                      </div>
                    </div>

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
                                refresh().catch(() => undefined);
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
                  onCreate={() => setView("create")}
                />
              )}
            </section>

            {selectedRun ? (
              <StepsTimeline
                collapsed={timelineCollapsed}
                elapsed={elapsed}
                onJump={(blockId) => {
                  document
                    .getElementById(`block-${blockId}`)
                    ?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
                onOpenAnalytics={() => setView("analytics")}
                onToggle={() => setTimelineCollapsed((value) => !value)}
                running={running}
                selectedBlockId={null}
                steps={projection.steps}
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
            name={selectedAgent.name}
            onCancel={() => setRemoving(false)}
            onConfirm={() => {
              removeAgent().catch(() => undefined);
            }}
          />
        ) : null}

        {connectOpen ? (
          <ConnectRunner
            connection={connection}
            onCancel={() => setConnectOpen(false)}
            onSave={(next) => {
              window.sessionStorage.setItem(
                CONNECTION_KEY,
                JSON.stringify(next)
              );
              setConnection(next);
              setConnectOpen(false);
              toast.success("Runner connected.");
            }}
            status={cloudStatus}
          />
        ) : null}

        {paletteOpen ? (
          <CommandPalette
            items={paletteItems}
            onClose={() => setPaletteOpen(false)}
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
}: {
  blocked: string | null;
  onCreate: () => void;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        flex: 1,
        justifyContent: "center",
        padding: 48,
      }}
    >
      <div style={{ maxWidth: 460, textAlign: "center" }}>
        <Eyebrow
          style={{ color: "var(--text-muted)", letterSpacing: "0.14em" }}
        >
          Cloud sandboxes
        </Eyebrow>
        <h1 style={{ ...type_.display, fontSize: 30, margin: "12px 0 10px" }}>
          Autonomous agents, bounded by infrastructure.
        </h1>
        <p style={{ ...type_.body, margin: "0 auto", maxWidth: "44ch" }}>
          {blocked ??
            "Forge an execution profile, hand it a mission, and read the receipt it proves itself with."}
        </p>
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "center",
            marginTop: 22,
          }}
        >
          <Btn
            disabled={blocked !== null}
            onClick={onCreate}
            size="md"
            variant="primary"
          >
            Forge an agent
          </Btn>
        </div>

        {/* The boundary, published. One quiet line — every claim in it is
            load-bearing and true: runs execute in Cloudflare's sandbox
            containers, the container is the blast radius, and the credential
            is fetched for one run and redacted from evidence. Naming
            Cloudflare is deliberate; the isolation is their product, and
            saying so borrows exactly as much trust as it should. */}
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 8,
            justifyContent: "center",
            marginTop: 26,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              background: "var(--color-success)",
              borderRadius: 999,
              height: 5,
              width: 5,
            }}
          />
          <span
            style={{
              color: "var(--text-faint)",
              font: "400 11px/1.6 var(--font-mono)",
            }}
          >
            isolated Cloudflare sandbox per run · nothing reaches your machine
          </span>
        </div>
        <details style={{ marginTop: 10 }}>
          <summary
            style={{
              color: "var(--text-faint)",
              cursor: "pointer",
              display: "inline-block",
              font: "500 10px/1 var(--font-mono)",
              letterSpacing: "0.1em",
              listStyle: "none",
              textTransform: "uppercase",
            }}
          >
            How a run is bounded
          </summary>
          <p
            style={{
              ...type_.body,
              font: "400 12px/1.7 var(--font-ui)",
              margin: "10px auto 0",
              maxWidth: "46ch",
            }}
          >
            Every run gets its own Cloudflare sandbox container. Filesystem and
            network end with it. Your harness credential is envelope-encrypted,
            fetched for the duration of one run, and redacted from the evidence.
            When the run closes, the receipt is what remains.
          </p>
        </details>
      </div>
    </div>
  );
}
