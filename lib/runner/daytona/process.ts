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
import type { RunnerDaytonaAttemptId, RunnerDispatchAuthority } from "../types";
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
    | "durable_release_failed"
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
  sessionName: string,
  primary: DaytonaProcessError,
  releasePreparation: (
    attemptId: DaytonaAttemptId
  ) => Promise<RunnerDispatchAuthority | null>,
  attemptId: DaytonaAttemptId
): Promise<never> {
  const failures: unknown[] = [];
  try {
    await removeCredential(sandbox, credentialPath);
  } catch (error) {
    failures.push(error);
  }
  try {
    await removeSession(sandbox, sessionName);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new DaytonaProcessError(
      `Daytona ${primary.code} cleanup could not be confirmed; reset the sandbox before retrying.`,
      "sandbox_reset_required",
      true,
      { cause: primary }
    );
  }
  try {
    if (!(await releasePreparation(attemptId))) {
      throw new Error("Preparation release was rejected.");
    }
  } catch {
    // biome-ignore lint/style/useErrorCause: Release errors can contain durable-store details.
    throw new DaytonaProcessError(
      "Daytona cleanup succeeded but preparation release could not be confirmed.",
      "durable_release_failed",
      true,
      { cause: primary }
    );
  }
  throw primary;
}

export type DaytonaStartedProcess = Readonly<{
  attemptId: DaytonaAttemptId;
  commandId: string;
  credentialPath: string;
  dispatchAuthority: RunnerDispatchAuthority;
  sessionId: string;
  workspace: string;
}>;

/**
 * Opaque durable ownership of a single provider attempt. Only the durable
 * dispatch implementation may mint this branded value.
 */
export type DaytonaAttemptId = RunnerDaytonaAttemptId;

export type DaytonaPreparationAuthorization = Readonly<{
  runId: string;
}>;

/**
 * Durable pre-mutation gate supplied by the dispatch service.
 *
 * This must atomically verify the active dispatch lease/run and reserve
 * exclusive ownership of this run attempt's deterministic session and
 * credential path. It returns `null` when the run is cancelled, stale, or
 * displaced. It must never allow a second unresolved attempt for a run.
 */
export type DaytonaPreparationAuthorizer = (
  authorization: DaytonaPreparationAuthorization
) => Promise<DaytonaAttemptId | null>;

export type DaytonaLaunchAuthorization = Readonly<{
  commandId?: string;
  attemptId: DaytonaAttemptId;
  runId: string;
  sessionId: string;
}>;

/**
 * Durable launch gate supplied by the dispatch service.
 *
 * It must atomically verify that the supplied attempt remains current under
 * the active dispatch lease/run, reject cancelled or displaced attempts, and
 * persist the supplied provider identifiers without releasing the attempt.
 * Callers must durably record cancellation before invoking
 * `stopDaytonaProcess`; this adapter deliberately uses no process-local lock.
 * Daytona supplies the command ID only after execution is accepted, so this
 * gate is the final attachment immediately after that acceptance.
 */
export type DaytonaLaunchAuthorizer = (
  launch: DaytonaLaunchAuthorization
) => Promise<RunnerDispatchAuthority | null>;

export type DaytonaPreparationRelease = (
  release: Readonly<{
    attemptId: DaytonaAttemptId;
    runId: string;
  }>
) => Promise<RunnerDispatchAuthority | null>;

/**
 * Stages the tenant credential exactly once, creates a short-lived process
 * session, starts one non-echoing async command, then durably attaches the
 * accepted process. The credential is never included in command text,
 * returned data, authorization input, or error messages.
 */
export async function startDaytonaProcess(input: {
  authorizeLaunch: DaytonaLaunchAuthorizer;
  authorizePreparation: DaytonaPreparationAuthorizer;
  credential: HarnessCredential;
  instructions: string;
  model: string;
  releasePreparation: DaytonaPreparationRelease;
  runId: string;
  runtime: string;
  sandbox: DaytonaProcessSandbox;
  task: string;
  workspace?: string;
}): Promise<DaytonaStartedProcess> {
  const { auth, spec } = requireHarness(input.runtime, input.credential);
  const workspace = resolveSandboxWorkspace(input.workspace);
  const { process } = input.sandbox;

  if (typeof input.authorizePreparation !== "function") {
    throw new DaytonaProcessError(
      "Daytona preparation authorization is required before provider mutation.",
      "process_start_failed",
      false
    );
  }
  if (typeof input.releasePreparation !== "function") {
    throw new DaytonaProcessError(
      "Daytona preparation release is required before provider mutation.",
      "process_start_failed",
      false
    );
  }
  if (typeof input.authorizeLaunch !== "function") {
    throw new DaytonaProcessError(
      "Daytona launch authorization is required before provider mutation.",
      "process_start_failed",
      false
    );
  }
  let attemptId: DaytonaAttemptId | null;
  try {
    attemptId = await input.authorizePreparation({
      runId: input.runId,
    });
  } catch {
    // Authorization callbacks can cross a durable database boundary. Keep
    // their failure retryable, but never retain or expose their raw error.
    // biome-ignore lint/style/useErrorCause: Durable authorization errors can contain secret database details.
    throw new DaytonaProcessError(
      "Daytona preparation authorization could not be confirmed.",
      "process_start_failed",
      true
    );
  }
  if (!attemptId) {
    throw new DaytonaProcessError(
      "Daytona preparation authorization could not be confirmed.",
      "process_start_failed",
      false
    );
  }
  const sessionId = daytonaRunSessionName(input.runId, attemptId);
  const credentialPath = daytonaRunCredentialPath(input.runId, attemptId);

  try {
    // A deterministic session can survive an ambiguous earlier create. Its
    // absence must be confirmed before a new credential is ever written.
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
      ),
      (claim) =>
        input.releasePreparation({
          attemptId: claim,
          runId: input.runId,
        }),
      attemptId
    );
  }

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
      sessionId,
      error instanceof DaytonaProcessError
        ? error
        : providerError(
            "credential_stage_failed",
            "Daytona could not safely stage the harness credential.",
            error
          ),
      (claim) =>
        input.releasePreparation({
          attemptId: claim,
          runId: input.runId,
        }),
      attemptId
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
      ),
      (claim) =>
        input.releasePreparation({
          attemptId: claim,
          runId: input.runId,
        }),
      attemptId
    );
  }

  let commandId: string;
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
    commandId = response.cmdId;
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
          ),
      (claim) =>
        input.releasePreparation({
          attemptId: claim,
          runId: input.runId,
        }),
      attemptId
    );
  }

  let launchAuthority: RunnerDispatchAuthority | null;
  try {
    launchAuthority = await input.authorizeLaunch({
      attemptId,
      commandId,
      runId: input.runId,
      sessionId,
    });
  } catch {
    return await cleanupFailedStart(
      input.sandbox,
      credentialPath,
      sessionId,
      new DaytonaProcessError(
        "Daytona launch authorization could not be confirmed.",
        "process_start_failed",
        true
      ),
      (claim) =>
        input.releasePreparation({
          attemptId: claim,
          runId: input.runId,
        }),
      attemptId
    );
  }
  if (!launchAuthority) {
    return await cleanupFailedStart(
      input.sandbox,
      credentialPath,
      sessionId,
      new DaytonaProcessError(
        "Daytona launch authorization no longer permits attaching the process.",
        "process_start_failed",
        false
      ),
      (claim) =>
        input.releasePreparation({
          attemptId: claim,
          runId: input.runId,
        }),
      attemptId
    );
  }
  return {
    attemptId,
    commandId,
    credentialPath,
    dispatchAuthority: launchAuthority,
    sessionId,
    workspace,
  };
}

export type DaytonaLogSnapshot = Readonly<{
  cursor: number;
  events: readonly RunEvent[];
  exitCode: number | null;
  logsSettled: boolean;
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
  attemptId: DaytonaAttemptId;
  commandId: string;
  credential: string | null;
  cursor: number;
  harness: "copilot";
  now?: () => Date;
  sandbox: DaytonaProcessSandbox;
  runId: string;
}): Promise<DaytonaLogSnapshot> {
  const sessionId = daytonaRunSessionName(input.runId, input.attemptId);
  const normalizedCommand = normalizeDaytonaCommand(
    await input.sandbox.process.getSessionCommand(sessionId, input.commandId)
  );
  const terminal = isTerminalDaytonaCommand(normalizedCommand);
  const normalizedLogs = normalizeDaytonaLogs(
    await input.sandbox.process.getSessionCommandLogs(
      sessionId,
      input.commandId
    )
  );
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
  const { events } = parsed;
  const { events: authoritativeEvents } = authoritative;
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
    events,
    exitCode: result?.exitCode ?? normalizedCommand.exitCode,
    logsSettled: !parsed.pendingTail,
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

export type DaytonaStopInput = Readonly<{
  attemptId: DaytonaAttemptId;
  runId: string;
}>;

/**
 * `deleteSession` is the only session termination operation in SDK 0.207.
 * After confirmed absence, it removes and verifies the run's deterministic
 * credential path. A classified 404 or 410 confirms session absence but does
 * not skip credential cleanup. Callers must record cancellation durably before
 * calling this function so the launch authorizer rejects a concurrent start.
 * Sandbox deletion remains the caller's job.
 */
export async function stopDaytonaProcess(
  sandbox: DaytonaProcessSandbox,
  input: DaytonaStopInput
): Promise<DaytonaStopResult> {
  const sessionId = daytonaRunSessionName(input.runId, input.attemptId);
  let sessionAbsent = false;
  try {
    await sandbox.process.deleteSession(sessionId);
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      return {
        error: providerError(
          "sandbox_reset_required",
          "Daytona could not confirm process session termination; reset the sandbox.",
          error
        ),
        kind: "sandbox_reset_required",
      };
    }
    sessionAbsent = true;
  }

  if (!sessionAbsent) {
    try {
      const sessions = await sandbox.process.listSessions();
      if (sessions.some((session) => session.sessionId === sessionId)) {
        throw new Error("Daytona session remained after deletion.");
      }
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

  try {
    await removeCredential(
      sandbox,
      daytonaRunCredentialPath(input.runId, input.attemptId)
    );
    return { kind: "stopped" };
  } catch (error) {
    return {
      error: providerError(
        "sandbox_reset_required",
        "Daytona could not confirm deterministic credential removal; reset the sandbox.",
        error
      ),
      kind: "sandbox_reset_required",
    };
  }
}

/** Deletes only deterministic per-run paths after terminal or expired starts. */
export async function sweepDaytonaCredentials(
  sandbox: DaytonaProcessSandbox,
  attempts: readonly Readonly<{ attemptId: DaytonaAttemptId; runId: string }>[]
): Promise<void> {
  const paths = [
    ...new Set(
      attempts.map(({ attemptId, runId }) =>
        daytonaRunCredentialPath(runId, attemptId)
      )
    ),
  ];
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
