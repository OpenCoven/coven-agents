import "server-only";

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { CreateSandboxFromSnapshotParams } from "@daytona/sdk";
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
  createName?: () => string;
  deadline?: DiagnosticDeadlineDependencies;
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
    operation: (timeoutSeconds: number) => Promise<T>
  ): Promise<T> {
    const remainingMilliseconds = Math.min(
      maximumAttemptMilliseconds,
      this.#remainingMilliseconds()
    );
    if (remainingMilliseconds <= 0) {
      throw new DiagnosticDeadlineExceededError();
    }

    const operationPromise = Promise.resolve().then(() =>
      operation(remainingMilliseconds / 1000)
    );
    const observedOperationPromise = operationPromise.catch(
      (error: unknown) => {
        throw error;
      }
    );

    let timeoutHandle: unknown;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutHandle = this.#scheduleTimeout(
        () => reject(new DiagnosticDeadlineExceededError()),
        remainingMilliseconds
      );
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

async function deleteDiagnosticSandbox(
  sandbox: RunnerDiagnosticSandbox,
  deadline: DiagnosticDeadline
): Promise<void> {
  try {
    await deadline.run(DIAGNOSTIC_DELETE_TIMEOUT_MILLISECONDS, (timeout) =>
      sandbox.delete(timeout)
    );
  } catch {
    // biome-ignore lint/style/useErrorCause: Provider failures can contain credentials or identifiers.
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic cleanup is unavailable."
    );
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

  try {
    const createdSandbox = await deadline.run(
      DIAGNOSTIC_CREATE_TIMEOUT_MILLISECONDS,
      dependencies.create
    );
    sandbox = createdSandbox;
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
  } catch {
    if (sandbox && deadline.hasTimeRemaining()) {
      await deleteDiagnosticSandbox(sandbox, deadline);
    }
    // biome-ignore lint/style/useErrorCause: Provider failures can contain credentials or identifiers.
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
  await deleteDiagnosticSandbox(sandbox, deadline);
  return result;
}

export async function diagnoseDaytonaSandbox(
  dependencies: DaytonaDiagnosticDependencies = {}
): Promise<RunnerDiagnosticResult> {
  try {
    const configuration =
      dependencies.configuration?.() ?? daytonaSandboxConfiguration();
    const client = dependencies.client?.() ?? daytonaClient();
    const name =
      dependencies.createName?.() ??
      `coven-diagnostic-${randomUUID().replaceAll("-", "")}`;
    return await runEphemeralDiagnostic({
      create: async (timeoutSeconds) => {
        const sandbox = await client.create(
          {
            autoArchiveInterval: 0,
            autoDeleteInterval: 0,
            autoStopInterval: 0,
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
    });
  } catch (error) {
    if (error instanceof RunnerServiceError) {
      throw error;
    }
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable."
    );
  }
}
