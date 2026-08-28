import "server-only";

import type {
  Sandbox,
  SessionCommandLogsResponse,
  SessionExecuteResponse,
} from "@daytona/sdk";
import { sanitizeEvidenceText } from "@opencoven/agent-contracts";
import {
  buildHarnessCommand,
  HARNESS_SPECS,
  type HarnessCredential,
  type HarnessStatus,
  harnessesFromProbe,
  parseHarnessLog,
  type RunEvent,
  type RunSummary,
  requireHarness,
  resolveSandboxWorkspace,
  shellQuote,
  summarizeRun,
} from "../harness";
import { daytonaRunCredentialPath, daytonaRunSessionName } from "./names";
import { classifyDaytonaProviderError } from "./sandbox";

const STAGING_TIMEOUT_SECONDS = 15;

/**
 * Daytona's command model has no lifecycle status in SDK 0.207, but it can
 * arrive from newer toolbox deployments. Treating it as optional keeps the
 * process boundary compatible with both forms.
 */
type DaytonaCommand = Readonly<{
  exitCode?: number;
  status?: string;
}>;
type DaytonaSession = Awaited<
  ReturnType<Sandbox["process"]["listSessions"]>
>[number];
type DaytonaSessionCommandLogs = SessionCommandLogsResponse;
type DaytonaSessionExecute = SessionExecuteResponse;

export type DaytonaProcessService = Readonly<{
  createSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  executeCommand: (
    command: string,
    cwd?: string,
    env?: Record<string, string>,
    timeout?: number
  ) => Promise<{ exitCode: number; result?: string }>;
  executeSessionCommand: (
    sessionId: string,
    request: Readonly<{
      command: string;
      runAsync: true;
      suppressInputEcho: true;
    }>
  ) => Promise<DaytonaSessionExecute>;
  getSessionCommand: (
    sessionId: string,
    commandId: string
  ) => Promise<DaytonaCommand>;
  getSessionCommandLogs: (
    sessionId: string,
    commandId: string
  ) => Promise<DaytonaSessionCommandLogs>;
  listSessions: () => Promise<readonly DaytonaSession[]>;
}>;

export type DaytonaProcessSandbox = Readonly<{
  process: DaytonaProcessService;
}>;

export class DaytonaProcessError extends Error {
  readonly code:
    | "credential_cleanup_failed"
    | "credential_stage_failed"
    | "harness_missing"
    | "process_start_failed"
    | "sandbox_reset_required"
    | "session_create_failed";
  readonly retryable: boolean;

  constructor(
    message: string,
    code: DaytonaProcessError["code"],
    retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.code = code;
    this.retryable = retryable;
    this.name = "DaytonaProcessError";
  }
}

function providerError(
  code: DaytonaProcessError["code"],
  message: string,
  error: unknown
): DaytonaProcessError {
  return new DaytonaProcessError(
    message,
    code,
    classifyDaytonaProviderError(error) === "retryable"
  );
}

function cleanupCommand(path: string): string {
  return `rm -f -- ${shellQuote(path)} && test ! -e ${shellQuote(path)}`;
}

function stagingCommand(authName: string, path: string): string {
  return [
    "umask 077",
    `printf '%s' "$${authName}" > ${shellQuote(path)}`,
    `chmod 600 ${shellQuote(path)}`,
    `[ "$(stat -c '%a' ${shellQuote(path)} 2>/dev/null || stat -f '%Lp' ${shellQuote(path)})" = 600 ]`,
  ].join(" && ");
}

function asyncCommand(
  authName: string,
  credentialPath: string,
  workspace: string,
  harnessCommand: string
): string {
  const providerCredentialVariables = [
    "ANTHROPIC_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
  ];
  const credentialVariables = [
    ...new Set([
      ...HARNESS_SPECS.flatMap((spec) => spec.authEnvVars),
      ...providerCredentialVariables,
    ]),
  ].filter((name) => name !== authName);
  return [
    "set -eu",
    `${authName}="$(cat -- ${shellQuote(credentialPath)})"`,
    `export ${authName}`,
    `rm -f -- ${shellQuote(credentialPath)}`,
    `unset ${credentialVariables.join(" ")}`,
    "export CI=true",
    `export HOME=${shellQuote(workspace)}`,
    `mkdir -p -- ${shellQuote(workspace)}`,
    `cd -- ${shellQuote(workspace)}`,
    `exec ${harnessCommand}`,
  ].join("; ");
}

async function removeCredential(
  sandbox: DaytonaProcessSandbox,
  path: string
): Promise<void> {
  const result = await sandbox.process.executeCommand(
    cleanupCommand(path),
    undefined,
    undefined,
    STAGING_TIMEOUT_SECONDS
  );
  if (result.exitCode !== 0) {
    throw new Error("Credential removal command failed.");
  }
}

/**
 * A rejected create call may still have reached Daytona. Delete by the
 * deterministic ID even when its first lookup missed it, then verify absence
 * so a retry cannot attach to a session left by that ambiguous request.
 */
async function removeSession(
  sandbox: DaytonaProcessSandbox,
  sessionId: string
): Promise<void> {
  // The first lookup provides a bounded view of a session a rejected create
  // may have left behind. A failed lookup must not skip the deterministic
  // delete; a successful empty lookup does not need one.
  let lookupFailed = false;
  let exists = false;
  try {
    const sessions = await sandbox.process.listSessions();
    exists = sessions.some((session) => session.sessionId === sessionId);
  } catch {
    lookupFailed = true;
  }
  if (exists || lookupFailed) {
    try {
      await sandbox.process.deleteSession(sessionId);
    } catch (error) {
      if (classifyDaytonaProviderError(error) !== "not_found") {
        throw error;
      }
    }
  }
  const remaining = await sandbox.process.listSessions();
  if (remaining.some((session) => session.sessionId === sessionId)) {
    throw new Error("Daytona session remained after deletion.");
  }
}

async function cleanupFailedStart(
  sandbox: DaytonaProcessSandbox,
  credentialPath: string,
  sessionName: string | null,
  primary: unknown
): Promise<never> {
  const failures: unknown[] = [];
  try {
    await removeCredential(sandbox, credentialPath);
  } catch (error) {
    failures.push(error);
  }
  if (sessionName) {
    try {
      await removeSession(sandbox, sessionName);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const primaryCode =
      primary instanceof DaytonaProcessError ? primary.code : "start_failed";
    throw new DaytonaProcessError(
      `Daytona ${primaryCode} and credential/process cleanup could not be confirmed.`,
      "credential_cleanup_failed",
      true,
      { cause: primary }
    );
  }
  throw primary;
}

export type DaytonaStartedProcess = Readonly<{
  commandId: string;
  credentialPath: string;
  sessionId: string;
  workspace: string;
}>;

/**
 * Stages the tenant credential exactly once, creates a short-lived process
 * session, then starts one non-echoing async command. The credential is never
 * included in command text, returned data, or error messages.
 */
export async function startDaytonaProcess(input: {
  credential: HarnessCredential;
  instructions: string;
  model: string;
  runId: string;
  runtime: string;
  sandbox: DaytonaProcessSandbox;
  task: string;
  workspace?: string;
}): Promise<DaytonaStartedProcess> {
  const { auth, spec } = requireHarness(input.runtime, input.credential);
  const workspace = resolveSandboxWorkspace(input.workspace);
  const sessionId = daytonaRunSessionName(input.runId);
  const credentialPath = daytonaRunCredentialPath(input.runId);
  const { process } = input.sandbox;

  try {
    const staged = await process.executeCommand(
      stagingCommand(auth.name, credentialPath),
      undefined,
      { [auth.name]: auth.value },
      STAGING_TIMEOUT_SECONDS
    );
    if (staged.exitCode !== 0) {
      throw new DaytonaProcessError(
        "Daytona could not safely stage the harness credential.",
        "credential_stage_failed",
        false
      );
    }
  } catch (error) {
    return await cleanupFailedStart(
      input.sandbox,
      credentialPath,
      null,
      error instanceof DaytonaProcessError
        ? error
        : providerError(
            "credential_stage_failed",
            "Daytona could not safely stage the harness credential.",
            error
          )
    );
  }

  try {
    await removeSession(input.sandbox, sessionId);
  } catch (error) {
    return await cleanupFailedStart(
      input.sandbox,
      credentialPath,
      sessionId,
      providerError(
        "session_create_failed",
        "Daytona could not prepare the run process session.",
        error
      )
    );
  }

  try {
    await process.createSession(sessionId);
  } catch (error) {
    return await cleanupFailedStart(
      input.sandbox,
      credentialPath,
      sessionId,
      providerError(
        "session_create_failed",
        "Daytona could not create the run process session.",
        error
      )
    );
  }

  try {
    const response = await process.executeSessionCommand(sessionId, {
      command: asyncCommand(
        auth.name,
        credentialPath,
        workspace,
        buildHarnessCommand({
          harness: spec.id,
          instructions: input.instructions,
          model: input.model,
          task: input.task,
          workspace,
        })
      ),
      runAsync: true,
      suppressInputEcho: true,
    });
    if (!response.cmdId) {
      throw new DaytonaProcessError(
        "Daytona did not accept the asynchronous harness command.",
        "process_start_failed",
        true
      );
    }
    return { commandId: response.cmdId, credentialPath, sessionId, workspace };
  } catch (error) {
    return await cleanupFailedStart(
      input.sandbox,
      credentialPath,
      sessionId,
      error instanceof DaytonaProcessError
        ? error
        : providerError(
            "process_start_failed",
            "Daytona could not start the asynchronous harness command.",
            error
          )
    );
  }
}

export type DaytonaLogSnapshot = Readonly<{
  cursor: number;
  diagnostics: readonly RunEvent[];
  events: readonly RunEvent[];
  exitCode: number | null;
  status: "running" | "completed" | "failed";
  summary: RunSummary;
}>;

function normalizeDaytonaLogs(
  logs: DaytonaSessionCommandLogs
): Readonly<{ output: string; stderr: string; stdout: string }> {
  return {
    output: typeof logs.output === "string" ? logs.output : "",
    stderr: typeof logs.stderr === "string" ? logs.stderr : "",
    stdout: typeof logs.stdout === "string" ? logs.stdout : "",
  };
}

function normalizeDaytonaCommand(command: DaytonaCommand): Readonly<{
  exitCode: number | null;
  status: string | null;
}> {
  return {
    exitCode:
      typeof command.exitCode === "number" &&
      Number.isSafeInteger(command.exitCode)
        ? command.exitCode
        : null,
    status: typeof command.status === "string" ? command.status : null,
  };
}

function isTerminalDaytonaCommand(
  command: Readonly<{ exitCode: number | null; status: string | null }>
): boolean {
  return (
    command.exitCode !== null ||
    command.status === "completed" ||
    command.status === "failed" ||
    command.status === "error" ||
    command.status === "killed"
  );
}

/**
 * Reads the SDK's accumulated stdout snapshot. Daytona exposes no command
 * lifecycle enum: `exitCode` being present is the strongest terminal signal
 * supplied by its 0.207 process API.
 */
export async function snapshotDaytonaProcess(input: {
  commandId: string;
  credential: string | null;
  cursor: number;
  harness: "copilot";
  now?: () => Date;
  sandbox: DaytonaProcessSandbox;
  sessionId: string;
}): Promise<DaytonaLogSnapshot> {
  const [logs, command] = await Promise.all([
    input.sandbox.process.getSessionCommandLogs(
      input.sessionId,
      input.commandId
    ),
    input.sandbox.process.getSessionCommand(input.sessionId, input.commandId),
  ]);
  const normalizedLogs = normalizeDaytonaLogs(logs);
  const normalizedCommand = normalizeDaytonaCommand(command);
  const terminal = isTerminalDaytonaCommand(normalizedCommand);
  const parsed = parseHarnessLog(
    input.harness,
    normalizedLogs.stdout,
    input.cursor,
    terminal,
    input.credential,
    (input.now?.() ?? new Date()).toISOString()
  );
  // Daytona returns cumulative logs. Parse the complete sanitized transcript
  // independently of the delivery cursor so terminal state and summary stay
  // authoritative on later polls without replaying events to the caller.
  const authoritative = parseHarnessLog(
    input.harness,
    normalizedLogs.stdout,
    0,
    terminal,
    input.credential,
    (input.now?.() ?? new Date()).toISOString()
  );
  const events = [...parsed.events, ...parsed.diagnostics];
  const authoritativeEvents = [
    ...authoritative.events,
    ...authoritative.diagnostics,
  ];
  const result = authoritativeEvents.find(
    (event): event is Extract<RunEvent, { kind: "finished" }> =>
      event.kind === "finished"
  );
  const summary = summarizeRun(authoritativeEvents);
  const status = result
    ? result.status
    : normalizedCommand.status === "completed" ||
        (terminal && normalizedCommand.exitCode === 0)
      ? "completed"
      : terminal
        ? "failed"
        : "running";
  return {
    cursor: parsed.cursor,
    diagnostics: parsed.diagnostics,
    events,
    exitCode: result?.exitCode ?? normalizedCommand.exitCode,
    status,
    summary: {
      ...summary,
      status: status === "running" ? summary.status : status,
    },
  };
}

export type DaytonaStopResult =
  | Readonly<{ kind: "stopped" }>
  | Readonly<{
      error: DaytonaProcessError;
      kind: "sandbox_reset_required";
    }>;

/**
 * `deleteSession` is the only session termination operation in SDK 0.207.
 * We immediately verify absence with `listSessions`, the strongest bounded
 * confirmation exposed by that API. A classified 404 or 410 from
 * `deleteSession` also confirms the deterministic session is absent. Sandbox
 * deletion remains the caller's job.
 */
export async function stopDaytonaProcess(
  sandbox: DaytonaProcessSandbox,
  sessionId: string
): Promise<DaytonaStopResult> {
  try {
    await sandbox.process.deleteSession(sessionId);
  } catch (error) {
    if (classifyDaytonaProviderError(error) === "not_found") {
      return { kind: "stopped" };
    }
    return {
      error: providerError(
        "sandbox_reset_required",
        "Daytona could not confirm process session termination; reset the sandbox.",
        error
      ),
      kind: "sandbox_reset_required",
    };
  }

  try {
    const sessions = await sandbox.process.listSessions();
    if (sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error("Daytona session remained after deletion.");
    }
    return { kind: "stopped" };
  } catch (error) {
    return {
      error: providerError(
        "sandbox_reset_required",
        "Daytona could not confirm process session termination; reset the sandbox.",
        error
      ),
      kind: "sandbox_reset_required",
    };
  }
}

/** Deletes only deterministic per-run paths after terminal or expired starts. */
export async function sweepDaytonaCredentials(
  sandbox: DaytonaProcessSandbox,
  runIds: readonly string[]
): Promise<void> {
  const paths = [...new Set(runIds)].map(daytonaRunCredentialPath);
  if (paths.length === 0) {
    return;
  }
  const command = `${paths.map((path) => `rm -f -- ${shellQuote(path)}`).join("; ")}; test ${paths.map((path) => `! -e ${shellQuote(path)}`).join(" -a ")}`;
  const result = await sandbox.process.executeCommand(
    command,
    undefined,
    undefined,
    STAGING_TIMEOUT_SECONDS
  );
  if (result.exitCode !== 0) {
    throw new DaytonaProcessError(
      "Daytona could not confirm stale credential-file removal.",
      "credential_cleanup_failed",
      true
    );
  }
}

export function probeDaytonaHarnesses(
  sandbox: DaytonaProcessSandbox
): Promise<HarnessStatus[]> {
  return harnessesFromProbe(async (spec) => {
    try {
      const result = await sandbox.process.executeCommand(
        [spec.command, ...spec.versionArgs].map(shellQuote).join(" "),
        undefined,
        undefined,
        STAGING_TIMEOUT_SECONDS
      );
      return {
        installed: result.exitCode === 0,
        version:
          result.exitCode === 0
            ? result.result?.trim().split("\n")[0]?.trim() || null
            : null,
      };
    } catch {
      return { installed: false, version: null };
    }
  });
}

/** A final defensive check for error payloads that cross this module boundary. */
export function sanitizeDaytonaProcessMessage(
  message: string,
  credential: string | null
): string {
  return sanitizeEvidenceText(message, credential ? [credential] : []);
}
