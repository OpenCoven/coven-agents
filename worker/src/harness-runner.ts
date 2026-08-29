import type { Sandbox } from "@cloudflare/sandbox";
import {
  buildInvocation,
  HARNESS_SPECS,
  type HarnessSpec,
  type HarnessStatus,
  harnessAuthHint,
  harnessSpec,
  harnessStatus,
  isRunnableHarness,
  LineAssembler,
  normalizeEvent,
  type RunEvent,
  type RunSummary,
  shellQuote,
  summarizeRun,
  toShellCommand,
  UNSUPPORTED_HARNESS_RUN_ERROR,
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
 * container that was never going to work. The attempt budget sits ABOVE the
 * slowest healthy boot ever observed — 158s, a cold host pulling the image —
 * because a budget below it turns a marginal-but-healthy boot into a
 * guaranteed miss, and a run that splits into two such attempts then fails
 * twice in a row by construction. 180s per attempt: the fast-500 sick case
 * still detours in seconds, and only a genuinely dead placement spends the
 * full attempt.
 */
export const PROBE_ATTEMPT_TIMEOUT_MS = 180_000;

/**
 * `destroy` is optional on both shapes because cancellation is the only
 * caller that needs it, and most test doubles have no reason to implement
 * it. A sandbox that cannot be destroyed simply cannot be reaped on
 * cancellation — the run still fails, it just leaves the container to the
 * idle reaper.
 */
type SandboxLike = Pick<Sandbox, "exec"> & Partial<Pick<Sandbox, "destroy">>;
type SandboxDestroy = () => Promise<void>;
type MissionSandbox = Pick<
  Sandbox,
  "exec" | "getProcess" | "getProcessLogs" | "killProcess" | "startProcess"
> &
  Partial<Pick<Sandbox, "destroy">>;

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
 *
 * Cancellation is the one path that does reap the container, and it is
 * deliberately not the timeout path: a deadline leaves the sandbox alone so
 * the caller's own retry can decide whether a fresh placement is warranted,
 * while an aborted run has no such caller left and would otherwise strand a
 * container nobody is waiting on. With no `signal` supplied this degrades
 * exactly to a deadline race, which is what every caller that predates
 * cancellation gets.
 */
async function withDeadlineAndCancellation<T>(
  work: Promise<T>,
  options: {
    destroySandbox?: SandboxDestroy;
    label: string;
    ms: number;
    sandbox: SandboxLike;
    signal?: AbortSignal;
  }
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellationRequested = false;
  let cancellation: Promise<never> | undefined;
  let rejectAbort: (error: unknown) => void = () => undefined;
  let onAbort: (() => void) | undefined;
  const abort = async (): Promise<never> => {
    try {
      await (options.destroySandbox
        ? options.destroySandbox()
        : Promise.resolve(options.sandbox.destroy?.()));
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: HarnessError stores the cause through its typed constructor.
      throw new HarnessError(
        error instanceof Error
          ? `Sandbox cleanup failed during cancellation: ${error.message}`
          : "Sandbox cleanup failed during cancellation.",
        "sandbox_cleanup_failed",
        { cause: error }
      );
    }
    throw new HarnessError(
      "The cloud run was cancelled before the sandbox command completed.",
      "harness_cancelled"
    );
  };
  const beginCancellation = () => {
    cancellation ??= abort();
    return cancellation;
  };
  const aborted = options.signal
    ? new Promise<never>((_, reject) => {
        rejectAbort = reject;
      })
    : undefined;
  onAbort = () => {
    cancellationRequested = true;
    // Cancellation has won as soon as the signal fires. Clear the deadline
    // before awaiting durable sandbox cleanup so a wedged operation cannot
    // keep a timer handle alive behind the cancellation path.
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    beginCancellation().catch(rejectAbort);
  };
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new HarnessError(
            `\`${options.label}\` exceeded ${Math.round(options.ms / 1000)}s inside the sandbox. The container may still be executing it; the run is failed so the agent is not wedged behind it.`,
            "harness_timeout"
          )
        );
      }, options.ms);
    });
    if (options.signal && onAbort) {
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
      }
    }
    const guardedWork = work.then(
      (value) => (cancellationRequested ? beginCancellation() : value),
      (error: unknown) =>
        cancellationRequested ? beginCancellation() : Promise.reject(error)
    );
    const candidates: Promise<T | never>[] = [guardedWork, deadline];
    if (aborted) {
      candidates.push(aborted);
    }
    return await Promise.race(candidates);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (options.signal && onAbort) {
      options.signal.removeEventListener("abort", onAbort);
    }
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
  if (!isRunnableHarness(runtime)) {
    throw new HarnessError(
      UNSUPPORTED_HARNESS_RUN_ERROR.message,
      UNSUPPORTED_HARNESS_RUN_ERROR.code
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

/**
 * The probe's knobs are an object rather than positionals on purpose: the
 * budget and the cancellation handles arrived from two different directions,
 * and `probeInstalled(sandbox, spec, somethingMs, maybeSignal)` is exactly
 * the shape where a caller silently passes the wrong third argument.
 */
async function probeInstalled(
  sandbox: SandboxLike,
  spec: HarnessSpec,
  options: {
    destroySandbox?: SandboxDestroy;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}
): Promise<{ installed: boolean; version: string | null }> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const result = await withDeadlineAndCancellation(
      sandbox.exec(`${spec.command} ${spec.versionArgs.join(" ")}`, {
        timeout: timeoutMs,
      }),
      {
        destroySandbox: options.destroySandbox,
        label: `${spec.command} --version`,
        ms: timeoutMs,
        sandbox,
        signal: options.signal,
      }
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
     *
     * Cancellation propagates for the same reason and one more: a cancelled
     * probe has already destroyed the container, so answering "not installed"
     * would send the caller's retry at a sandbox that no longer exists.
     */
    if (
      error instanceof HarnessError &&
      (error.code === "harness_timeout" ||
        error.code === "harness_cancelled" ||
        error.code === "sandbox_cleanup_failed")
    ) {
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
 *
 * `ownsSandbox` is the fence between warming and running. A warm-up outlives
 * the request that started it, so by the time its retry comes due the same
 * sandbox may belong to a real run — and a warm-up that destroys a container
 * mid-mission is worse than one that never ran. Checked before each attempt
 * and again before the retry sleep pays out.
 */
export async function warmSandbox(
  sandbox: SandboxLike,
  runtime: string,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  options: {
    destroy?: SandboxDestroy;
    ownsSandbox?: () => boolean;
    signal?: AbortSignal;
  } = {}
): Promise<{ ready: boolean; version: string | null }> {
  const spec = harnessSpec(runtime);
  if (!spec) {
    return { ready: false, version: null };
  }

  const attempt = async () => {
    if (options.signal?.aborted || options.ownsSandbox?.() === false) {
      return { installed: false, retry: false, version: null };
    }
    try {
      const result = await probeInstalled(sandbox, spec, {
        destroySandbox: options.destroy,
        signal: options.signal,
      });
      return { ...result, retry: !result.installed };
    } catch (error) {
      if (
        error instanceof HarnessError &&
        (error.code === "harness_cancelled" ||
          error.code === "sandbox_cleanup_failed")
      ) {
        return { installed: false, retry: false, version: null };
      }
      if (error instanceof HarnessError && error.code === "harness_timeout") {
        /**
         * A warm-up that timed out has a container that is probably sick, and
         * unlike a run there is nobody to hand it to. Reap it before the
         * retry so attempt two lands on a fresh placement rather than the
         * same wedged one — but only if reaping actually succeeds, because a
         * retry against a container we failed to destroy is the same attempt
         * twice.
         */
        const destroy = options.destroy ?? sandbox.destroy;
        if (!destroy) {
          return { installed: false, retry: false, version: null };
        }
        try {
          if (options.destroy) {
            await options.destroy();
          } else {
            await sandbox.destroy?.();
          }
        } catch {
          return { installed: false, retry: false, version: null };
        }
        return { installed: false, retry: true, version: null };
      }
      // A warm-up timeout is not a run timeout — nobody is waiting on it.
      return { installed: false, retry: true, version: null };
    }
  };

  const first = await attempt();
  if (first.installed) {
    return { ready: true, version: first.version };
  }
  if (!first.retry) {
    return { ready: false, version: null };
  }
  if (options.signal?.aborted) {
    return { ready: false, version: null };
  }
  /**
   * The retry sleep is the longest window in the warm path, so it races the
   * abort rather than blocking it: waiting out a 30s pause to then discover
   * the run was cancelled holds the container for no reason.
   */
  const canRetry = await new Promise<boolean>((resolve) => {
    if (options.signal?.aborted || options.ownsSandbox?.() === false) {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(false);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    wait(WARM_RETRY_DELAY_MS)
      .then(() => finish(true))
      .catch(() => finish(false));
  });
  if (!canRetry) {
    return { ready: false, version: null };
  }
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
  /**
   * Reaps the container when the run is cancelled. Distinct from
   * `resetSandbox`, which answers a sick placement mid-probe and expects the
   * key to re-provision; this one ends the sandbox because nobody is waiting
   * for it any more.
   */
  destroySandbox?: SandboxDestroy;
  /** Aborts the run at the next sandbox boundary and reaps the container. */
  signal?: AbortSignal;
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
  const probeOptions = {
    destroySandbox: options.destroySandbox,
    signal: options.signal,
    timeoutMs: PROBE_ATTEMPT_TIMEOUT_MS,
  };
  let probe: { installed: boolean; version: string | null } | null = null;
  try {
    probe = await probeInstalled(options.sandbox, spec, probeOptions);
  } catch (error) {
    /**
     * Only a deadline earns the second attempt. A cancelled probe has already
     * reaped the container and has no caller left to serve, so retrying it
     * would provision a fresh sandbox for a run nobody wants.
     */
    if (!(error instanceof HarnessError && error.code === "harness_timeout")) {
      throw error;
    }
    probe = null;
  }
  if (!probe?.installed) {
    console.warn({ event: "sandbox.probe_retry_on_fresh_container" });
    await options.resetSandbox?.();
    probe = await probeInstalled(options.sandbox, spec, probeOptions);
  }
  if (!probe.installed) {
    throw new HarnessError(
      `\`${spec.command}\` is not installed in the sandbox image. Add \`${spec.installPackage}\` to worker/Dockerfile and redeploy.`,
      "harness_missing"
    );
  }

  await withDeadlineAndCancellation(
    /**
     * Quoted, because `resolveSandboxWorkspace` bounds where the path may
     * point and nothing else about it. `workspace: "repo; touch /tmp/pwned"`
     * resolves to a path that is genuinely inside `/workspace` and so passes
     * every check above — and then the `;` ends the `mkdir` and starts a
     * second command. The blast radius is the tenant's own container, which
     * they already run code in by design, but "already allowed to" is not a
     * reason to hand them a shell they did not ask for.
     */
    options.sandbox.exec(`mkdir -p ${shellQuote(cwd)}`, {
      timeout: PROBE_TIMEOUT_MS,
    }),
    {
      destroySandbox: options.destroySandbox,
      label: "mkdir",
      ms: PROBE_TIMEOUT_MS,
      sandbox: options.sandbox,
      signal: options.signal,
    }
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
  const started = await withDeadlineAndCancellation(
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
    {
      destroySandbox: options.destroySandbox,
      label: `${spec.command} start`,
      ms: PROBE_ATTEMPT_TIMEOUT_MS,
      sandbox: options.sandbox,
      signal: options.signal,
    }
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
      // biome-ignore lint/performance/noAwaitInLoops: a poll loop is sequential by definition — each wait and read must finish before the next is decided.
      await wait(pollMs);
      try {
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
