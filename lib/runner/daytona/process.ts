import "server-only";

import { sanitizeEvidenceText } from "@opencoven/agent-contracts";
import {
  buildHarnessCommand,
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
 * These shapes are the relevant SDK 0.207 toolbox process API responses.
 * They are declared structurally because the SDK does not re-export its
 * generated `Command` and `Session` model types from its package entrypoint.
 */
type DaytonaCommand = Readonly<{
  command: string;
  exitCode?: number;
  id: string;
}>;
type DaytonaSession = Readonly<{
  commands: readonly DaytonaCommand[];
  sessionId: string;
}>;
type DaytonaSessionCommandLogs = Readonly<{
  output: string;
  stderr: string;
  stdout: string;
}>;
type DaytonaSessionExecute = Readonly<{
  cmdId: string;
  exitCode?: number;
  output?: string;
  stderr?: string;
  stdout?: string;
}>;

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
  return [
    "set -eu",
    `${authName}="$(cat -- ${shellQuote(credentialPath)})"`,
    `export ${authName}`,
    `rm -f -- ${shellQuote(credentialPath)}`,
    "unset ANTHROPIC_API_KEY OPENAI_API_KEY AZURE_OPENAI_API_KEY GOOGLE_API_KEY",
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
      await sandbox.process.deleteSession(sessionName);
      const sessions = await sandbox.process.listSessions();
      if (sessions.some((session) => session.sessionId === sessionName)) {
        throw new Error("Daytona session remained after deletion.");
      }
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
      true
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

  let createdSession = false;
  try {
    await process.createSession(sessionId);
    createdSession = true;
  } catch (error) {
    return await cleanupFailedStart(
      input.sandbox,
      credentialPath,
      null,
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
      createdSession ? sessionId : null,
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
  const terminal = command.exitCode !== undefined;
  const parsed = parseHarnessLog(
    input.harness,
    logs.stdout,
    input.cursor,
    terminal,
    input.credential,
    (input.now?.() ?? new Date()).toISOString()
  );
  const events = [...parsed.events, ...parsed.diagnostics];
  const result = events.find(
    (event): event is Extract<RunEvent, { kind: "finished" }> =>
      event.kind === "finished"
  );
  const summary = summarizeRun(events);
  const status = result
    ? result.status
    : terminal && command.exitCode === 0
      ? "completed"
      : terminal
        ? "failed"
        : "running";
  return {
    cursor: parsed.cursor,
    diagnostics: parsed.diagnostics,
    events,
    exitCode: result?.exitCode ?? command.exitCode ?? null,
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
 * confirmation exposed by that API. Sandbox deletion remains the caller's job.
 */
export async function stopDaytonaProcess(
  sandbox: DaytonaProcessSandbox,
  sessionId: string
): Promise<DaytonaStopResult> {
  try {
    await sandbox.process.deleteSession(sessionId);
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
