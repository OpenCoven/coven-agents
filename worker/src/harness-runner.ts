import type { Sandbox } from "@cloudflare/sandbox";
import {
  buildInvocation,
  HARNESS_SPECS,
  type HarnessSpec,
  type HarnessStatus,
  harnessAuthHint,
  harnessSpec,
  harnessStatus,
  LineAssembler,
  normalizeEvent,
  type RunEvent,
  type RunSummary,
  summarizeRun,
  toShellCommand,
} from "@opencoven/harness";

const DEFAULT_WORKSPACE = "/workspace";
export const RUN_TIMEOUT_MS = 900_000;
const PROCESS_POLL_INTERVAL_MS = 2000;
const MAX_POLL_FAILURES = 5;
/**
 * Generous, and deliberately so. The deadline clock starts when the worker
 * awaits the exec, and that await covers the container's cold boot as well
 * as the command: a fully cold run was observed to fail at 180s while the
 * sandbox went on to log the exec itself succeeding in 110s — boot plus a
 * Node CLI's first launch had already spent the budget before the command
 * finished. Five minutes bounds the truly wedged case (the old unenforced
 * 20s once hid a half-hour zombie) without failing healthy cold starts.
 *
 * Exported for the deadline tests, which advance mocked time relative to this
 * value. They previously hardcoded a tick that outran the old 180s deadline;
 * raising it to 300s left the tick short, the timer never fired, and the whole
 * worker suite hung on a never-resolving promise instead of failing. Deriving
 * the tick from the constant keeps the next change to it honest.
 */
export const PROBE_TIMEOUT_MS = 300_000;
/**
 * The mission path splits the probe budget into two attempts with a
 * container reset between them. Cold placements are a coin flip in
 * production — healthy ones probe in 50–160s, sick ones answer HTTP 500
 * until the deadline — so one 300s attempt spends the whole budget on a
 * container that was never going to work, while two 150s attempts against
 * different placements keep the same worst case and turn a bad flip into a
 * 150s detour instead of a dead run.
 */
export const PROBE_ATTEMPT_TIMEOUT_MS = 150_000;

type SandboxLike = Pick<Sandbox, "exec">;
type MissionSandbox = Pick<
  Sandbox,
  "exec" | "getProcess" | "getProcessLogs" | "killProcess" | "startProcess"
>;

/**
 * Enforces a deadline the SDK does not.
 *
 * `sandbox.exec` accepts `{ timeout }` in its types and never reads it — the
 * compiled runtime contains no reference to the option. Every timeout this
 * file passed was decorative, which is how one wedged `copilot --version`
 * held an agent's active-run slot for half an hour and every run after it was
 * refused: nothing bounded the exec, and nothing behind it did either.
 *
 * A race does not kill the process in the container — the container keeps it
 * until the sandbox is destroyed. What it does is bound the *run*: the throw
 * marks it failed, releases the active slot, and tells the client something
 * true instead of streaming silence.
 */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new HarnessError(
              `\`${label}\` exceeded ${Math.round(ms / 1000)}s inside the sandbox. The container may still be executing it; the run is failed so the agent is not wedged behind it.`,
              "harness_timeout"
            )
          );
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type HarnessCredential = {
  /** The tenant's credential, or null when they have configured none. */
  credential: string | null;
};

export interface HarnessRun {
  readonly command: string;
  readonly events: RunEvent[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly summary: RunSummary;
}

export class HarnessError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
    this.name = "HarnessError";
  }
}

/**
 * Keeps a requested workspace inside the sandbox's workspace root. The sandbox
 * is already isolated, but a run that silently wrote to `/etc` because the
 * caller passed `../..` would still be a surprise worth refusing.
 */
export function resolveSandboxWorkspace(requested?: string): string {
  const raw = (requested ?? "").trim();
  if (!raw) {
    return DEFAULT_WORKSPACE;
  }
  const base = raw.startsWith("/") ? raw : `${DEFAULT_WORKSPACE}/${raw}`;
  const parts: string[] = [];
  for (const segment of base.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  const resolved = `/${parts.join("/")}`;
  if (
    resolved !== DEFAULT_WORKSPACE &&
    !resolved.startsWith(`${DEFAULT_WORKSPACE}/`)
  ) {
    throw new HarnessError(
      `Workspace must stay inside ${DEFAULT_WORKSPACE}.`,
      "workspace_escape"
    );
  }
  return resolved;
}

/**
 * Resolves the harness credential from the tenant's own credential, already
 * fetched by the caller from the Next app. This is deliberately the only
 * credential lookup in the cloud path: Coven Agents drives a signed-in coding
 * CLI on the tenant's behalf and never substitutes the owner's identity or a
 * model provider API key of its own.
 */
export function requireHarness(
  runtime: string,
  supplied: HarnessCredential
): { auth: { name: string; value: string }; spec: HarnessSpec } {
  const spec = harnessSpec(runtime);
  if (!spec) {
    throw new HarnessError(`Unknown harness: ${runtime}`, "unknown_harness");
  }
  if (!spec.supported) {
    throw new HarnessError(
      `${spec.label} is detected but its event translation is not implemented yet. Use one of: ${HARNESS_SPECS.filter(
        (candidate) => candidate.supported
      )
        .map((candidate) => candidate.id)
        .join(", ")}.`,
      "harness_unsupported"
    );
  }
  // The env var NAME still comes from the harness's own spec — that is what
  // the sandbox needs to set for the CLI to find it. The VALUE only ever
  // comes from the tenant's own credential, never from this Worker's
  // deployment secrets: an owner secret must never be able to satisfy a
  // tenant's run.
  const [name] = spec.authEnvVars;
  const value = supplied.credential?.trim();
  if (!name || !value) {
    throw new HarnessError(harnessAuthHint(spec), "harness_unauthenticated");
  }
  return { auth: { name, value }, spec };
}

async function probeInstalled(
  sandbox: SandboxLike,
  spec: HarnessSpec,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<{ installed: boolean; version: string | null }> {
  try {
    const result = await withDeadline(
      sandbox.exec(`${spec.command} ${spec.versionArgs.join(" ")}`, {
        timeout: timeoutMs,
      }),
      timeoutMs,
      `${spec.command} --version`
    );
    if (!result.success) {
      return { installed: false, version: null };
    }
    return {
      installed: true,
      version: result.stdout.trim().split("\n")[0]?.trim() || null,
    };
  } catch (error) {
    /**
     * A timeout is not "not installed". Folding it into `installed: false`
     * makes the caller throw `harness_missing`, whose message tells the
     * operator to add the package to the Dockerfile — advice that is wrong and
     * costs a rebuild before anyone questions it. The deadline names the real
     * condition, so it propagates.
     */
    if (error instanceof HarnessError && error.code === "harness_timeout") {
      throw error;
    }
    return { installed: false, version: null };
  }
}

const WARM_RETRY_DELAY_MS = 30_000;

/**
 * Boots the container ahead of a run by running the harness's version probe.
 *
 * The harness CLIs are baked into the image, so there is nothing to install;
 * the cost this pays down is the container boot plus the CLI's first launch
 * — the same ~110s the first probe of a cold run would otherwise spend while
 * the user watches. One retry after a pause covers a boot that lost a race
 * with placement; after that the answer is honest and a run simply pays the
 * cold start it would have paid without warming.
 *
 * Never throws: warming is an optimization and a failed optimization must
 * degrade to today's behaviour, not to a failed anything.
 */
export async function warmSandbox(
  sandbox: SandboxLike,
  runtime: string,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<{ ready: boolean; version: string | null }> {
  const spec = harnessSpec(runtime);
  if (!spec) {
    return { ready: false, version: null };
  }

  const attempt = async () => {
    try {
      return await probeInstalled(sandbox, spec);
    } catch {
      // A warm-up timeout is not a run timeout — nobody is waiting on it.
      return { installed: false, version: null };
    }
  };

  const first = await attempt();
  if (first.installed) {
    return { ready: true, version: first.version };
  }
  await wait(WARM_RETRY_DELAY_MS);
  const second = await attempt();
  return { ready: second.installed, version: second.version };
}

export function listCloudHarnesses(
  sandbox: SandboxLike
): Promise<HarnessStatus[]> {
  return Promise.all(
    HARNESS_SPECS.map(async (spec) =>
      harnessStatus(spec, await probeInstalled(sandbox, spec))
    )
  );
}

export function parseHarnessStream(
  harness: string,
  stdout: string,
  fallbackAt: string
): RunEvent[] {
  const assembler = new LineAssembler();
  const events: RunEvent[] = [];
  for (const line of [...assembler.push(stdout), ...assembler.flush()]) {
    events.push(...normalizeEvent(harness as never, line, fallbackAt));
  }
  return events;
}

/**
 * Runs a mission by driving the harness CLI inside the sandbox container. The
 * Worker is a control plane only: it never calls a model provider, so it needs
 * no provider credential.
 */
export async function runHarnessInSandbox(options: {
  credential: HarnessCredential;
  instructions: string;
  model: string;
  /**
   * Called for each harness event as it streams out of the container, so a
   * caller can surface progress while the run is still going. The events a
   * run RETURNS remain the authoritative record; this callback is the live
   * view of the same stream, not a second source of truth. Text arrives
   * unredacted here — the caller owns redaction before anything persists.
   */
  onEvent?: (event: RunEvent) => void;
  /**
   * Destroys the current container so the next exec gets a fresh placement.
   * Called once, between the two probe attempts, when the first attempt
   * timed out or errored — proven in production: a destroyed sandbox key
   * re-provisions on the next exec and has come back healthy.
   */
  resetSandbox?: () => Promise<void>;
  /** Test seams: the poll cadence and the clocks behind it. */
  clock?: () => number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  runtime: string;
  sandbox: MissionSandbox;
  task: string;
  workspace?: string;
}): Promise<HarnessRun> {
  const { auth, spec } = requireHarness(options.runtime, options.credential);
  const cwd = resolveSandboxWorkspace(options.workspace);

  /**
   * Attempt one on whatever container answers; if it does not come up
   * healthy inside its half of the budget — timeout or a sick transport —
   * destroy it and spend the other half on a fresh placement. Only the
   * second attempt's verdict is allowed to name a missing CLI: a sick
   * container also reads as "not installed", and that message tells the
   * operator to rebuild the image, which is wrong and expensive advice.
   */
  let probe: { installed: boolean; version: string | null } | null = null;
  try {
    probe = await probeInstalled(
      options.sandbox,
      spec,
      PROBE_ATTEMPT_TIMEOUT_MS
    );
  } catch (error) {
    if (!(error instanceof HarnessError && error.code === "harness_timeout")) {
      throw error;
    }
    probe = null;
  }
  if (!probe?.installed) {
    console.warn({ event: "sandbox.probe_retry_on_fresh_container" });
    await options.resetSandbox?.();
    probe = await probeInstalled(
      options.sandbox,
      spec,
      PROBE_ATTEMPT_TIMEOUT_MS
    );
  }
  if (!probe.installed) {
    throw new HarnessError(
      `\`${spec.command}\` is not installed in the sandbox image. Add \`${spec.installPackage}\` to worker/Dockerfile and redeploy.`,
      "harness_missing"
    );
  }

  await withDeadline(
    options.sandbox.exec(`mkdir -p ${cwd}`, { timeout: PROBE_TIMEOUT_MS }),
    PROBE_TIMEOUT_MS,
    "mkdir"
  );

  const invocation = buildInvocation({
    cwd,
    harness: spec.id,
    instructions: options.instructions,
    model: options.model,
    stream: true,
    task: options.task,
  });
  const command = toShellCommand(invocation);

  /**
   * The mission runs as a background process and the worker polls its logs.
   *
   * This replaces a single streamed exec whose long-lived connection was the
   * run's weakest part: it dropped at roughly six minutes on every long
   * mission (352s, 433s, twice deadline-masked at 905s), and on a container
   * re-provisioned after a probe retry its output callback delivered
   * nothing at all — a run the operator watched "streaming" recorded zero
   * events. Polling has neither failure mode. Each poll is a short request,
   * so there is nothing long-lived to drop, and the worker reads stdout
   * itself instead of trusting a callback across two RPC boundaries. The
   * assembler holds partial lines so a JSON object split across polls still
   * parses.
   */
  const assembler = new LineAssembler();
  const streamed: RunEvent[] = [];
  const emit = (line: string) => {
    for (const event of normalizeEvent(
      spec.id as never,
      line,
      new Date().toISOString()
    )) {
      streamed.push(event);
      options.onEvent?.(event);
    }
  };
  const hasFinished = () => streamed.some((event) => event.kind === "finished");

  const now = options.clock ?? (() => Date.now());
  const wait =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollIntervalMs ?? PROCESS_POLL_INTERVAL_MS;

  const startedAt = now();
  const started = await withDeadline(
    options.sandbox.startProcess(command, {
      autoCleanup: false,
      cwd,
      env: {
        [auth.name]: auth.value,
        // The harness is the only thing that talks to a model. Blanking
        // provider keys makes that structural rather than a convention: even
        // if one leaks into the container environment, a run cannot quietly
        // consume it.
        ANTHROPIC_API_KEY: "",
        CI: "true",
        HOME: cwd,
        OPENAI_API_KEY: "",
      },
    }),
    PROBE_ATTEMPT_TIMEOUT_MS,
    `${spec.command} start`
  );

  const state = {
    consumed: 0,
    exitCode: null as number | null,
    pollFailures: 0,
    processEnded: false,
    stderrText: "",
    timedOut: false,
  };

  /** One poll turn: read fresh output, then ask whether anything ended. */
  const pollOnce = async (): Promise<"continue" | "done"> => {
    const logs = await options.sandbox.getProcessLogs(started.id);
    state.pollFailures = 0;
    const fresh = logs.stdout.slice(state.consumed);
    state.consumed = logs.stdout.length;
    state.stderrText = logs.stderr;
    for (const line of assembler.push(fresh)) {
      emit(line);
    }
    if (hasFinished()) {
      return "done";
    }
    const current = await options.sandbox.getProcess(started.id);
    if (
      !current ||
      current.status === "completed" ||
      current.status === "failed" ||
      current.status === "killed" ||
      current.status === "error"
    ) {
      state.exitCode = current?.exitCode ?? null;
      state.processEnded = true;
      return "done";
    }
    return "continue";
  };

  const drive = async (): Promise<void> => {
    while (true) {
      if (now() - startedAt > RUN_TIMEOUT_MS) {
        state.timedOut = true;
        return;
      }
      // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by definition — each wait and read must finish before the next is decided.
      await wait(pollMs);
      try {
        // biome-ignore lint/performance/noAwaitInLoops: see above.
        if ((await pollOnce()) === "done") {
          return;
        }
      } catch (error) {
        state.pollFailures += 1;
        if (state.pollFailures < MAX_POLL_FAILURES) {
          continue;
        }
        if (hasFinished()) {
          return;
        }
        // biome-ignore lint/style/useErrorCause: the cause IS forwarded — HarnessError's third parameter hands it to Error's options — but the rule only recognizes the literal two-argument Error shape.
        throw new HarnessError(
          `Lost contact with the container after ${streamed.length} recorded events and ${MAX_POLL_FAILURES} consecutive failed polls. The transcript up to the loss is retained; the mission did not report a result.`,
          "harness_stream_lost",
          { cause: error }
        );
      }
    }
  };

  await drive();

  if (state.timedOut) {
    // The deadline is the one condition that still reaps upstream: a mission
    // that produced neither a result nor an exit in fifteen minutes is
    // wedged, and its container is suspect.
    await options.sandbox.killProcess(started.id).catch(() => undefined);
    throw new HarnessError(
      `\`${spec.command}\` exceeded ${Math.round(RUN_TIMEOUT_MS / 1000)}s inside the sandbox. The process was signalled; the run is failed so the agent is not wedged behind it.`,
      "harness_timeout"
    );
  }
  if (!state.processEnded) {
    // The harness answered but the process lingers; signal it so it cannot
    // hold the container's CPU. The container itself stays for the next run.
    await options.sandbox.killProcess(started.id).catch(() => undefined);
  }

  for (const line of assembler.flush()) {
    emit(line);
  }

  const finished = streamed.find(
    (event): event is Extract<RunEvent, { kind: "finished" }> =>
      event.kind === "finished"
  );
  const summary = summarizeRun(streamed);
  if (!state.processEnded) {
    console.log({
      event: "sandbox.exec_settled_from_stream",
      exitCode: finished?.exitCode ?? null,
      status: summary.status,
    });
  }

  return {
    command: `${invocation.command} ${invocation.args[0] ?? ""}`.trim(),
    events: streamed,
    exitCode: finished?.exitCode ?? state.exitCode,
    stderr: state.stderrText,
    summary,
  };
}
