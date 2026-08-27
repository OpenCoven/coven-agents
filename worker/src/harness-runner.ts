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
const FINISH_GRACE_MS = 15_000;
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

type SandboxLike = Pick<Sandbox, "exec">;

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

  constructor(message: string, code: string) {
    super(message);
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
  spec: HarnessSpec
): Promise<{ installed: boolean; version: string | null }> {
  try {
    const result = await withDeadline(
      sandbox.exec(`${spec.command} ${spec.versionArgs.join(" ")}`, {
        timeout: PROBE_TIMEOUT_MS,
      }),
      PROBE_TIMEOUT_MS,
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
  /** Test seam: how long a finished stream waits for the process to exit. */
  finishGraceMs?: number;
  runtime: string;
  sandbox: SandboxLike;
  task: string;
  workspace?: string;
}): Promise<HarnessRun> {
  const { auth, spec } = requireHarness(options.runtime, options.credential);
  const cwd = resolveSandboxWorkspace(options.workspace);

  const probe = await probeInstalled(options.sandbox, spec);
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
   * The exec streams instead of buffering. Before this, stdout was parsed
   * only after the CLI exited, so the thread showed nothing between
   * "running" and the outcome — a fifteen-minute run was indistinguishable
   * from a wedged one. `onOutput` is present in the SDK's compiled runtime
   * (verified, unlike `timeout`), and the assembler holds partial lines so
   * a JSON object split across chunks still parses.
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

  /**
   * The stream's own completion signal outranks the process's exit.
   *
   * Copilot emits a terminal `result` line when the mission is answered, and
   * the CLI can then linger — observed twice as a run that streamed its work
   * live and was still stamped failed at the 900s deadline, with the reaper
   * tearing down a container whose only crime was a process that would not
   * exit. "Network connection lost (905s)" in the sandbox log was our own
   * teardown, not the network. Once `finished` streams, the exec gets a
   * short grace to exit on its own; after that the run settles from the
   * streamed events, which carry everything the summary needs. The lingering
   * process is left to the container's idle stop — the work is done, and a
   * successful run must not reap the warm container the next run wants.
   */
  let settleEarly: (() => void) | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const finishedEarly = new Promise<null>((resolve) => {
    settleEarly = () => {
      graceTimer = setTimeout(
        () => resolve(null),
        options.finishGraceMs ?? FINISH_GRACE_MS
      );
    };
  });

  const execution = options.sandbox.exec(command, {
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
    onOutput: (source, data) => {
      if (source !== "stdout") {
        return;
      }
      for (const line of assembler.push(data)) {
        emit(line);
      }
      if (streamed.some((event) => event.kind === "finished")) {
        settleEarly?.();
        settleEarly = undefined;
      }
    },
    stream: true,
    timeout: RUN_TIMEOUT_MS,
  });
  // The race may settle on the stream's finish first; a later exec rejection
  // must not surface as an unhandled rejection.
  execution.catch(() => undefined);

  const result = await withDeadline(
    Promise.race([execution, finishedEarly]),
    RUN_TIMEOUT_MS,
    spec.command
  ).finally(() => clearTimeout(graceTimer));

  for (const line of assembler.flush()) {
    emit(line);
  }

  if (result === null) {
    // Settled from the stream: the process is still alive, so there is no
    // exit code — the finished event's own verdict is the authoritative one.
    const finished = streamed.find(
      (event): event is Extract<RunEvent, { kind: "finished" }> =>
        event.kind === "finished"
    );
    const summary = summarizeRun(streamed);
    console.log({
      event: "sandbox.exec_settled_from_stream",
      exitCode: finished?.exitCode ?? null,
      status: summary.status,
    });
    return {
      command: `${invocation.command} ${invocation.args[0] ?? ""}`.trim(),
      events: streamed,
      exitCode: finished?.exitCode ?? 0,
      stderr: "",
      summary,
    };
  }

  const at = new Date().toISOString();
  // A runtime that ignored the streaming callbacks still produced stdout —
  // parse it rather than reporting an empty run.
  const events =
    streamed.length > 0
      ? streamed
      : parseHarnessStream(spec.id, result.stdout, at);
  const summary = summarizeRun(events);

  return {
    command: `${invocation.command} ${invocation.args[0] ?? ""}`.trim(),
    events,
    exitCode: result.exitCode,
    stderr: result.stderr,
    summary,
  };
}
