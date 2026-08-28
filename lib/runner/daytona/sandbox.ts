import "server-only";

import {
  type CreateSandboxFromSnapshotParams,
  DaytonaBadGatewayError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaGoneError,
  DaytonaInternalServerError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
import type { RunnerStore } from "../store";
import type { RunnerAgentRecord, RunnerPrincipal } from "../types";
import { daytonaSnapshotConfiguration } from "./image";
import { daytonaSandboxLabels, daytonaSandboxName } from "./names";

const DEFAULT_AUTO_ARCHIVE_MINUTES = 10_080;
const DEFAULT_AUTO_STOP_MINUTES = 15;
const SANDBOX_OPERATION_TIMEOUT_SECONDS = 60;

export type DaytonaProviderErrorKind =
  | "not_found"
  | "retryable"
  | "non_retryable";

export type DaytonaSandboxService = Readonly<{
  create: (
    parameters: CreateSandboxFromSnapshotParams,
    options?: Readonly<{ timeout?: number }>
  ) => Promise<Sandbox>;
  get: (sandboxIdOrName: string) => Promise<Sandbox>;
}>;

export type DaytonaSandboxConfiguration = Readonly<{
  autoArchiveInterval: number;
  autoStopInterval: number;
  domainAllowList?: string;
  snapshotName: string;
}>;

export type DaytonaSandboxDependencies = Readonly<{
  daytona: DaytonaSandboxService;
  store: RunnerStore;
}>;

export type DaytonaSandboxWarmDependencies = DaytonaSandboxDependencies &
  Readonly<{
    probe: (sandbox: Sandbox) => Promise<void>;
  }>;

export class DaytonaSandboxLifecycleError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    options: ErrorOptions & Readonly<{ retryable: boolean }>
  ) {
    super(message, options);
    this.name = "DaytonaSandboxLifecycleError";
    this.retryable = options.retryable;
  }
}

function nonNegativeMinutes(
  environment: NodeJS.ProcessEnv,
  name: "DAYTONA_AUTO_ARCHIVE_MINUTES" | "DAYTONA_AUTO_STOP_MINUTES",
  defaultValue: number
): number {
  const value = environment[name]?.trim() ?? String(defaultValue);
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
  return minutes;
}

export function daytonaSandboxConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): DaytonaSandboxConfiguration {
  const domainAllowList = environment.DAYTONA_DOMAIN_ALLOW_LIST?.trim();
  return {
    autoArchiveInterval: nonNegativeMinutes(
      environment,
      "DAYTONA_AUTO_ARCHIVE_MINUTES",
      DEFAULT_AUTO_ARCHIVE_MINUTES
    ),
    autoStopInterval: nonNegativeMinutes(
      environment,
      "DAYTONA_AUTO_STOP_MINUTES",
      DEFAULT_AUTO_STOP_MINUTES
    ),
    ...(domainAllowList ? { domainAllowList } : {}),
    snapshotName: daytonaSnapshotConfiguration(environment).snapshotName,
  };
}

/** Classifies provider failures without exposing provider messages or metadata. */
export function classifyDaytonaProviderError(
  error: unknown
): DaytonaProviderErrorKind {
  if (
    error instanceof DaytonaNotFoundError ||
    error instanceof DaytonaGoneError ||
    (error instanceof DaytonaError &&
      (error.statusCode === 404 || error.statusCode === 410))
  ) {
    return "not_found";
  }
  if (
    error instanceof DaytonaConnectionError ||
    error instanceof DaytonaTimeoutError ||
    error instanceof DaytonaRateLimitError ||
    error instanceof DaytonaInternalServerError ||
    error instanceof DaytonaBadGatewayError ||
    error instanceof DaytonaServiceUnavailableError ||
    (error instanceof DaytonaError &&
      error.statusCode !== undefined &&
      error.statusCode >= 500)
  ) {
    return "retryable";
  }
  return "non_retryable";
}

function sandboxCreateParameters(
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration
): CreateSandboxFromSnapshotParams {
  return {
    autoArchiveInterval: configuration.autoArchiveInterval,
    autoDeleteInterval: -1,
    autoStopInterval: configuration.autoStopInterval,
    ...(configuration.domainAllowList
      ? { domainAllowList: configuration.domainAllowList }
      : {}),
    ephemeral: false,
    labels: daytonaSandboxLabels(agent.tenant, agent.id),
    name: daytonaSandboxName(agent.tenant, agent.id),
    snapshot: configuration.snapshotName,
  };
}

async function startOrRecoverSandbox(sandbox: Sandbox): Promise<void> {
  if (sandbox.state === SandboxState.ERROR && sandbox.recoverable === true) {
    await sandbox.recover(SANDBOX_OPERATION_TIMEOUT_SECONDS);
    return;
  }
  if (
    sandbox.state === SandboxState.STOPPED ||
    sandbox.state === SandboxState.ARCHIVED
  ) {
    await sandbox.start(SANDBOX_OPERATION_TIMEOUT_SECONDS);
    return;
  }
  if (sandbox.state === SandboxState.DESTROYED) {
    throw new DaytonaSandboxLifecycleError(
      "Stored Daytona sandbox is destroyed.",
      { retryable: false }
    );
  }
  if (sandbox.state === SandboxState.ERROR) {
    throw new DaytonaSandboxLifecycleError(
      "Stored Daytona sandbox is not recoverable.",
      { retryable: false }
    );
  }
  if (sandbox.state === SandboxState.DESTROYING) {
    throw new DaytonaSandboxLifecycleError(
      "Stored Daytona sandbox is being deleted.",
      { retryable: true }
    );
  }
}

async function persistCreatedSandbox(
  principal: RunnerPrincipal,
  reserved: RunnerAgentRecord,
  sandbox: Sandbox,
  dependencies: DaytonaSandboxDependencies
): Promise<RunnerAgentRecord> {
  const attached = await dependencies.store.attachDaytonaSandbox(principal, {
    agentId: reserved.id,
    expectedGeneration: reserved.sandboxGeneration,
    expectedVersion: reserved.version,
    sandboxId: sandbox.id,
  });
  if (attached.kind === "updated") {
    return attached.value;
  }

  try {
    await sandbox.delete(SANDBOX_OPERATION_TIMEOUT_SECONDS, true);
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      throw error;
    }
  }
  throw new DaytonaSandboxLifecycleError(
    "Daytona sandbox generation changed before it could be stored.",
    { retryable: true }
  );
}

async function createSandbox(
  principal: RunnerPrincipal,
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies
): Promise<{ agent: RunnerAgentRecord; sandbox: Sandbox }> {
  const reserved = await dependencies.store.reserveDaytonaSandbox(principal, {
    agentId: agent.id,
    expectedGeneration: agent.sandboxGeneration,
    expectedSandboxId: agent.daytonaSandboxId,
    expectedVersion: agent.version,
  });
  if (reserved.kind === "in_progress") {
    throw new DaytonaSandboxLifecycleError(
      "Daytona sandbox provisioning is already in progress.",
      { retryable: true }
    );
  }
  if (reserved.kind !== "reserved") {
    throw new DaytonaSandboxLifecycleError(
      "Daytona sandbox generation changed before creation.",
      { retryable: true }
    );
  }

  let sandbox: Sandbox;
  try {
    sandbox = await dependencies.daytona.create(
      sandboxCreateParameters(reserved.value, configuration),
      { timeout: SANDBOX_OPERATION_TIMEOUT_SECONDS }
    );
  } catch (error) {
    const failed = await dependencies.store.failDaytonaSandboxReservation(
      principal,
      {
        agentId: reserved.value.id,
        expectedGeneration: reserved.value.sandboxGeneration,
        expectedVersion: reserved.value.version,
      }
    );
    if (failed.kind === "not_found" || failed.kind === "stale_version") {
      throw new DaytonaSandboxLifecycleError(
        "Daytona sandbox generation changed during creation.",
        { cause: error, retryable: true }
      );
    }
    throw error;
  }

  const persisted = await persistCreatedSandbox(
    principal,
    reserved.value,
    sandbox,
    dependencies
  );
  await startOrRecoverSandbox(sandbox);
  return { agent: persisted, sandbox };
}

/**
 * Resolves only the provider ID stored on the agent. A replacement is created
 * only after Daytona reports that that ID is gone, or its returned state is
 * destroyed.
 */
export async function ensureDaytonaSandbox(
  principal: RunnerPrincipal,
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies
): Promise<{ agent: RunnerAgentRecord; sandbox: Sandbox }> {
  if (
    agent.sandboxLifecycle === "decommissioning" ||
    agent.sandboxLifecycle === "decommission_failed"
  ) {
    throw new DaytonaSandboxLifecycleError(
      "Daytona sandbox is being decommissioned.",
      { retryable: true }
    );
  }
  if (agent.sandboxLifecycle === "provisioning") {
    throw new DaytonaSandboxLifecycleError(
      "Daytona sandbox provisioning is already in progress.",
      { retryable: true }
    );
  }
  if (!agent.daytonaSandboxId) {
    return createSandbox(principal, agent, configuration, dependencies);
  }

  let sandbox: Sandbox;
  try {
    sandbox = await dependencies.daytona.get(agent.daytonaSandboxId);
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      throw error;
    }
    return createSandbox(principal, agent, configuration, dependencies);
  }
  if (sandbox.state === SandboxState.DESTROYED) {
    return createSandbox(principal, agent, configuration, dependencies);
  }
  await startOrRecoverSandbox(sandbox);
  return { agent, sandbox };
}

export async function warmDaytonaSandbox(
  principal: RunnerPrincipal,
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxWarmDependencies
): Promise<
  | { kind: "ready"; agent: RunnerAgentRecord; sandbox: Sandbox }
  | { kind: "in_progress" }
  | { kind: "failed"; error: DaytonaProviderErrorKind }
> {
  let ensured: { agent: RunnerAgentRecord; sandbox: Sandbox };
  try {
    ensured = await ensureDaytonaSandbox(
      principal,
      agent,
      configuration,
      dependencies
    );
  } catch (error) {
    return { error: classifyDaytonaProviderError(error), kind: "failed" };
  }

  const warm = await dependencies.store.beginDaytonaSandboxWarm(principal, {
    agentId: ensured.agent.id,
    expectedGeneration: ensured.agent.sandboxGeneration,
    expectedVersion: ensured.agent.version,
  });
  if (warm.kind === "in_progress") {
    return { kind: "in_progress" };
  }
  if (warm.kind !== "started") {
    return { error: "non_retryable", kind: "failed" };
  }

  try {
    await dependencies.probe(ensured.sandbox);
  } catch (error) {
    await dependencies.store.finishDaytonaSandboxWarm(principal, {
      agentId: warm.value.id,
      expectedGeneration: warm.value.sandboxGeneration,
      expectedVersion: warm.value.version,
      status: "failed",
    });
    return { error: classifyDaytonaProviderError(error), kind: "failed" };
  }
  const finished = await dependencies.store.finishDaytonaSandboxWarm(
    principal,
    {
      agentId: warm.value.id,
      expectedGeneration: warm.value.sandboxGeneration,
      expectedVersion: warm.value.version,
      status: "ready",
    }
  );
  return finished.kind === "updated"
    ? { agent: finished.value, kind: "ready", sandbox: ensured.sandbox }
    : { error: "non_retryable", kind: "failed" };
}

/**
 * Fences the durable row before asking Daytona to delete and removes the row
 * only after Daytona confirms deletion. Provider 404/410 means it is already
 * gone and is therefore an idempotent successful delete.
 */
export async function deleteDaytonaSandbox(
  principal: RunnerPrincipal,
  agentId: string,
  dependencies: DaytonaSandboxDependencies
): Promise<
  | { kind: "deleted" }
  | { kind: "busy" | "not_found" | "stale_version" }
  | { kind: "failed"; error: DaytonaProviderErrorKind }
> {
  const decommission = await dependencies.store.beginDaytonaSandboxDecommission(
    principal,
    agentId
  );
  if (decommission.kind !== "decommissioning") {
    return decommission;
  }

  const agent = decommission.value;
  if (agent.daytonaSandboxId) {
    try {
      const sandbox = await dependencies.daytona.get(agent.daytonaSandboxId);
      await sandbox.delete(SANDBOX_OPERATION_TIMEOUT_SECONDS, true);
    } catch (error) {
      const kind = classifyDaytonaProviderError(error);
      if (kind === "non_retryable") {
        await dependencies.store.failDaytonaSandboxDecommission(principal, {
          agentId: agent.id,
          expectedGeneration: agent.sandboxGeneration,
          expectedVersion: agent.version,
        });
      }
      if (kind !== "not_found") {
        return { error: kind, kind: "failed" };
      }
    }
  }

  return dependencies.store.deleteDecommissionedAgent(principal, {
    agentId: agent.id,
    expectedGeneration: agent.sandboxGeneration,
    expectedVersion: agent.version,
  });
}
