import type { HarnessId, HarnessStatus } from "./schema";

export interface HarnessSpec {
  /**
   * Environment variables the harness reads for headless auth, in the CLI's own
   * documented precedence order. These are harness credentials, never model
   * provider API keys.
   */
  readonly authEnvVars: readonly string[];
  /** Executable name, resolved from PATH. */
  readonly command: string;
  readonly id: HarnessId;
  /** npm package that provides `command`, used to build the container image. */
  readonly installPackage: string;
  readonly label: string;
  /**
   * Model ids the pinned CLI accepts for `--model`, with `auto` first.
   *
   * `auto` means no flag is passed and the harness chooses. The rest are
   * passed through verbatim, so this list must mirror what the pinned CLI
   * version actually accepts — it is maintained alongside the Daytona
   * snapshot definition, and a stale entry fails a run at the harness rather
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
    label: "GitHub Copilot CLI",
    models: ["auto", "claude-sonnet-4.5", "gpt-5", "gpt-5-mini"],
    streams: true,
    supported: true,
    versionArgs: ["--version"],
  },
  {
    authEnvVars: ["CODEX_API_KEY"],
    command: "codex",
    id: "codex",
    installPackage: "@openai/codex",
    label: "Codex CLI",
    models: ["auto"],
    streams: false,
    supported: false,
    versionArgs: ["--version"],
  },
  {
    authEnvVars: ["CLAUDE_CODE_OAUTH_TOKEN"],
    command: "claude",
    id: "claude",
    installPackage: "@anthropic-ai/claude-code",
    label: "Claude Code",
    models: ["auto"],
    streams: false,
    supported: false,
    versionArgs: ["--version"],
  },
];

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

export const SUPPORTED_HARNESS_IDS: readonly HarnessId[] = HARNESS_SPECS.filter(
  (spec) => spec.supported
).map((spec) => spec.id);

export const UNSUPPORTED_HARNESS_RUN_ERROR = Object.freeze({
  code: "harness_unsupported" as const,
  message: `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
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
  const names = spec.authEnvVars.join(" or ");
  return `${spec.label} is not signed in. Provide ${names} to the runner as a secret, or run \`${spec.command} login\` where the session lives. Coven Agents never uses a model provider API key.`;
}

export function harnessStatus(
  spec: HarnessSpec,
  probe: { installed: boolean; version: string | null }
): HarnessStatus {
  let detail: string;
  if (!probe.installed) {
    detail = `\`${spec.command}\` was not found on PATH. Install \`${spec.installPackage}\`.`;
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
