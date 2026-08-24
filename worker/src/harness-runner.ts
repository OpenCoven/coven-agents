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
const RUN_TIMEOUT_MS = 900_000;
const PROBE_TIMEOUT_MS = 20_000;

type SandboxLike = Pick<Sandbox, "exec">;

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
    const result = await sandbox.exec(
      `${spec.command} ${spec.versionArgs.join(" ")}`,
      { timeout: PROBE_TIMEOUT_MS }
    );
    if (!result.success) {
      return { installed: false, version: null };
    }
    return {
      installed: true,
      version: result.stdout.trim().split("\n")[0]?.trim() || null,
    };
  } catch {
    return { installed: false, version: null };
  }
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

  await options.sandbox.exec(`mkdir -p ${cwd}`, { timeout: PROBE_TIMEOUT_MS });

  const invocation = buildInvocation({
    cwd,
    harness: spec.id,
    instructions: options.instructions,
    model: options.model,
    stream: true,
    task: options.task,
  });
  const command = toShellCommand(invocation);

  const result = await options.sandbox.exec(command, {
    cwd,
    env: {
      [auth.name]: auth.value,
      // The harness is the only thing that talks to a model. Blanking provider
      // keys makes that structural rather than a convention: even if one leaks
      // into the container environment, a run cannot quietly consume it.
      ANTHROPIC_API_KEY: "",
      CI: "true",
      HOME: cwd,
      OPENAI_API_KEY: "",
    },
    timeout: RUN_TIMEOUT_MS,
  });

  const at = new Date().toISOString();
  const events = parseHarnessStream(spec.id, result.stdout, at);
  const summary = summarizeRun(events);

  return {
    command: `${invocation.command} ${invocation.args[0] ?? ""}`.trim(),
    events,
    exitCode: result.exitCode,
    stderr: result.stderr,
    summary,
  };
}
