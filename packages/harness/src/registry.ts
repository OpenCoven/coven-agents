import type { HarnessId, HarnessStatus } from "./schema";

export interface HarnessSpec {
  /**
   * Per-call credential transport names, in precedence order. Most are read
   * directly by the CLI. COVEN_CODEX_AUTH_JSON is staged as auth.json in an
   * isolated CODEX_HOME instead. These are CLI sign-in credentials, never
   * model provider API keys.
   */
  readonly authEnvVars: readonly string[];
  /** Executable name, resolved from PATH. */
  readonly command: string;
  readonly id: HarnessId;
  /** npm package that provides `command`, used to build the container image. */
  readonly installPackage: string;
  /**
   * Exact published version of `installPackage`. This is the single source of
   * truth for the pin: the Daytona image derives its install command from it
   * and harness discovery reports it, so there is one place to bump and no
   * second copy to drift from.
   *
   * A bump here is not sufficient on its own. Snapshots are immutable and
   * `provisionDaytonaSnapshot` refuses to recreate a name, so the running
   * snapshot keeps whatever CLI it was built with until a new generation is
   * provisioned. Bump `DAYTONA_COPILOT_SNAPSHOT_NAME` in the same change.
   */
  readonly installVersion: string;
  readonly label: string;
  /**
   * Model ids the pinned CLI accepts for `--model`, with `auto` first.
   *
   * `auto` means no flag is passed and the harness chooses. The rest are
   * passed through verbatim, so this list must mirror what `installVersion`
   * actually accepts — it is maintained alongside the pin in this same spec,
   * and a stale entry fails a run at the harness rather
   * than anywhere recoverable. The console offers exactly this list
   * and nothing free-typed, because a typo here used to be a failed run with
   * a model error the user had no reason to expect.
   */
  readonly models: readonly string[];
  /** Emits structured events rather than only a final blob of text. */
  readonly streams: boolean;
  /** Event translation is implemented, so this harness may actually be run. */
  readonly supported: boolean;
  readonly versionArgs: readonly string[];
}

export const HARNESS_SPECS: readonly HarnessSpec[] = [
  {
    authEnvVars: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
    command: "copilot",
    id: "copilot",
    installPackage: "@github/copilot",
    installVersion: "1.0.80",
    label: "GitHub Copilot CLI",
    models: ["auto", "claude-sonnet-4.5", "gpt-5", "gpt-5-mini"],
    streams: true,
    supported: true,
    versionArgs: ["--version"],
  },
  {
    authEnvVars: ["COVEN_CODEX_AUTH_JSON"],
    command: "codex",
    id: "codex",
    installPackage: "@openai/codex",
    installVersion: "0.152.1",
    label: "Codex CLI",
    models: ["auto"],
    streams: true,
    supported: true,
    versionArgs: ["--version"],
  },
  {
    authEnvVars: ["CLAUDE_CODE_OAUTH_TOKEN"],
    command: "claude",
    id: "claude",
    installPackage: "@anthropic-ai/claude-code",
    installVersion: "2.1.258",
    label: "Claude Code",
    models: ["auto"],
    streams: true,
    supported: true,
    versionArgs: ["--version"],
  },
];

/**
 * The exact `package@version` argument used to install this harness. Every
 * installation site builds its command from this, so the image, the reported
 * version, and the install hint can never disagree.
 */
export function harnessInstallSpecifier(spec: HarnessSpec): string {
  return `${spec.installPackage}@${spec.installVersion}`;
}

export function harnessSpec(id: string): HarnessSpec | null {
  return HARNESS_SPECS.find((spec) => spec.id === id) ?? null;
}

export function isHarnessId(id: string): id is HarnessId {
  return HARNESS_SPECS.some((spec) => spec.id === id);
}

/**
 * Only supported harnesses may be executed. An unsupported harness is still
 * listed and probed so a surface can say "installed, not wired up yet" instead
 * of pretending it does not exist.
 */
export function isRunnableHarness(id: string): id is HarnessId {
  return HARNESS_SPECS.some((spec) => spec.id === id && spec.supported);
}

/**
 * The specs baked into the container image, in registry order. Deriving the
 * image from this rather than from a hand-written list means enabling a
 * harness cannot leave the image behind.
 */
export const SUPPORTED_HARNESS_SPECS: readonly HarnessSpec[] =
  HARNESS_SPECS.filter((spec) => spec.supported);

export const SUPPORTED_HARNESS_IDS: readonly HarnessId[] =
  SUPPORTED_HARNESS_SPECS.map((spec) => spec.id);

export const UNSUPPORTED_HARNESS_RUN_ERROR = Object.freeze({
  code: "harness_unsupported" as const,
  message: `Daytona agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
  retryable: false as const,
});

/**
 * Resolves the harness credential from an environment-like bag, honouring the
 * CLI's documented precedence. Returns null when nothing is configured, which
 * callers must treat as "not signed in" rather than as a transport failure.
 */
export function resolveHarnessAuth(
  spec: HarnessSpec,
  env: Record<string, string | undefined>
): { name: string; value: string } | null {
  for (const name of spec.authEnvVars) {
    const value = env[name];
    if (typeof value === "string" && value.trim()) {
      return { name, value };
    }
  }
  return null;
}

export function harnessAuthHint(spec: HarnessSpec): string {
  if (spec.id === "codex") {
    return "Codex CLI is not signed in. Supply its ChatGPT auth.json as the encrypted harness credential; the runner stages it in an isolated CODEX_HOME. Coven Agents never uses a model provider API key.";
  }
  const names = spec.authEnvVars.join(" or ");
  return `${spec.label} is not signed in. Provide ${names} to the runner as a secret, or run \`${spec.command} login\` where the session lives. Coven Agents never uses a model provider API key.`;
}

export function harnessStatus(
  spec: HarnessSpec,
  probe: { installed: boolean; version: string | null }
): HarnessStatus {
  let detail: string;
  if (!probe.installed) {
    detail = `\`${spec.command}\` was not found on PATH. Install \`${harnessInstallSpecifier(spec)}\`.`;
  } else if (spec.supported) {
    detail = "Installed and driven through its own CLI sign-in.";
  } else {
    detail =
      "Installed. Event translation for this harness is not implemented yet.";
  }
  return {
    detail,
    id: spec.id,
    installed: probe.installed,
    label: spec.label,
    streams: spec.streams,
    supported: spec.supported,
    version: probe.version,
  };
}
