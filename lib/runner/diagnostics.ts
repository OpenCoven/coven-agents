import "server-only";

import { randomUUID } from "node:crypto";
import { daytonaClient } from "./daytona/client";
import { daytonaSandboxConfiguration } from "./daytona/sandbox";
import { RunnerServiceError } from "./errors";
import type { RunnerDiagnosticResult } from "./service";

const DIAGNOSTIC_TIMEOUT_SECONDS = 60;
const DIAGNOSTIC_EXECUTION_TIMEOUT_SECONDS = 30;

export type RunnerDiagnosticSandbox = Readonly<{
  delete: () => Promise<void>;
  execute: () => Promise<Readonly<{ exitCode: number; result: string | null }>>;
}>;

export type EphemeralDiagnosticDependencies = Readonly<{
  create: () => Promise<RunnerDiagnosticSandbox>;
}>;

function retryableServiceError(
  code: RunnerServiceError["code"],
  message: string,
  cause: unknown
): RunnerServiceError {
  return new RunnerServiceError(code, message, true, { cause });
}

async function deleteDiagnosticSandbox(
  sandbox: RunnerDiagnosticSandbox
): Promise<void> {
  try {
    await sandbox.delete();
  } catch (error) {
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic cleanup is unavailable.",
      error
    );
  }
}

function safeDiagnosticExitCode(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 && value <= 255 ? value : 1;
}

export async function runEphemeralDiagnostic(
  dependencies: EphemeralDiagnosticDependencies
): Promise<RunnerDiagnosticResult> {
  let sandbox: RunnerDiagnosticSandbox | undefined;
  let result: RunnerDiagnosticResult | undefined;

  try {
    sandbox = await dependencies.create();
    const command = await sandbox.execute();
    const exitCode = safeDiagnosticExitCode(command.exitCode);
    const output = command.result === "coven-agents" ? "coven-agents" : "";
    result = {
      exitCode,
      ok: exitCode === 0 && output === "coven-agents",
      output,
    };
  } catch (error) {
    if (sandbox) {
      await deleteDiagnosticSandbox(sandbox);
    }
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable.",
      error
    );
  }

  if (!sandbox || !result) {
    throw new RunnerServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable."
    );
  }
  await deleteDiagnosticSandbox(sandbox);
  return result;
}

export async function diagnoseDaytonaSandbox(): Promise<RunnerDiagnosticResult> {
  try {
    const configuration = daytonaSandboxConfiguration();
    return await runEphemeralDiagnostic({
      create: async () => {
        const sandbox = await daytonaClient().create(
          {
            autoArchiveInterval: 0,
            autoStopInterval: 0,
            ephemeral: true,
            name: `coven-diagnostic-${randomUUID().replaceAll("-", "")}`,
            networkBlockAll: true,
            public: false,
            snapshot: configuration.snapshotName,
            ttlMinutes: 5,
          },
          { timeout: DIAGNOSTIC_TIMEOUT_SECONDS }
        );
        return {
          delete: () => sandbox.delete(DIAGNOSTIC_TIMEOUT_SECONDS, true),
          execute: async () => {
            const command = await sandbox.process.executeCommand(
              "printf coven-agents",
              undefined,
              undefined,
              DIAGNOSTIC_EXECUTION_TIMEOUT_SECONDS
            );
            return {
              exitCode: command.exitCode,
              result: command.result ?? null,
            };
          },
        };
      },
    });
  } catch (error) {
    if (error instanceof RunnerServiceError) {
      throw error;
    }
    throw retryableServiceError(
      "diagnostic_unavailable",
      "Daytona diagnostic is unavailable.",
      error
    );
  }
}
