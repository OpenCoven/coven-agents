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
const SANDBOX_TRANSITION_POLL_INTERVAL_MS = 1000;
export const SANDBOX_PROVISIONING_TIMEOUT_MS = 5 * 60 * 1000;
export const SANDBOX_WARM_TIMEOUT_MS = 5 * 60 * 1000;

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

export type DaytonaSandboxLifecycleDependencies = Readonly<{
  now?: () => number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  transitionTimeoutMs?: number;
}>;

export type DaytonaSandboxDependencies = Readonly<{
  daytona: DaytonaSandboxService;
  lifecycle?: DaytonaSandboxLifecycleDependencies;
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
  if (error instanceof DaytonaSandboxLifecycleError) {
    return error.retryable ? "retryable" : "non_retryable";
  }
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

function transitionTimeoutError(): DaytonaSandboxLifecycleError {
  return new DaytonaSandboxLifecycleError(
    "Daytona sandbox shutdown transition did not finish in time.",
    { retryable: true }
  );
}

function transitionAbortedError(): DaytonaSandboxLifecycleError {
  return new DaytonaSandboxLifecycleError(
    "Daytona sandbox shutdown transition was aborted.",
    { retryable: true }
  );
}

function throwIfTransitionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw transitionAbortedError();
  }
}

function sleepForTransition(
  milliseconds: number,
  signal: AbortSignal | undefined
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(transitionAbortedError());
      },
      { once: true }
    );
  });
}

function terminalTransitionError(
  state: SandboxState | undefined
): DaytonaSandboxLifecycleError | undefined {
  if (state === SandboxState.DESTROYED) {
    return new DaytonaSandboxLifecycleError(
      "Daytona sandbox was destroyed during shutdown.",
      { retryable: false }
    );
  }
  if (state === SandboxState.BUILD_FAILED || state === SandboxState.ERROR) {
    return new DaytonaSandboxLifecycleError(
      "Daytona sandbox shutdown transition failed.",
      { retryable: false }
    );
  }
  if (state === SandboxState.DESTROYING) {
    return new DaytonaSandboxLifecycleError(
      "Daytona sandbox is being deleted during shutdown.",
      { retryable: true }
    );
  }
  return undefined;
}

function stableShutdownState(state: SandboxState | undefined): boolean {
  return (
    state === SandboxState.STOPPED ||
    state === SandboxState.ARCHIVED ||
    state === SandboxState.PAUSED
  );
}

function isStartedSandbox(sandbox: Sandbox): boolean {
  return sandbox.state === SandboxState.STARTED;
}

function waitForShutdownTransition(
  sandbox: Sandbox,
  lifecycle: DaytonaSandboxLifecycleDependencies | undefined
): Promise<"started" | "stable"> {
  const now = lifecycle?.now ?? Date.now;
  const sleep = lifecycle?.sleep ?? sleepForTransition;
  const timeoutMs =
    lifecycle?.transitionTimeoutMs ?? SANDBOX_OPERATION_TIMEOUT_SECONDS * 1000;
  const deadline = now() + timeoutMs;

  async function poll(): Promise<"started" | "stable"> {
    throwIfTransitionAborted(lifecycle?.signal);
    if (isStartedSandbox(sandbox)) {
      return "started";
    }
    if (stableShutdownState(sandbox.state)) {
      return "stable";
    }
    const terminalError = terminalTransitionError(sandbox.state);
    if (terminalError) {
      throw terminalError;
    }
    if (now() >= deadline) {
      throw transitionTimeoutError();
    }

    await sandbox.refreshData();

    throwIfTransitionAborted(lifecycle?.signal);
    if (isStartedSandbox(sandbox)) {
      return "started";
    }
    if (stableShutdownState(sandbox.state)) {
      return "stable";
    }
    const refreshedTerminalError = terminalTransitionError(sandbox.state);
    if (refreshedTerminalError) {
      throw refreshedTerminalError;
    }
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw transitionTimeoutError();
    }
    await sleep(
      Math.min(SANDBOX_TRANSITION_POLL_INTERVAL_MS, remainingMs),
      lifecycle?.signal
    );
    return poll();
  }

  return poll();
}

async function startOrRecoverSandbox(
  sandbox: Sandbox,
  lifecycle?: DaytonaSandboxLifecycleDependencies
): Promise<void> {
  if (sandbox.state === SandboxState.STARTED) {
    return;
  }
  if (sandbox.state === SandboxState.ERROR && sandbox.recoverable === true) {
    await sandbox.recover(SANDBOX_OPERATION_TIMEOUT_SECONDS);
    return;
  }
  if (
    sandbox.state === SandboxState.STOPPED ||
    sandbox.state === SandboxState.ARCHIVED ||
    sandbox.state === SandboxState.PAUSED
  ) {
    await sandbox.start(SANDBOX_OPERATION_TIMEOUT_SECONDS);
    return;
  }
  if (
    sandbox.state === SandboxState.DESTROYED ||
    sandbox.state === SandboxState.BUILD_FAILED
  ) {
    throw new DaytonaSandboxLifecycleError(
      "Stored Daytona sandbox is terminally unusable.",
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
  if (
    sandbox.state === SandboxState.STOPPING ||
    sandbox.state === SandboxState.ARCHIVING ||
    sandbox.state === SandboxState.PAUSING
  ) {
    const result = await waitForShutdownTransition(sandbox, lifecycle);
    if (result === "started") {
      return;
    }
    // Daytona's start operation waits for readiness, including resuming PAUSED.
    await sandbox.start(SANDBOX_OPERATION_TIMEOUT_SECONDS);
    return;
  }
  await sandbox.waitUntilStarted(SANDBOX_OPERATION_TIMEOUT_SECONDS);
}

async function persistSandbox(
  principal: RunnerPrincipal,
  reserved: RunnerAgentRecord,
  sandbox: Sandbox,
  dependencies: DaytonaSandboxDependencies,
  deleteOnAttachLoss: boolean
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

  if (deleteOnAttachLoss) {
    try {
      await sandbox.delete(SANDBOX_OPERATION_TIMEOUT_SECONDS, true);
    } catch (error) {
      if (classifyDaytonaProviderError(error) !== "not_found") {
        throw error;
      }
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
    provisioningStaleBefore: new Date(
      Date.now() - SANDBOX_PROVISIONING_TIMEOUT_MS
    ),
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
  let created = false;
  try {
    sandbox = await dependencies.daytona.get(
      daytonaSandboxName(reserved.value.tenant, reserved.value.id)
    );
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      await failSandboxReservation(principal, reserved.value, dependencies);
      throw error;
    }
    try {
      sandbox = await dependencies.daytona.create(
        sandboxCreateParameters(reserved.value, configuration),
        { timeout: SANDBOX_OPERATION_TIMEOUT_SECONDS }
      );
      created = true;
    } catch (createError) {
      await failSandboxReservation(principal, reserved.value, dependencies);
      throw createError;
    }
  }

  const persisted = await persistSandbox(
    principal,
    reserved.value,
    sandbox,
    dependencies,
    created
  );
  await startOrRecoverSandbox(sandbox, dependencies.lifecycle);
  return { agent: persisted, sandbox };
}

async function failSandboxReservation(
  principal: RunnerPrincipal,
  reserved: RunnerAgentRecord,
  dependencies: DaytonaSandboxDependencies
): Promise<void> {
  const failed = await dependencies.store.failDaytonaSandboxReservation(
    principal,
    {
      agentId: reserved.id,
      expectedGeneration: reserved.sandboxGeneration,
      expectedVersion: reserved.version,
    }
  );
  if (failed.kind === "not_found" || failed.kind === "stale_version") {
    throw new DaytonaSandboxLifecycleError(
      "Daytona sandbox generation changed during provisioning.",
      { retryable: true }
    );
  }
}

async function deleteFirstDaytonaSandbox(
  identifiers: readonly string[],
  dependencies: DaytonaSandboxDependencies
): Promise<void> {
  const [identifier, ...remaining] = identifiers;
  if (!identifier) {
    return;
  }
  let sandbox: Sandbox;
  try {
    sandbox = await dependencies.daytona.get(identifier);
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      throw error;
    }
    return deleteFirstDaytonaSandbox(remaining, dependencies);
  }
  try {
    await sandbox.delete(SANDBOX_OPERATION_TIMEOUT_SECONDS, true);
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      throw error;
    }
  }
}

/**
 * Resolves the stored provider ID and only creates after the deterministic
 * sandbox name is confirmed absent.
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
  if (agent.sandboxLifecycle === "provisioning" || !agent.daytonaSandboxId) {
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
  await startOrRecoverSandbox(sandbox, dependencies.lifecycle);
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
    warmStaleBefore: new Date(Date.now() - SANDBOX_WARM_TIMEOUT_MS),
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
    {
      agentId,
      provisioningStaleBefore: new Date(
        Date.now() - SANDBOX_PROVISIONING_TIMEOUT_MS
      ),
    }
  );
  if (decommission.kind !== "decommissioning") {
    return decommission;
  }

  const agent = decommission.value;
  try {
    await deleteFirstDaytonaSandbox(
      [
        ...(agent.daytonaSandboxId ? [agent.daytonaSandboxId] : []),
        daytonaSandboxName(agent.tenant, agent.id),
      ],
      dependencies
    );
  } catch (error) {
    const kind = classifyDaytonaProviderError(error);
    if (kind === "non_retryable") {
      await dependencies.store.failDaytonaSandboxDecommission(principal, {
        agentId: agent.id,
        expectedGeneration: agent.sandboxGeneration,
        expectedVersion: agent.version,
      });
    }
    return { error: kind, kind: "failed" };
  }

  return dependencies.store.deleteDecommissionedAgent(principal, {
    agentId: agent.id,
    expectedGeneration: agent.sandboxGeneration,
    expectedVersion: agent.version,
  });
}
