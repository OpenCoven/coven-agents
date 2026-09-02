import "server-only";

import {
  acquireRunnerCredential,
  type RunnerCredentialAcquireInput,
  type RunnerCredentialAcquireResult,
  type RunnerCredentialDependencies,
} from "@/lib/credentials/runner-credential";
import type { RunnerDispatchDependencies } from "../admission";
import {
  HOSTED_EXECUTION_CAPABILITY_CONTRACT_VERSION,
  type RunnerExecutionProvenance,
} from "../execution-provenance";
import type { RunnerExecutionContext, RunnerExecutor } from "../executor";
import type { RunnerStore } from "../store";
import type { RunnerDispatchAuthority, RunnerOperator } from "../types";
import {
  DaytonaProcessError,
  type DaytonaProcessSandbox,
  inspectRestrictedWorkspace,
  startDaytonaProcess,
} from "./process";
import {
  type DaytonaSandboxConfiguration,
  type DaytonaSandboxDependencies,
  DaytonaSandboxLifecycleError,
  ensureDaytonaSandboxForDispatch,
} from "./sandbox";

type DaytonaExecutorOperations = Readonly<{
  executionProvenance: RunnerExecutionProvenance;
  ensureContext: (authority: RunnerDispatchAuthority) => Promise<{
    agent: Awaited<ReturnType<typeof ensureDaytonaSandboxForDispatch>>["agent"];
    sandbox: DaytonaProcessSandbox;
  }>;
  inspectWorkspace: typeof inspectRestrictedWorkspace;
  startProcess: typeof startDaytonaProcess;
}>;

export const DAYTONA_EXECUTOR_ADAPTER_VERSION = "daytona-adapter-v1";

export function daytonaExecutionProvenance(
  configuration: DaytonaSandboxConfiguration
): RunnerExecutionProvenance {
  return Object.freeze({
    adapterVersion: DAYTONA_EXECUTOR_ADAPTER_VERSION,
    capabilityContractVersion: HOSTED_EXECUTION_CAPABILITY_CONTRACT_VERSION,
    lifecycle: "persistent",
    pinnedSnapshot: configuration.snapshotName,
    productExecutionClass: "hosted",
    provider: "daytona",
    target: configuration.target,
  });
}

function runnerExecutionContext(
  sandbox: DaytonaProcessSandbox
): RunnerExecutionContext {
  return sandbox as unknown as RunnerExecutionContext;
}

function daytonaProcessSandbox(
  context: RunnerExecutionContext
): DaytonaProcessSandbox {
  return context as unknown as DaytonaProcessSandbox;
}

/**
 * Provider adapter with the only opaque context conversions. It preserves the
 * existing Daytona process lifecycle while presenting a neutral executor to
 * admission.
 */
export function daytonaRunnerExecutor(
  operations: DaytonaExecutorOperations
): RunnerExecutor {
  return {
    ensureExecutionContext: async (authority) => {
      const ensured = await operations.ensureContext(authority);
      return {
        agent: ensured.agent,
        context: runnerExecutionContext(ensured.sandbox),
      };
    },
    executionProvenance: operations.executionProvenance,
    inspectWorkspaceSafety: (context, workspace) =>
      operations.inspectWorkspace(daytonaProcessSandbox(context), workspace),
    isCleanupPending: (error) =>
      (error instanceof DaytonaProcessError &&
        (error.code === "durable_release_failed" ||
          error.code === "sandbox_reset_required")) ||
      (error instanceof DaytonaSandboxLifecycleError &&
        error.kind === "cleanup_needed"),
    start: async (input) => {
      const started = await operations.startProcess({
        ...input.authorizers,
        credential: input.credential,
        deleteAttemptRedaction: input.deleteAttemptRedaction,
        executionPermission: input.executionPermission,
        ...(input.githubTool ? { githubTool: input.githubTool } : {}),
        instructions: input.instructions,
        model: input.model,
        persistAttemptRedaction: input.persistAttemptRedaction,
        releasePreparation: input.authorizers.releasePreparation,
        runId: input.runId,
        runtime: input.runtime,
        sandbox: daytonaProcessSandbox(input.context),
        task: input.task,
        workspace: input.workspace,
      });
      return { dispatchAuthority: started.dispatchAuthority };
    },
  };
}

export type DaytonaRunnerExecutorConfiguration = Readonly<{
  operator: RunnerOperator;
  sandboxConfiguration: DaytonaSandboxConfiguration;
  sandboxDependencies: Omit<DaytonaSandboxDependencies, "store">;
  store: RunnerStore;
}>;

export function configuredDaytonaRunnerExecutor(
  configuration: DaytonaRunnerExecutorConfiguration
): RunnerExecutor {
  return daytonaRunnerExecutor({
    ensureContext: async (authority) => {
      const ensured = await ensureDaytonaSandboxForDispatch(
        configuration.operator,
        authority,
        configuration.sandboxConfiguration,
        { ...configuration.sandboxDependencies, store: configuration.store }
      );
      return {
        agent: ensured.agent,
        sandbox: ensured.sandbox as DaytonaProcessSandbox,
      };
    },
    executionProvenance: daytonaExecutionProvenance(
      configuration.sandboxConfiguration
    ),
    inspectWorkspace: inspectRestrictedWorkspace,
    startProcess: startDaytonaProcess,
  });
}

export type DaytonaRunnerDispatchDependencies = Omit<
  RunnerDispatchDependencies,
  "acquireCredential" | "executor" | "store"
> &
  Readonly<{
    credentialDependencies: RunnerCredentialDependencies;
    sandboxConfiguration: DaytonaSandboxConfiguration;
    sandboxDependencies: Omit<DaytonaSandboxDependencies, "store">;
    store: RunnerStore;
  }>;

/** Composes Daytona execution and runner credential dependencies for dispatch. */
export function daytonaRunnerDispatchDependencies(
  dependencies: DaytonaRunnerDispatchDependencies
): RunnerDispatchDependencies {
  return {
    ...dependencies,
    acquireCredential: (
      input: RunnerCredentialAcquireInput
    ): Promise<RunnerCredentialAcquireResult> =>
      acquireRunnerCredential(input, dependencies.credentialDependencies),
    executor: configuredDaytonaRunnerExecutor(dependencies),
  };
}
