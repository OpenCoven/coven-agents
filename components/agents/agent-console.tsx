// biome-ignore-all lint/performance/noJsxPropsBind: This stateful console keeps handlers beside the controls they update.

"use client";

import type {
  AgentDefinition,
  Backend,
  CreateAgentInput,
  RunResult,
  Runtime,
} from "@opencoven/agent-contracts";
import {
  Bot,
  Box,
  CheckCircle2,
  ChevronRight,
  Cloud,
  Cpu,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  ShieldAlert,
  Sparkles,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { RunnerClient, type RunnerConnection } from "@/lib/agents/client";
import { createIdentityMinter } from "@/lib/agents/identity";
import { cn } from "@/lib/utils";

const CLOUD_ENDPOINT =
  process.env.NEXT_PUBLIC_CLOUD_RUNNER_URL ?? "http://127.0.0.1:8787";
const LOCAL_ENDPOINT =
  process.env.NEXT_PUBLIC_LOCAL_RUNNER_URL ?? "http://127.0.0.1:7331";

type Connections = Record<Backend, RunnerConnection>;

const EMPTY_CONNECTIONS: Connections = {
  cloud: { endpoint: CLOUD_ENDPOINT, token: "" },
  local: { endpoint: LOCAL_ENDPOINT, token: "" },
};

const DEFAULT_INSTRUCTIONS =
  "You are an autonomous OpenCoven coding agent. Inspect the workspace, implement the requested outcome, run focused verification, and report concrete evidence. Work without asking for approval inside your isolated execution environment.";

function formatDate(value: string | null) {
  if (!value) {
    return "Never";
  }
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(new Date(value));
}

function connectionKey(backend: Backend) {
  return `opencoven-runner-${backend}`;
}

function loadStoredConnection(backend: Backend): RunnerConnection {
  const fallback = EMPTY_CONNECTIONS[backend];
  const stored = window.sessionStorage.getItem(connectionKey(backend));
  if (!stored) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<RunnerConnection>;
    return {
      endpoint:
        typeof parsed.endpoint === "string"
          ? parsed.endpoint
          : fallback.endpoint,
      token: typeof parsed.token === "string" ? parsed.token : "",
    };
  } catch {
    window.sessionStorage.removeItem(connectionKey(backend));
    return fallback;
  }
}

export function AgentConsole() {
  const [backend, setBackend] = useState<Backend>("cloud");
  const [connections, setConnections] =
    useState<Connections>(EMPTY_CONNECTIONS);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [task, setTask] = useState("");
  const [lastRun, setLastRun] = useState<RunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showConnection, setShowConnection] = useState(false);

  const connection = connections[backend];
  /**
   * One minter for the whole console, so the 15-minute token is shared across
   * reconnects rather than re-minted per render.
   *
   * Cloud only. The local runner has no tenancy and still authenticates with a
   * single token on `Authorization`.
   */
  const mintIdentity = useMemo(() => createIdentityMinter(), []);
  const client = useMemo(
    () =>
      new RunnerClient(
        connection,
        undefined,
        backend === "cloud" ? { mintIdentity } : {}
      ),
    [backend, connection, mintIdentity]
  );
  const selected = agents.find((agent) => agent.id === selectedId) ?? null;

  const refresh = useCallback(async () => {
    if (!connection.token) {
      setAgents([]);
      setSelectedId(null);
      return;
    }
    setLoading(true);
    try {
      const nextAgents = await client.listAgents();
      setAgents(nextAgents);
      setSelectedId((current) =>
        nextAgents.some((agent) => agent.id === current)
          ? current
          : (nextAgents[0]?.id ?? null)
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not reach runner."
      );
    } finally {
      setLoading(false);
    }
  }, [client, connection.token]);

  useEffect(() => {
    setConnections({
      cloud: loadStoredConnection("cloud"),
      local: loadStoredConnection("local"),
    });

    /**
     * Ask the server for the cloud connection so nobody has to paste a
     * deployment token by hand. The server's value always wins: a stored one
     * is stale the moment the token is rotated, and a stale token surfaces
     * only as "Runner token was rejected" with nothing pointing at the cause.
     *
     * Failure is silent on purpose — a demo session gets 403 and an
     * unconfigured deployment 503, and in both cases the manual connection
     * dialog is still there as the fallback.
     */
    let cancelled = false;

    fetch("/api/runner-connection")
      .then((response) => (response.ok ? response.json() : null))
      .then((provided: { endpoint?: string; token?: string } | null) => {
        if (cancelled || !provided?.token) {
          return;
        }

        setConnections((current) => ({
          ...current,
          cloud: {
            endpoint: provided.endpoint || current.cloud.endpoint,
            token: provided.token as string,
          },
        }));
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setLastRun(null);
    refresh().catch(() => undefined);
  }, [refresh]);

  function updateConnection(patch: Partial<RunnerConnection>) {
    setConnections((current) => ({
      ...current,
      [backend]: { ...current[backend], ...patch },
    }));
  }

  function saveConnection() {
    window.sessionStorage.setItem(
      connectionKey(backend),
      JSON.stringify(connection)
    );
    setShowConnection(false);
    toast.success(
      `${backend === "cloud" ? "Cloud" : "Local"} runner connected.`
    );
    refresh().catch(() => undefined);
  }

  async function createAgent(input: CreateAgentInput) {
    setLoading(true);
    try {
      const created = await client.createAgent(input);
      setAgents((current) => [created, ...current]);
      setSelectedId(created.id);
      setShowCreate(false);
      toast.success(`${created.name} is ready.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Agent creation failed."
      );
    } finally {
      setLoading(false);
    }
  }

  async function runSelected() {
    if (!selected || !task.trim()) {
      return;
    }
    setRunning(true);
    setLastRun(null);
    setAgents((current) =>
      current.map((agent) =>
        agent.id === selected.id ? { ...agent, status: "running" } : agent
      )
    );
    try {
      const result = await client.runAgent(selected.id, task);
      setLastRun(result);
      setTask("");
      await refresh();
      toast.success(`${selected.name} finished the run.`);
    } catch (error) {
      setAgents((current) =>
        current.map((agent) =>
          agent.id === selected.id ? { ...agent, status: "error" } : agent
        )
      );
      toast.error(error instanceof Error ? error.message : "Agent run failed.");
    } finally {
      setRunning(false);
    }
  }

  async function deleteSelected() {
    if (!selected) {
      return;
    }
    setLoading(true);
    try {
      await client.deleteAgent(selected.id);
      const remaining = agents.filter((agent) => agent.id !== selected.id);
      setAgents(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setLastRun(null);
      toast.success(`${selected.name} was removed.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not remove agent."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-dvh bg-[var(--oc-bg)] text-[var(--oc-text)]">
      <Toaster position="top-center" theme="dark" />
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_65%_-20%,var(--oc-accent-soft),transparent_38%),linear-gradient(rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:auto,42px_42px,42px_42px]" />
      <header className="relative border-white/8 border-b bg-black/20 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-xl border border-[var(--oc-accent-line)] bg-[var(--oc-accent-soft)] text-[var(--oc-accent)]">
              <Sparkles className="size-4" />
            </div>
            <div>
              <div className="font-semibold tracking-[-0.02em]">OpenCoven</div>
              <div className="font-mono text-[10px] text-[var(--oc-text-3)] uppercase tracking-[0.22em]">
                Agent foundry
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <BackendSwitch backend={backend} onChange={setBackend} />
            <Button
              className="border-white/10 bg-white/5 text-white hover:bg-white/10"
              onClick={() => setShowConnection((value) => !value)}
              size="sm"
              variant="outline"
            >
              <Settings2 className="size-4" />
              Connect
            </Button>
          </div>
        </div>
      </header>

      <div className="relative mx-auto grid max-w-[1500px] gap-5 px-5 py-5 lg:grid-cols-[300px_minmax(0,1fr)] lg:px-8">
        <aside className="rounded-2xl border border-white/8 bg-white/[0.025] p-3 shadow-2xl shadow-black/20">
          <div className="flex items-center justify-between px-2 py-2">
            <div>
              <p className="font-medium text-sm">Agents</p>
              <p className="text-[var(--oc-text-3)] text-xs">
                {agents.length} on {backend}
              </p>
            </div>
            <Button
              className="size-8 bg-[var(--oc-accent)] text-[var(--oc-accent-ink)] hover:bg-[var(--oc-accent)]"
              disabled={!connection.token}
              onClick={() => setShowCreate(true)}
              size="icon"
            >
              <Plus className="size-4" />
              <span className="sr-only">Create agent</span>
            </Button>
          </div>

          {connection.token ? (
            agents.length === 0 ? (
              <EmptyState
                action={() => setShowCreate(true)}
                icon={Bot}
                text="No agents here yet. Forge the first one."
              />
            ) : (
              <div className="mt-2 space-y-1">
                {agents.map((agent) => (
                  <button
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition",
                      selectedId === agent.id
                        ? "border-[var(--oc-accent-line)] bg-[var(--oc-accent-soft)]"
                        : "border-transparent hover:border-white/8 hover:bg-white/[0.035]"
                    )}
                    key={agent.id}
                    onClick={() => {
                      setSelectedId(agent.id);
                      setLastRun(null);
                    }}
                    type="button"
                  >
                    <StatusDot status={agent.status} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-sm">
                        {agent.name}
                      </p>
                      <p className="truncate font-mono text-[10px] text-white/35 uppercase">
                        {agent.runtime} / {agent.model}
                      </p>
                    </div>
                    <ChevronRight className="size-4 text-white/20 transition group-hover:text-white/50" />
                  </button>
                ))}
              </div>
            )
          ) : (
            <EmptyState
              action={() => setShowConnection(true)}
              icon={Server}
              text="Connect a runner to create and control agents."
            />
          )}
        </aside>

        <section className="min-w-0">
          {showConnection ? (
            <ConnectionPanel
              backend={backend}
              connection={connection}
              onCancel={() => setShowConnection(false)}
              onChange={updateConnection}
              onSave={saveConnection}
            />
          ) : showCreate ? (
            <CreateAgentPanel
              backend={backend}
              loading={loading}
              onCancel={() => setShowCreate(false)}
              onCreate={createAgent}
            />
          ) : selected ? (
            <AgentWorkspace
              agent={selected}
              lastRun={lastRun}
              onDelete={deleteSelected}
              onRun={runSelected}
              running={running}
              setTask={setTask}
              task={task}
            />
          ) : (
            <WelcomePanel
              backend={backend}
              connected={Boolean(connection.token)}
              loading={loading}
              onConnect={() => setShowConnection(true)}
              onCreate={() => setShowCreate(true)}
              onRefresh={refresh}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function BackendSwitch({
  backend,
  onChange,
}: {
  backend: Backend;
  onChange: (backend: Backend) => void;
}) {
  return (
    <div className="flex rounded-xl border border-white/8 bg-black/30 p-1">
      {(["cloud", "local"] as const).map((value) => {
        const Icon = value === "cloud" ? Cloud : Cpu;
        return (
          <button
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-medium text-xs capitalize transition",
              backend === value
                ? "bg-white/10 text-[var(--oc-accent)]"
                : "text-white/40 hover:text-white/70"
            )}
            key={value}
            onClick={() => onChange(value)}
            type="button"
          >
            <Icon className="size-3.5" />
            {value}
          </button>
        );
      })}
    </div>
  );
}

function StatusDot({ status }: { status: AgentDefinition["status"] }) {
  return (
    <span
      className={cn(
        "size-2 rounded-full shadow-[0_0_12px_currentColor]",
        status === "idle" && "bg-[var(--oc-accent)] text-[var(--oc-accent)]",
        status === "running" && "animate-pulse bg-amber-300 text-amber-300",
        status === "error" && "bg-rose-400 text-rose-400"
      )}
    />
  );
}

function EmptyState({
  action,
  icon: Icon,
  text,
}: {
  action: () => void;
  icon: typeof Bot;
  text: string;
}) {
  return (
    <button
      className="mt-3 grid w-full place-items-center rounded-xl border border-white/8 border-dashed px-5 py-10 text-center transition hover:bg-white/[0.025]"
      onClick={action}
      type="button"
    >
      <Icon className="mb-3 size-5 text-[var(--oc-text-3)]" />
      <span className="max-w-48 text-white/40 text-xs leading-relaxed">
        {text}
      </span>
    </button>
  );
}

function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/8 bg-[var(--oc-panel)]/90 shadow-2xl shadow-black/20",
        className
      )}
    >
      {children}
    </div>
  );
}

function WelcomePanel({
  backend,
  connected,
  loading,
  onConnect,
  onCreate,
  onRefresh,
}: {
  backend: Backend;
  connected: boolean;
  loading: boolean;
  onConnect: () => void;
  onCreate: () => void;
  onRefresh: () => void;
}) {
  return (
    <Panel className="flex min-h-[620px] items-center justify-center p-8 text-center">
      <div className="max-w-2xl">
        <div className="mx-auto mb-6 grid size-16 place-items-center rounded-2xl border border-[var(--oc-accent-line)] bg-[var(--oc-accent-soft)] text-[var(--oc-accent)]">
          <Box className="size-7" />
        </div>
        <p className="mb-3 font-mono text-[var(--oc-text-2)] text-xs uppercase tracking-[0.24em]">
          Local-cloud hybrid
        </p>
        <h1 className="text-balance font-semibold text-4xl tracking-[-0.045em] md:text-5xl">
          Autonomous agents,
          <br />
          bounded by infrastructure.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-pretty text-base text-white/45 leading-relaxed">
          Create zero-approval coding agents in disposable cloud sandboxes or
          connect the same control plane to a trusted local CLI runner.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button
            className="bg-[var(--oc-accent)] text-[var(--oc-accent-ink)] hover:bg-[var(--oc-accent)]"
            onClick={connected ? onCreate : onConnect}
          >
            {connected ? (
              <Plus className="size-4" />
            ) : (
              <Server className="size-4" />
            )}
            {connected ? "Forge an agent" : `Connect ${backend} runner`}
          </Button>
          {connected ? (
            <Button
              className="border-white/10 bg-white/5 text-white hover:bg-white/10"
              disabled={loading}
              onClick={onRefresh}
              variant="outline"
            >
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
              Refresh
            </Button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function ConnectionPanel({
  backend,
  connection,
  onCancel,
  onChange,
  onSave,
}: {
  backend: Backend;
  connection: RunnerConnection;
  onCancel: () => void;
  onChange: (patch: Partial<RunnerConnection>) => void;
  onSave: () => void;
}) {
  return (
    <Panel className="mx-auto max-w-2xl overflow-hidden">
      <div className="border-white/8 border-b px-6 py-5">
        <p className="font-mono text-[var(--oc-text-3)] text-xs uppercase tracking-[0.2em]">
          {backend} control plane
        </p>
        <h2 className="mt-1 font-semibold text-2xl tracking-tight">
          Connect runner
        </h2>
      </div>
      <div className="space-y-5 p-6">
        <Field label="Runner endpoint">
          <Input
            className="border-white/10 bg-black/30"
            onChange={(event) => onChange({ endpoint: event.target.value })}
            placeholder={backend === "cloud" ? CLOUD_ENDPOINT : LOCAL_ENDPOINT}
            value={connection.endpoint}
          />
        </Field>
        <Field label={backend === "cloud" ? "Runner token" : "Access token"}>
          <Input
            autoComplete="off"
            className="border-white/10 bg-black/30 font-mono"
            onChange={(event) => onChange({ token: event.target.value })}
            placeholder="runner token"
            type="password"
            value={connection.token}
          />
          {backend === "cloud" ? (
            <p className="mt-2 text-white/40 text-xs leading-relaxed">
              Grants access to the deployment. Who you are is proved separately
              by a short-lived token minted from your signed-in session, so this
              no longer identifies you and sharing it does not share your
              agents.
            </p>
          ) : null}
        </Field>
        <div className="flex gap-3 rounded-xl border border-amber-300/15 bg-amber-300/5 p-4 text-amber-100/60 text-xs leading-relaxed">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-300" />
          Tokens are held in session storage and cleared when the browser
          session ends. Local runners bind to loopback by default.
        </div>
      </div>
      <div className="flex justify-end gap-2 border-white/8 border-t px-6 py-4">
        <Button onClick={onCancel} variant="ghost">
          Cancel
        </Button>
        <Button
          className="bg-[var(--oc-accent)] text-[var(--oc-accent-ink)] hover:bg-[var(--oc-accent)]"
          disabled={!connection.endpoint || !connection.token}
          onClick={onSave}
        >
          Connect
        </Button>
      </div>
    </Panel>
  );
}

function CreateAgentPanel({
  backend,
  loading,
  onCancel,
  onCreate,
}: {
  backend: Backend;
  loading: boolean;
  onCancel: () => void;
  onCreate: (input: CreateAgentInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  // Both backends now run a harness: the cloud backend runs it inside a
  // per-agent sandbox container, the local backend runs it on this machine.
  // Neither holds a model provider API key, so there is no provider runtime to
  // pick and `auto` lets the signed-in harness choose its own model.
  const [runtime, setRuntime] = useState<Runtime>("copilot");
  const [model, setModel] = useState("auto");
  const [workspace, setWorkspace] = useState(
    backend === "cloud" ? "/workspace" : ""
  );

  return (
    <Panel className="mx-auto max-w-3xl overflow-hidden">
      <div className="border-white/8 border-b px-6 py-5">
        <p className="font-mono text-[var(--oc-text-3)] text-xs uppercase tracking-[0.2em]">
          New {backend} familiar
        </p>
        <h2 className="mt-1 font-semibold text-2xl tracking-tight">
          Forge agent
        </h2>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onCreate({
            backend,
            description,
            instructions,
            model,
            name,
            runtime,
            ...(workspace ? { workspace } : {}),
          }).catch(() => undefined);
        }}
      >
        <div className="grid gap-5 p-6 md:grid-cols-2">
          <Field label="Name">
            <Input
              className="border-white/10 bg-black/30"
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              placeholder="Cody Cloud"
              required
              value={name}
            />
          </Field>
          <Field label="Purpose">
            <Input
              className="border-white/10 bg-black/30"
              maxLength={240}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Ships focused code changes"
              value={description}
            />
          </Field>
          <Field label="Harness">
            <select
              className="h-9 w-full rounded-md border border-white/10 bg-black/30 px-3 text-sm"
              onChange={(event) => setRuntime(event.target.value as Runtime)}
              value={runtime}
            >
              <option value="copilot">GitHub Copilot CLI</option>
              <option disabled value="codex">
                Codex CLI (not wired up yet)
              </option>
              <option disabled value="claude">
                Claude Code (not wired up yet)
              </option>
            </select>
          </Field>
          <Field label="Model">
            <Input
              className="border-white/10 bg-black/30 font-mono"
              onChange={(event) => setModel(event.target.value)}
              placeholder="auto"
              required
              value={model}
            />
          </Field>
          <div>
            <Field label="Workspace">
              <Input
                className="border-white/10 bg-black/30 font-mono"
                onChange={(event) => setWorkspace(event.target.value)}
                placeholder={
                  backend === "cloud" ? "/workspace" : "/path/to/project"
                }
                value={workspace}
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field label="Identity and operating instructions">
              <Textarea
                className="min-h-44 border-white/10 bg-black/30 leading-relaxed"
                maxLength={12_000}
                onChange={(event) => setInstructions(event.target.value)}
                required
                value={instructions}
              />
            </Field>
          </div>
          <div className="md:col-span-2 flex gap-3 rounded-xl border border-rose-300/15 bg-rose-300/5 p-4 text-rose-100/60 text-xs leading-relaxed">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-rose-300" />
            YOLO mode removes interactive tool approvals. Runs are driven by
            your signed-in coding CLI, never by a model provider API key. Cloud
            runs stay inside their per-agent container; local runs inherit the
            operating-system access of the local runner process.
          </div>
        </div>
        <div className="flex justify-end gap-2 border-white/8 border-t px-6 py-4">
          <Button onClick={onCancel} type="button" variant="ghost">
            Cancel
          </Button>
          <Button
            className="bg-[var(--oc-accent)] text-[var(--oc-accent-ink)] hover:bg-[var(--oc-accent)]"
            disabled={loading || !name.trim() || !instructions.trim()}
            type="submit"
          >
            {loading ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Sparkles className="size-4" />
            )}
            Create agent
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function AgentWorkspace({
  agent,
  lastRun,
  onDelete,
  onRun,
  running,
  setTask,
  task,
}: {
  agent: AgentDefinition;
  lastRun: RunResult | null;
  onDelete: () => void;
  onRun: () => void;
  running: boolean;
  setTask: (task: string) => void;
  task: string;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
      <Panel className="overflow-hidden">
        <div className="flex flex-wrap items-start justify-between gap-4 border-white/8 border-b px-6 py-5">
          <div className="flex items-start gap-4">
            <div className="grid size-11 place-items-center rounded-xl border border-[var(--oc-accent-line)] bg-[var(--oc-accent-soft)] text-[var(--oc-accent)]">
              <Bot className="size-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-2xl tracking-tight">
                  {agent.name}
                </h2>
                <StatusDot status={agent.status} />
              </div>
              <p className="mt-1 text-sm text-white/40">
                {agent.description || "Autonomous OpenCoven agent"}
              </p>
            </div>
          </div>
          <Button
            className="text-white/35 hover:bg-rose-400/10 hover:text-rose-300"
            disabled={running}
            onClick={onDelete}
            size="icon"
            variant="ghost"
          >
            <Trash2 className="size-4" />
            <span className="sr-only">Delete agent</span>
          </Button>
        </div>

        <div className="p-6">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <TerminalSquare className="size-4 text-[var(--oc-accent)]" />
              <h3 className="font-medium text-sm">Mission</h3>
            </div>
            <span className="font-mono text-[10px] text-white/30 uppercase tracking-wider">
              approvals disabled
            </span>
          </div>
          <Textarea
            className="min-h-36 resize-y border-white/10 bg-black/35 text-[15px] leading-relaxed shadow-inner"
            disabled={running}
            maxLength={40_000}
            onChange={(event) => setTask(event.target.value)}
            placeholder="Describe the outcome. The agent will inspect, edit, execute, and verify autonomously."
            value={task}
          />
          <div className="mt-3 flex justify-end">
            <Button
              className="bg-[var(--oc-accent)] text-[var(--oc-accent-ink)] hover:bg-[var(--oc-accent)]"
              disabled={running || !task.trim()}
              onClick={onRun}
            >
              {running ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Play className="size-4 fill-current" />
              )}
              {running ? "Agent is working" : "Run autonomously"}
            </Button>
          </div>
        </div>

        <div className="border-white/8 border-t bg-black/20 p-6">
          <div className="mb-3 flex items-center gap-2">
            <CheckCircle2 className="size-4 text-[var(--oc-accent)]" />
            <h3 className="font-medium text-sm">Latest result</h3>
          </div>
          {lastRun ? (
            <div>
              <div className="mb-3 flex flex-wrap gap-2 font-mono text-[10px] uppercase">
                <span
                  className={cn(
                    "rounded-full px-2 py-1",
                    lastRun.status === "completed"
                      ? "bg-[var(--oc-accent-soft)] text-[var(--oc-accent)]"
                      : "bg-rose-300/10 text-rose-200"
                  )}
                >
                  {lastRun.status}
                </span>
                <span className="rounded-full bg-white/5 px-2 py-1 text-white/35">
                  {lastRun.commandResults.length} commands
                </span>
                <span className="rounded-full bg-white/5 px-2 py-1 text-white/35">
                  {lastRun.fileOperations.length} file ops
                </span>
              </div>
              <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-xl border border-white/8 bg-black/40 p-4 font-mono text-[var(--oc-text-2)] text-xs leading-relaxed">
                {lastRun.output || "(Agent returned no final message.)"}
              </pre>
            </div>
          ) : (
            <div className="rounded-xl border border-white/8 border-dashed p-8 text-center text-white/30 text-sm">
              Run a mission to see the agent’s evidence and final response.
            </div>
          )}
        </div>
      </Panel>

      <div className="space-y-5">
        <Panel className="p-5">
          <p className="font-mono text-[var(--oc-text-3)] text-[10px] uppercase tracking-[0.2em]">
            Runtime
          </p>
          <dl className="mt-4 space-y-4 text-sm">
            <Detail label="Backend" value={agent.backend} />
            <Detail label="Harness" value={agent.runtime} />
            <Detail label="Model" value={agent.model} />
            <Detail
              label="Workspace"
              value={agent.workspace ?? "runner default"}
            />
            <Detail label="Last run" value={formatDate(agent.lastRunAt)} />
          </dl>
        </Panel>
        <Panel className="p-5">
          <p className="font-mono text-[var(--oc-text-3)] text-[10px] uppercase tracking-[0.2em]">
            Operating contract
          </p>
          <p className="mt-4 max-h-64 overflow-auto whitespace-pre-wrap text-white/45 text-xs leading-relaxed">
            {agent.instructions}
          </p>
        </Panel>
      </div>
    </div>
  );
}

function Field({
  children,
  label,
}: {
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="block space-y-2">
      <span className="font-medium text-white/55 text-xs">{label}</span>
      {children}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-white/6 border-b pb-3 last:border-0 last:pb-0">
      <dt className="text-white/35">{label}</dt>
      <dd className="break-all text-right font-mono text-[var(--oc-text-2)] text-xs capitalize">
        {value}
      </dd>
    </div>
  );
}
