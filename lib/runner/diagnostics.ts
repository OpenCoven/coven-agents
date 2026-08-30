import "server-only";

import { performance } from "node:perf_hooks";
import {
  type CreateSandboxFromSnapshotParams,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaTimeoutError,
} from "@daytona/sdk";
import { daytonaClient } from "./daytona/client";
import {
  type DaytonaSandboxConfiguration,
  daytonaSandboxConfiguration,
} from "./daytona/sandbox";
import { RunnerServiceError } from "./errors";
import type { RunnerDiagnosticResult } from "./service";

const DIAGNOSTIC_DEADLINE_MILLISECONDS = 240_000;
const DIAGNOSTIC_CREATE_TIMEOUT_MILLISECONDS = 60_000;
const DIAGNOSTIC_DELETE_TIMEOUT_MILLISECONDS = 60_000;
const DIAGNOSTIC_EXECUTION_TIMEOUT_MILLISECONDS = 30_000;

export type RunnerDiagnosticSandbox = Readonly<{
  delete: (timeoutSeconds: number) => Promise<void>;
  execute: (
    timeoutSeconds: number
  ) => Promise<Readonly<{ exitCode: number; result: string | null }>>;
}>;

export type DiagnosticDeadlineDependencies = Readonly<{
  cancelTimeout?: (handle: unknown) => void;
  nowMilliseconds?: () => number;
  scheduleTimeout?: (
    callback: () => void,
    delayMilliseconds: number
  ) => unknown;
  timeoutMilliseconds?: number;
}>;

export type EphemeralDiagnosticDependencies = Readonly<{
  create: (timeoutSeconds: number) => Promise<RunnerDiagnosticSandbox>;
  deadline?: DiagnosticDeadlineDependencies;
  reportFailure?: (failure: RunnerDiagnosticFailure) => void;
}>;

export type RunnerDiagnosticFailure = Readonly<{
  category:
    | "authentication"
    | "authorization"
    | "conflict"
    | "not_found"
    | "provider_rejected"
    | "provider_unavailable"
    | "rate_limited"
    | "timeout"
    | "unknown";
  providerCode?: string;
  stage: "configuration" | "create" | "delete" | "execute";
  statusCode?: number;
}>;

type DaytonaDiagnosticSdkSandbox = Readonly<{
  delete: (timeout?: number, wait?: boolean) => Promise<void>;
  process: Readonly<{
    executeCommand: (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number
    ) => Promise<Readonly<{ exitCode: number; result?: string | null }>>;
  }>;
}>;

type DaytonaDiagnosticClient = Readonly<{
  create: (
    parameters: CreateSandboxFromSnapshotParams,
    options?: Readonly<{ timeout?: number }>
  ) => Promise<DaytonaDiagnosticSdkSandbox>;
}>;

export type DaytonaDiagnosticDependencies = Readonly<{
  client?: () => DaytonaDiagnosticClient;
  configuration?: () => Pick<DaytonaSandboxConfiguration, "snapshotName">;
  deadline?: DiagnosticDeadlineDependencies;
  reportFailure?: (failure: RunnerDiagnosticFailure) => void;
}>;

function retryableServiceError(
  code: RunnerServiceError["code"],
  message: string
): RunnerServiceError {
  return new RunnerServiceError(code, message);
}

class DiagnosticDeadlineExceededError extends Error {
  constructor() {
    super("Diagnostic deadline exceeded.");
    this.name = "DiagnosticDeadlineExceededError";
  }
}

class DiagnosticDeadline {
  readonly #cancelTimeout: (handle: unknown) => void;
  readonly #deadlineMilliseconds: number;
  readonly #nowMilliseconds: () => number;
  readonly #scheduleTimeout: (
    callback: () => void,
    delayMilliseconds: number
  ) => unknown;

  constructor(dependencies: DiagnosticDeadlineDependencies = {}) {
    this.#nowMilliseconds =
      dependencies.nowMilliseconds ?? (() => performance.now());
    this.#scheduleTimeout =
      dependencies.scheduleTimeout ??
      ((callback, delayMilliseconds) =>
        setTimeout(callback, delayMilliseconds));
    this.#cancelTimeout =
      dependencies.cancelTimeout ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.#deadlineMilliseconds =
      this.#nowMilliseconds() +
      (dependencies.timeoutMilliseconds ?? DIAGNOSTIC_DEADLINE_MILLISECONDS);
  }

  hasTimeRemaining(): boolean {
    return this.#remainingMilliseconds() > 0;
  }

  async run<T>(
    maximumAttemptMilliseconds: number,
    operation: (timeoutSeconds: number) => Promise<T>,
    onLateFulfillment?: (value: T) => void
  ): Promise<T> {
    const remainingMilliseconds = Math.min(
      maximumAttemptMilliseconds,
      this.#remainingMilliseconds()
    );
    if (remainingMilliseconds <= 0) {
      throw new DiagnosticDeadlineExceededError();
    }

    let timedOut = false;
    const observedOperationPromise = Promise.resolve()
      .then(() => operation(remainingMilliseconds / 1000))
      .then(
        (value) => {
          if (timedOut) {
            try {
              onLateFulfillment?.(value);
            } catch {
              // Late cleanup is best effort and must not affect the completed response.
            }
          }
          return value;
        },
        (error: unknown) => {
          throw error;
        }
      );

    let timeoutHandle: unknown;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.#scheduleTimeout(() => {
        timedOut = true;
        reject(new DiagnosticDeadlineExceededError());
      }, remainingMilliseconds);
    });

    try {
      return await Promise.race([observedOperationPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== undefined) {
        this.#cancelTimeout(timeoutHandle);
      }
    }
  }

  #remainingMilliseconds(): number {
    return Math.max(0, this.#deadlineMilliseconds - this.#nowMilliseconds());
  }
}

async function deleteLateDiagnosticSandbox(
  sandbox: RunnerDiagnosticSandbox,
  dependencies: DiagnosticDeadlineDependencies | undefined
): Promise<void> {
  const cleanupDeadline = new DiagnosticDeadline({
    ...dependencies,
    timeoutMilliseconds: DIAGNOSTIC_DELETE_TIMEOUT_MILLISECONDS,
  });
  try {
    await cleanupDeadline.run(
      DIAGNOSTIC_DELETE_TIMEOUT_MILLISECONDS,
      (timeout) => sandbox.delete(timeout)
    );
  } catch {
    // Provider cleanup details are intentionally swallowed.
  }
}

async function deleteDiagnosticSandbox(
  sandbox: RunnerDiagnosticSandbox,
  deadline: DiagnosticDeadline,
  reportFailure?: (failure: RunnerDiagnosticFailure) => void
): Promise<void> {
  try {
    await deadline.run(DIAGNOSTIC_DELETE_TIMEOUT_MILLISECONDS, (timeout) =>
      sandbox.delete(timeout)
    );
  } catch (error) {
    reportFailure?.(diagnosticFailure(error, "delete"));
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic cleanup is unavailable."
    );
  }
}

function diagnosticFailure(
  error: unknown,
  stage: RunnerDiagnosticFailure["stage"]
): RunnerDiagnosticFailure {
  if (error instanceof DiagnosticDeadlineExceededError) {
    return { category: "timeout", stage };
  }
  if (!(error instanceof DaytonaError)) {
    return { category: "unknown", stage };
  }
  const details = {
    ...(typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code)
      ? { providerCode: error.code }
      : {}),
    ...(Number.isSafeInteger(error.statusCode) &&
    (error.statusCode as number) >= 400 &&
    (error.statusCode as number) <= 599
      ? { statusCode: error.statusCode }
      : {}),
  };
  if (error instanceof DaytonaTimeoutError) {
    return { category: "timeout", stage, ...details };
  }
  if (error instanceof DaytonaConnectionError) {
    return { category: "provider_unavailable", stage, ...details };
  }
  switch (error.statusCode) {
    case 401:
      return { category: "authentication", stage, ...details };
    case 403:
      return { category: "authorization", stage, ...details };
    case 404:
      return { category: "not_found", stage, ...details };
    case 408:
    case 504:
      return { category: "timeout", stage, ...details };
    case 409:
      return { category: "conflict", stage, ...details };
    case 429:
      return { category: "rate_limited", stage, ...details };
    case 500:
    case 502:
    case 503:
      return { category: "provider_unavailable", stage, ...details };
    default:
      return { category: "provider_rejected", stage, ...details };
  }
}

function safeDiagnosticExitCode(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

export async function runEphemeralDiagnostic(
  dependencies: EphemeralDiagnosticDependencies
): Promise<RunnerDiagnosticResult> {
  const deadline = new DiagnosticDeadline(dependencies.deadline);
  let sandbox: RunnerDiagnosticSandbox | undefined;
  let result: RunnerDiagnosticResult | undefined;
  let stage: RunnerDiagnosticFailure["stage"] = "create";

  try {
    const createdSandbox = await deadline.run(
      DIAGNOSTIC_CREATE_TIMEOUT_MILLISECONDS,
      dependencies.create,
      (lateSandbox) => {
        deleteLateDiagnosticSandbox(lateSandbox, dependencies.deadline).catch(
          () => undefined
        );
      }
    );
    sandbox = createdSandbox;
    stage = "execute";
    const command = await deadline.run(
      DIAGNOSTIC_EXECUTION_TIMEOUT_MILLISECONDS,
      (timeout) => createdSandbox.execute(timeout)
    );
    const exitCode = safeDiagnosticExitCode(command.exitCode);
    const output = command.result === "coven-agents" ? "coven-agents" : "";
    result = {
      exitCode,
      ok: exitCode === 0 && output === "coven-agents",
      output,
    };
  } catch (error) {
    dependencies.reportFailure?.(diagnosticFailure(error, stage));
    if (sandbox && deadline.hasTimeRemaining()) {
      await deleteDiagnosticSandbox(
        sandbox,
        deadline,
        dependencies.reportFailure
      );
    }
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable."
    );
  }

  if (!sandbox || !result) {
    throw new RunnerServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable."
    );
  }
  await deleteDiagnosticSandbox(sandbox, deadline, dependencies.reportFailure);
  return result;
}

export async function diagnoseDaytonaSandbox(
  name: string,
  dependencies: DaytonaDiagnosticDependencies = {}
): Promise<RunnerDiagnosticResult> {
  let configuration: Pick<DaytonaSandboxConfiguration, "snapshotName">;
  let client: DaytonaDiagnosticClient;
  try {
    configuration =
      dependencies.configuration?.() ?? daytonaSandboxConfiguration();
    client = dependencies.client?.() ?? daytonaClient();
  } catch (error) {
    dependencies.reportFailure?.(diagnosticFailure(error, "configuration"));
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable."
    );
  }
  return await runEphemeralDiagnostic({
    create: async (timeoutSeconds) => {
      const sandbox = await client.create(
        {
          ephemeral: true,
          name,
          networkBlockAll: true,
          public: false,
          snapshot: configuration.snapshotName,
          ttlMinutes: 5,
        },
        { timeout: timeoutSeconds }
      );
      return {
        delete: (deleteTimeoutSeconds) =>
          sandbox.delete(deleteTimeoutSeconds, true),
        execute: async (executeTimeoutSeconds) => {
          const command = await sandbox.process.executeCommand(
            "printf coven-agents",
            undefined,
            undefined,
            executeTimeoutSeconds
          );
          return {
            exitCode: command.exitCode,
            result: command.result ?? null,
          };
        },
      };
    },
    deadline: dependencies.deadline,
    reportFailure: dependencies.reportFailure,
  });
}
