import "server-only";

import { createHash } from "node:crypto";
import {
  type CreateSandboxFromSnapshotParams,
  DaytonaAuthenticationError,
  DaytonaBadGatewayError,
  DaytonaBadRequestError,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaForbiddenError,
  DaytonaGoneError,
  DaytonaInternalServerError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaServiceUnavailableError,
  DaytonaTimeoutError,
  DaytonaUnprocessableEntityError,
  type Sandbox,
  SandboxState,
} from "@daytona/sdk";
import { compareAscii } from "@/lib/ascii";
import {
  observeRunnerResourceOperation,
  type RunnerResourceOperationObserver,
  runnerResourceProviderSignal,
} from "../resource-observability";
import type { RunnerStore } from "../store";
import type {
  RunnerAgentRecord,
  RunnerDispatchAuthority,
  RunnerOperator,
  RunnerPrincipal,
} from "../types";
import {
  type DaytonaSandboxResourcePolicy,
  daytonaDomainAllowList,
  daytonaGitHubGatewayHostname,
  daytonaSandboxResourcePolicy,
  daytonaSnapshotConfiguration,
} from "./config";
import {
  daytonaProbeSessionName,
  daytonaSandboxLabels,
  daytonaSandboxName,
} from "./names";

const SANDBOX_OPERATION_TIMEOUT_SECONDS = 60;
const SANDBOX_TRANSITION_POLL_INTERVAL_MS = 1000;
export const DAYTONA_CODE_TOOLBOX_LANGUAGE_LABEL = "code-toolbox-language";
export const DAYTONA_SANDBOX_LANGUAGE = "python";
export const SANDBOX_PROVISIONING_TIMEOUT_MS = 5 * 60 * 1000;
export const SANDBOX_WARM_TIMEOUT_MS = 5 * 60 * 1000;

export type DaytonaProviderErrorKind =
  | "not_found"
  | "retryable"
  | "non_retryable";

export type DaytonaSandboxCreateErrorKind = "ambiguous" | "definite_rejection";

/**
 * A snapshot carries its own resources, and Daytona refuses a snapshot create
 * that also names them: the SDK declares `resources` only for image creates
 * but forwards the field regardless, so sending it turns every create into a
 * definite provider rejection. The resource policy reaches a sandbox through
 * the snapshot it was built from, never through this call.
 */
export type DaytonaSandboxCreateParameters = CreateSandboxFromSnapshotParams;

export type DaytonaSandboxService = Readonly<{
  create: (
    parameters: DaytonaSandboxCreateParameters,
    options?: Readonly<{ timeout?: number }>
  ) => Promise<Sandbox>;
  get: (sandboxIdOrName: string) => Promise<Sandbox>;
  /**
   * Read-only snapshot lookup, used to prove a replacement snapshot exists
   * BEFORE a persistent workspace is destroyed. Optional in the type only so
   * the 60-odd existing construction sites need not change; absence fails
   * closed — see `assertReplacementSnapshotReady`.
   */
  snapshot?: Readonly<{
    get: (
      name: string
    ) => Promise<
      Readonly<{ cpu?: number; disk?: number; memory?: number; name: string }>
    >;
  }>;
}>;

export type DaytonaSandboxConfiguration = DaytonaSandboxResourcePolicy &
  Readonly<{
    configurationId?: string;
    domainAllowList?: string;
    gatewayHostname?: string;
    snapshotName: string;
    target: "eu" | "us";
  }>;

export type DaytonaSandboxLifecycleDependencies = Readonly<{
  deadline?: number;
  now?: () => number;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  transitionTimeoutMs?: number;
}>;

export type DaytonaSandboxDependencies = Readonly<{
  daytona: DaytonaSandboxService;
  lifecycle?: DaytonaSandboxLifecycleDependencies;
  observe?: RunnerResourceOperationObserver;
  store: RunnerStore;
}>;

export type DaytonaSandboxWarmDependencies = DaytonaSandboxDependencies &
  Readonly<{
    probe: (
      sandbox: Sandbox,
      signal?: AbortSignal,
      timeoutSeconds?: number,
      sessionId?: string
    ) => Promise<void>;
  }>;

export class DaytonaSandboxLifecycleError extends Error {
  readonly kind: "cleanup_needed" | "lifecycle";
  readonly retryable: boolean;

  constructor(
    message: string,
    options: ErrorOptions &
      Readonly<{ kind?: "cleanup_needed" | "lifecycle"; retryable: boolean }>
  ) {
    super(message, options);
    this.kind = options.kind ?? "lifecycle";
    this.name = "DaytonaSandboxLifecycleError";
    this.retryable = options.retryable;
  }
}

export function daytonaSandboxConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): DaytonaSandboxConfiguration {
  const domainAllowList = daytonaDomainAllowList(environment);
  const gatewayHostname = daytonaGitHubGatewayHostname(
    environment,
    domainAllowList
  );
  const resourcePolicy = daytonaSandboxResourcePolicy(environment);
  const snapshotConfiguration = daytonaSnapshotConfiguration(environment);
  const configurationId = createHash("sha256")
    .update(
      JSON.stringify({
        ...resourcePolicy,
        domainAllowList:
          domainAllowList?.split(",").sort(compareAscii).join(",") ?? null,
        gatewayHostname: gatewayHostname ?? null,
        snapshotName: snapshotConfiguration.snapshotName,
        target: snapshotConfiguration.target,
      }),
      "utf8"
    )
    .digest("hex");
  return {
    ...resourcePolicy,
    configurationId,
    ...(domainAllowList ? { domainAllowList } : {}),
    ...(gatewayHostname ? { gatewayHostname } : {}),
    snapshotName: snapshotConfiguration.snapshotName,
    target: snapshotConfiguration.target,
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

/**
 * A failed create is safe to reset only when Daytona explicitly rejected it.
 * Transport and unknown failures may be emitted after Daytona accepted the
 * request, so their deterministic name remains reserved for reconciliation.
 */
export function classifyDaytonaSandboxCreateError(
  error: unknown
): DaytonaSandboxCreateErrorKind {
  if (error instanceof DaytonaSandboxLifecycleError) {
    return error.retryable ? "ambiguous" : "definite_rejection";
  }

  if (
    error instanceof DaytonaBadRequestError ||
    error instanceof DaytonaAuthenticationError ||
    error instanceof DaytonaForbiddenError ||
    error instanceof DaytonaNotFoundError ||
    error instanceof DaytonaConflictError ||
    error instanceof DaytonaGoneError ||
    error instanceof DaytonaUnprocessableEntityError ||
    (error instanceof DaytonaError &&
      error.statusCode !== undefined &&
      error.statusCode >= 400 &&
      error.statusCode < 500)
  ) {
    return "definite_rejection";
  }
  return "ambiguous";
}

function isProbeCleanupPending(
  error: unknown
): error is Readonly<{ code: "probe_cleanup_pending" }> {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "probe_cleanup_pending"
  );
}

function sandboxCreateParameters(
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration
): DaytonaSandboxCreateParameters {
  return {
    autoArchiveInterval: configuration.autoArchiveInterval,
    autoDeleteInterval: configuration.autoDeleteInterval,
    autoPauseInterval: 0,
    autoStopInterval: configuration.autoStopInterval,
    ...(configuration.domainAllowList
      ? { domainAllowList: configuration.domainAllowList }
      : {}),
    ephemeral: false,
    labels: {
      ...daytonaSandboxLabels(agent.tenant, agent.id),
      sandboxGeneration: String(agent.sandboxGeneration),
      ...(configuration.configurationId
        ? { configurationId: configuration.configurationId }
        : {}),
    },
    language: DAYTONA_SANDBOX_LANGUAGE,
    name: daytonaSandboxName(agent.tenant, agent.id),
    public: false,
    snapshot: configuration.snapshotName,
    ttlMinutes: configuration.ttlMinutes,
  };
}

export function daytonaSandboxProvisioningIdentityMatches(
  sandbox: Sandbox,
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration
): boolean {
  if (!configuration.configurationId) {
    return false;
  }
  const expectedLabels = {
    ...daytonaSandboxLabels(agent.tenant, agent.id),
    configurationId: configuration.configurationId,
    sandboxGeneration: String(agent.sandboxGeneration),
  };
  return Object.entries(expectedLabels).every(
    ([name, value]) => sandbox.labels?.[name] === value
  );
}

function sandboxConfigurationMatches(
  sandbox: Sandbox,
  configuration: DaytonaSandboxConfiguration
): boolean {
  return (
    configuration.configurationId === undefined ||
    sandbox.labels?.configurationId === configuration.configurationId
  );
}

/**
 * Proves the replacement snapshot exists, and carries the resources policy
 * asks for, before anything is deleted.
 *
 * Reprovisioning deletes the tenant's persistent workspace and only then
 * creates its replacement. The order is forced — the sandbox name is derived
 * from the agent, so the replacement cannot be created alongside the original.
 * That makes an unresolvable snapshot catastrophic rather than merely broken:
 * the workspace is destroyed and the create that should replace it fails with
 * the provider's bare 400. `DAYTONA_SNAPSHOT` is only shape-checked at build
 * time, so a snapshot that was never built deploys green and reaches exactly
 * this path.
 *
 * Absence of the snapshot service fails closed. A caller that cannot prove the
 * replacement is usable does not get to delete.
 */
const SNAPSHOT_ACTIVE_STATE = "active";

export async function assertReplacementSnapshotReady(
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies
): Promise<void> {
  const snapshots = dependencies.daytona.snapshot;
  if (!snapshots) {
    throw new DaytonaSandboxLifecycleError(
      "Refusing to delete a persistent sandbox: no way to verify the replacement snapshot exists.",
      { kind: "cleanup_needed", retryable: false }
    );
  }

  let snapshot: Readonly<{
    cpu?: number;
    disk?: number;
    mem?: number;
    memory?: number;
    name: string;
    state?: string;
  }>;
  try {
    snapshot = await snapshots.get(configuration.snapshotName);
  } catch (error) {
    throw new DaytonaSandboxLifecycleError(
      `Refusing to delete a persistent sandbox: replacement snapshot "${configuration.snapshotName}" could not be resolved.`,
      {
        cause: error,
        kind: "cleanup_needed",
        retryable: classifyDaytonaProviderError(error) !== "non_retryable",
      }
    );
  }

  // `snapshot.get` resolves for building, pending, error and build_failed
  // alike, so existence is not usability. A create against anything but an
  // active snapshot fails, and by then the workspace is already gone.
  if (
    snapshot.state !== undefined &&
    snapshot.state !== SNAPSHOT_ACTIVE_STATE
  ) {
    throw new DaytonaSandboxLifecycleError(
      `Refusing to delete a persistent sandbox: replacement snapshot "${configuration.snapshotName}" is not active (state: ${snapshot.state}).`,
      { kind: "cleanup_needed", retryable: false }
    );
  }

  // A sandbox cannot exceed what its snapshot carries, so a snapshot built
  // below policy silently reproduces the drift this replacement exists to
  // remove. Daytona reports memory as `mem` on a snapshot and `memory` on a
  // sandbox; reading only the latter made this check dead code. An absent
  // field is still not evidence of a mismatch.
  const reported = {
    cpu: snapshot.cpu,
    disk: snapshot.disk,
    memory: snapshot.mem ?? snapshot.memory,
  };
  const shortfalls = (["cpu", "disk", "memory"] as const).filter((field) => {
    const provided = reported[field];
    return provided !== undefined && provided < configuration.resources[field];
  });
  if (shortfalls.length > 0) {
    throw new DaytonaSandboxLifecycleError(
      `Refusing to delete a persistent sandbox: replacement snapshot "${configuration.snapshotName}" is below policy (${shortfalls.join(", ")}).`,
      { kind: "cleanup_needed", retryable: false }
    );
  }
}

async function deleteMismatchedSandbox(sandbox: Sandbox): Promise<void> {
  try {
    await sandbox.delete(SANDBOX_OPERATION_TIMEOUT_SECONDS, true);
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      throw error;
    }
  }
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

function lifecycleNow(
  lifecycle: DaytonaSandboxLifecycleDependencies | undefined
): number {
  return (lifecycle?.now ?? Date.now)();
}

function lifecycleAborted(
  lifecycle: DaytonaSandboxLifecycleDependencies | undefined
): boolean {
  return (
    lifecycle?.signal?.aborted === true ||
    (lifecycle?.deadline !== undefined &&
      lifecycleNow(lifecycle) >= lifecycle.deadline)
  );
}

function throwIfTransitionAborted(
  lifecycle: DaytonaSandboxLifecycleDependencies | undefined
): void {
  if (lifecycleAborted(lifecycle)) {
    throw transitionAbortedError();
  }
}

function providerTimeoutSeconds(
  lifecycle: DaytonaSandboxLifecycleDependencies | undefined
): number {
  if (lifecycle?.deadline === undefined) {
    return SANDBOX_OPERATION_TIMEOUT_SECONDS;
  }
  const remainingMs = lifecycle.deadline - lifecycleNow(lifecycle);
  if (remainingMs <= 0) {
    throw transitionAbortedError();
  }
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function withLifecycleAbort<T>(
  operation: () => Promise<T>,
  lifecycle: DaytonaSandboxLifecycleDependencies | undefined
): Promise<T> {
  // Daytona 0.207 does not accept AbortSignal on sandbox lookup/lifecycle
  // methods. The deadline-scoped SDK client and per-operation timeouts bound
  // the transport; this guard stops our control flow so the caller can release
  // or mark its durable lifecycle fence immediately.
  throwIfTransitionAborted(lifecycle);
  const signal = lifecycle?.signal;
  if (!signal) {
    return operation();
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(transitionAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function settleCleanupWithinLifecycle<T>(
  operation: Promise<T>,
  lifecycle: DaytonaSandboxLifecycleDependencies | undefined
): Promise<
  Readonly<{ kind: "settled"; value: T }> | Readonly<{ kind: "unsettled" }>
> {
  operation.catch(() => undefined);
  if (lifecycle?.deadline === undefined) {
    return lifecycle?.signal?.aborted
      ? Promise.resolve({ kind: "unsettled" })
      : operation.then(
          (value) => ({ kind: "settled", value }),
          () => ({ kind: "unsettled" })
        );
  }
  const remainingMs = lifecycle.deadline - lifecycleNow(lifecycle);
  if (remainingMs <= 0) {
    return Promise.resolve({ kind: "unsettled" });
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: "unsettled" }), remainingMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "settled", value });
      },
      () => {
        clearTimeout(timer);
        resolve({ kind: "unsettled" });
      }
    );
  });
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
    throwIfTransitionAborted(lifecycle);
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

    await withLifecycleAbort(() => sandbox.refreshData(), lifecycle);

    throwIfTransitionAborted(lifecycle);
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
  throwIfTransitionAborted(lifecycle);
  if (sandbox.state === SandboxState.STARTED) {
    return;
  }
  if (sandbox.state === SandboxState.ERROR && sandbox.recoverable === true) {
    await withLifecycleAbort(
      () => sandbox.recover(providerTimeoutSeconds(lifecycle)),
      lifecycle
    );
    return;
  }
  if (
    sandbox.state === SandboxState.STOPPED ||
    sandbox.state === SandboxState.ARCHIVED ||
    sandbox.state === SandboxState.PAUSED
  ) {
    await withLifecycleAbort(
      () => sandbox.start(providerTimeoutSeconds(lifecycle)),
      lifecycle
    );
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
    await withLifecycleAbort(
      () => sandbox.start(providerTimeoutSeconds(lifecycle)),
      lifecycle
    );
    return;
  }
  if (sandbox.state === SandboxState.RESIZING) {
    await withLifecycleAbort(
      () => sandbox.waitForResizeComplete(providerTimeoutSeconds(lifecycle)),
      lifecycle
    );
    return startOrRecoverSandbox(sandbox, lifecycle);
  }
  await withLifecycleAbort(
    () => sandbox.waitUntilStarted(providerTimeoutSeconds(lifecycle)),
    lifecycle
  );
}

type DaytonaSandboxPersistence = Readonly<{
  attach: (
    reserved: RunnerAgentRecord,
    sandboxId: string
  ) => Promise<
    | { kind: "updated"; value: RunnerAgentRecord }
    | { kind: "not_found" }
    | { current?: RunnerAgentRecord; kind: "stale_version" }
  >;
  beginReset: (
    reserved: RunnerAgentRecord
  ) => Promise<
    | { kind: "updated"; value: RunnerAgentRecord }
    | { kind: "not_found" | "not_live" | "stale_version" }
  >;
  fail: (
    reserved: RunnerAgentRecord
  ) => Promise<
    | { kind: "updated"; value: RunnerAgentRecord }
    | { kind: "not_found" }
    | { kind: "stale_version" }
  >;
  finishReset: (
    resetting: RunnerAgentRecord
  ) => Promise<
    | { kind: "updated"; value: RunnerAgentRecord }
    | { kind: "not_found" | "stale_version" }
  >;
  markAmbiguous: (
    reserved: RunnerAgentRecord
  ) => Promise<
    | { kind: "updated"; value: RunnerAgentRecord }
    | { kind: "not_found" }
    | { kind: "stale_version" }
  >;
  reserve: (
    agent: RunnerAgentRecord
  ) => Promise<
    | { kind: "reserved"; value: RunnerAgentRecord }
    | { kind: "in_progress"; value: RunnerAgentRecord }
    | { kind: "not_found" }
    | { kind: "stale_version" }
  >;
}>;

function subscriberSandboxPersistence(
  principal: RunnerPrincipal,
  dependencies: DaytonaSandboxDependencies
): DaytonaSandboxPersistence {
  return {
    attach: (reserved, sandboxId) =>
      dependencies.store.attachDaytonaSandbox(principal, {
        agentId: reserved.id,
        expectedGeneration: reserved.sandboxGeneration,
        expectedVersion: reserved.version,
        sandboxId,
      }),
    beginReset: (reserved) =>
      dependencies.store.beginDaytonaSandboxReset(principal, {
        agentId: reserved.id,
        expectedGeneration: reserved.sandboxGeneration,
        expectedVersion: reserved.version,
      }),
    fail: (reserved) =>
      dependencies.store.failDaytonaSandboxReservation(principal, {
        agentId: reserved.id,
        expectedGeneration: reserved.sandboxGeneration,
        expectedVersion: reserved.version,
      }),
    finishReset: (resetting) =>
      dependencies.store.finishDaytonaSandboxReset(principal, {
        agentId: resetting.id,
        expectedGeneration: resetting.sandboxGeneration,
        expectedVersion: resetting.version,
      }),
    markAmbiguous: (reserved) =>
      dependencies.store.markDaytonaSandboxReservationAmbiguous(principal, {
        agentId: reserved.id,
        expectedGeneration: reserved.sandboxGeneration,
        expectedVersion: reserved.version,
      }),
    reserve: (agent) =>
      dependencies.store.reserveDaytonaSandbox(principal, {
        agentId: agent.id,
        expectedGeneration: agent.sandboxGeneration,
        expectedSandboxId: agent.daytonaSandboxId,
        expectedVersion: agent.version,
        provisioningStaleBefore: new Date(
          Date.now() - SANDBOX_PROVISIONING_TIMEOUT_MS
        ),
      }),
  };
}

async function persistSandbox(
  reserved: RunnerAgentRecord,
  sandbox: Sandbox,
  persistence: DaytonaSandboxPersistence,
  created: boolean
): Promise<RunnerAgentRecord> {
  let attached: Awaited<ReturnType<DaytonaSandboxPersistence["attach"]>>;
  try {
    attached = await persistence.attach(reserved, sandbox.id);
  } catch (error) {
    if (created) {
      throw new DaytonaSandboxLifecycleError(
        "Daytona sandbox ownership could not be persisted; cleanup is required before retry.",
        { cause: error, kind: "cleanup_needed", retryable: true }
      );
    }
    throw error;
  }
  if (attached.kind === "updated") {
    return attached.value;
  }

  throw new DaytonaSandboxLifecycleError(
    "Daytona sandbox generation changed before it could be stored; the deterministic sandbox remains intact for its current owner.",
    { retryable: true }
  );
}

async function createSandbox(
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies,
  persistence: DaytonaSandboxPersistence
): Promise<{ agent: RunnerAgentRecord; sandbox: Sandbox }> {
  const reserved = await persistence.reserve(agent);
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
  if (lifecycleAborted(dependencies.lifecycle)) {
    await failSandboxReservation(reserved.value, persistence);
    throw transitionAbortedError();
  }

  let sandbox: Sandbox;
  let created = false;
  try {
    sandbox = await withLifecycleAbort(
      () =>
        dependencies.daytona.get(
          daytonaSandboxName(reserved.value.tenant, reserved.value.id)
        ),
      dependencies.lifecycle
    );
  } catch (error) {
    if (
      error instanceof DaytonaSandboxLifecycleError &&
      lifecycleAborted(dependencies.lifecycle)
    ) {
      await failSandboxReservation(reserved.value, persistence);
      throw error;
    }
    if (classifyDaytonaProviderError(error) !== "not_found") {
      await failSandboxReservation(reserved.value, persistence);
      throw error;
    }
    try {
      sandbox = await withLifecycleAbort(
        () =>
          dependencies.daytona.create(
            sandboxCreateParameters(reserved.value, configuration),
            { timeout: providerTimeoutSeconds(dependencies.lifecycle) }
          ),
        dependencies.lifecycle
      );
      created = true;
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "create",
        outcome: "created",
      });
    } catch (createError) {
      if (
        createError instanceof DaytonaSandboxLifecycleError &&
        lifecycleAborted(dependencies.lifecycle)
      ) {
        return markSandboxReservationAmbiguous(
          reserved.value,
          persistence,
          createError
        );
      }
      const createOutcome = classifyDaytonaSandboxCreateError(createError);
      observeRunnerResourceOperation(dependencies.observe, {
        operation: "create",
        outcome:
          createOutcome === "definite_rejection"
            ? "provider_rejected"
            : "ambiguous",
        ...runnerResourceProviderSignal(createError),
      });
      if (createOutcome === "definite_rejection") {
        await failSandboxReservation(reserved.value, persistence);
        throw createError;
      }
      return markSandboxReservationAmbiguous(
        reserved.value,
        persistence,
        createError
      );
    }
  }
  if (
    !created &&
    !daytonaSandboxProvisioningIdentityMatches(
      sandbox,
      reserved.value,
      configuration
    )
  ) {
    return resetMismatchedSandboxAndReprovision(
      reserved.value,
      sandbox,
      configuration,
      dependencies,
      persistence
    );
  }

  if (lifecycleAborted(dependencies.lifecycle)) {
    if (created) {
      return markSandboxReservationAmbiguous(
        reserved.value,
        persistence,
        transitionAbortedError()
      );
    }

    await failSandboxReservation(reserved.value, persistence);
    throw transitionAbortedError();
  }

  async function markSandboxReservationAmbiguous(
    reservation: RunnerAgentRecord,
    store: DaytonaSandboxPersistence,
    cause: unknown
  ): Promise<never> {
    try {
      const marked = await store.markAmbiguous(reservation);
      if (marked.kind === "updated") {
        throw new DaytonaSandboxLifecycleError(
          "Daytona sandbox creation outcome is ambiguous; cleanup reconciliation is required before retry.",
          { cause, kind: "cleanup_needed", retryable: true }
        );
      }
    } catch (error) {
      if (error instanceof DaytonaSandboxLifecycleError) {
        throw error;
      }
    }
    throw new DaytonaSandboxLifecycleError(
      "Daytona sandbox creation outcome is ambiguous; cleanup reconciliation is required before retry.",
      { cause, kind: "cleanup_needed", retryable: true }
    );
  }

  const persisted = await persistSandbox(
    reserved.value,
    sandbox,
    persistence,
    created
  );
  throwIfTransitionAborted(dependencies.lifecycle);
  await startOrRecoverSandbox(sandbox, dependencies.lifecycle);
  return { agent: persisted, sandbox };
}

async function resetMismatchedSandboxAndReprovision(
  reserved: RunnerAgentRecord,
  sandbox: Sandbox,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies,
  persistence: DaytonaSandboxPersistence
): Promise<{ agent: RunnerAgentRecord; sandbox: Sandbox }> {
  // Before anything durable happens. `beginReset` commits the agent row to
  // `resetting`, and the recovery scanner deletes `resetting` sandboxes on the
  // next tick — so throwing after this line does not save the workspace, it
  // only postpones its destruction by one reconcile.
  await assertReplacementSnapshotReady(configuration, dependencies);
  const resetting = await persistence.beginReset(reserved);
  if (resetting.kind !== "updated") {
    throw new DaytonaSandboxLifecycleError(
      resetting.kind === "not_live"
        ? "Daytona sandbox is running an attempt and cannot be replaced yet."
        : "Daytona sandbox generation changed before stale cleanup.",
      { retryable: true }
    );
  }
  try {
    await deleteMismatchedSandbox(sandbox);
  } catch (error) {
    throw new DaytonaSandboxLifecycleError(
      "Daytona stale sandbox cleanup requires reconciliation.",
      {
        cause: error,
        kind: "cleanup_needed",
        retryable: classifyDaytonaProviderError(error) !== "non_retryable",
      }
    );
  }
  const reset = await persistence.finishReset(resetting.value);
  if (reset.kind !== "updated") {
    throw new DaytonaSandboxLifecycleError(
      "Daytona stale sandbox cleanup remains durably fenced.",
      { kind: "cleanup_needed", retryable: true }
    );
  }
  return createSandbox(reset.value, configuration, dependencies, persistence);
}

async function failSandboxReservation(
  reserved: RunnerAgentRecord,
  persistence: DaytonaSandboxPersistence
): Promise<void> {
  const failed = await persistence.fail(reserved);
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
): Promise<"deleted" | "provider_not_found"> {
  const [identifier, ...remaining] = identifiers;
  if (!identifier) {
    return "provider_not_found";
  }
  let sandbox: Sandbox;
  try {
    sandbox = await dependencies.daytona.get(identifier);
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      throw error;
    }
    return await deleteFirstDaytonaSandbox(remaining, dependencies);
  }
  try {
    await sandbox.delete(SANDBOX_OPERATION_TIMEOUT_SECONDS, true);
    return "deleted";
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      throw error;
    }
    return "provider_not_found";
  }
}

/**
 * An exact cancellation, terminal, or command-free attempt cleanup can require
 * deleting its persistent sandbox. Reserve a distinct lifecycle state first so
 * no dispatch can attach a new process while Daytona deletion is in flight;
 * only confirmed deletion clears the next sandbox generation.
 */
export async function resetDaytonaSandboxForCancellation(
  operator: RunnerOperator,
  authority: RunnerDispatchAuthority,
  dependencies: DaytonaSandboxDependencies
): Promise<
  | { kind: "reset" | "provider_not_found" }
  | {
      kind:
        | "in_progress"
        | "not_found"
        | "sandbox_reset_required"
        | "stale_version";
    }
  | { kind: "unavailable"; source: "database" | "provider" }
> {
  let reserved: Awaited<
    ReturnType<RunnerStore["beginDaytonaSandboxResetForCancellation"]>
  >;
  try {
    reserved = await dependencies.store.beginDaytonaSandboxResetForCancellation(
      operator,
      authority
    );
  } catch {
    return { kind: "unavailable", source: "database" };
  }
  if (reserved.kind !== "resetting") {
    switch (reserved.kind) {
      case "in_progress":
      case "not_found":
      case "stale_version":
        return { kind: reserved.kind };
      case "lease_lost":
      case "not_live":
        return { kind: "stale_version" };
      default:
        return reserved;
    }
  }
  const agent = reserved.value;
  let deleted: "deleted" | "provider_not_found";
  try {
    deleted = await deleteFirstDaytonaSandbox(
      [
        ...(agent.daytonaSandboxId ? [agent.daytonaSandboxId] : []),
        daytonaSandboxName(agent.tenant, agent.id),
      ],
      dependencies
    );
  } catch (error) {
    return classifyDaytonaProviderError(error) === "retryable"
      ? { kind: "unavailable", source: "provider" }
      : { kind: "sandbox_reset_required" };
  }
  let cleared: Awaited<
    ReturnType<RunnerStore["finishDaytonaSandboxResetForRecovery"]>
  >;
  try {
    cleared = await dependencies.store.finishDaytonaSandboxResetForRecovery(
      operator,
      {
        agentId: agent.id,
        expectedGeneration: agent.sandboxGeneration,
        expectedVersion: agent.version,
      }
    );
  } catch {
    return { kind: "unavailable", source: "database" };
  }
  return cleared.kind === "updated"
    ? { kind: deleted === "deleted" ? "reset" : "provider_not_found" }
    : { kind: cleared.kind };
}

async function reconcileAmbiguousDaytonaSandbox(
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies,
  persistence: DaytonaSandboxPersistence
): Promise<{ agent: RunnerAgentRecord; sandbox: Sandbox }> {
  try {
    const sandbox = await withLifecycleAbort(
      () =>
        dependencies.daytona.get(daytonaSandboxName(agent.tenant, agent.id)),
      dependencies.lifecycle
    );
    if (
      !daytonaSandboxProvisioningIdentityMatches(sandbox, agent, configuration)
    ) {
      return resetMismatchedSandboxAndReprovision(
        agent,
        sandbox,
        configuration,
        dependencies,
        persistence
      );
    }
    const persisted = await persistSandbox(agent, sandbox, persistence, false);
    await startOrRecoverSandbox(sandbox, dependencies.lifecycle);
    return { agent: persisted, sandbox };
  } catch (error) {
    if (error instanceof DaytonaSandboxLifecycleError) {
      throw error;
    }
    throw new DaytonaSandboxLifecycleError(
      "Daytona sandbox creation remains ambiguous; cleanup reconciliation is required before retry.",
      { cause: error, kind: "cleanup_needed", retryable: true }
    );
  }
}

/**
 * Resolves the stored provider ID and only creates after the deterministic
 * sandbox name is confirmed absent.
 */
async function ensureDaytonaSandboxWithPersistence(
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies,
  persistence: DaytonaSandboxPersistence,
  replaceMismatchedConfiguration: boolean
): Promise<{ agent: RunnerAgentRecord; sandbox: Sandbox }> {
  if (
    agent.sandboxLifecycle === "resetting" ||
    agent.sandboxLifecycle === "decommissioning" ||
    agent.sandboxLifecycle === "decommission_failed"
  ) {
    throw new DaytonaSandboxLifecycleError(
      "Daytona sandbox is being decommissioned.",
      { retryable: true }
    );
  }
  if (agent.sandboxLifecycle === "provisioning_ambiguous") {
    const reconciled = await reconcileAmbiguousDaytonaSandbox(
      agent,
      configuration,
      dependencies,
      persistence
    );
    return reconciled;
  }
  if (agent.sandboxLifecycle === "provisioning" || !agent.daytonaSandboxId) {
    return createSandbox(agent, configuration, dependencies, persistence);
  }

  let sandbox: Sandbox;
  try {
    sandbox = await withLifecycleAbort(
      () => dependencies.daytona.get(agent.daytonaSandboxId as string),
      dependencies.lifecycle
    );
  } catch (error) {
    if (classifyDaytonaProviderError(error) !== "not_found") {
      throw error;
    }
    return createSandbox(agent, configuration, dependencies, persistence);
  }
  if (sandbox.state === SandboxState.DESTROYED) {
    return createSandbox(agent, configuration, dependencies, persistence);
  }
  if (!sandboxConfigurationMatches(sandbox, configuration)) {
    if (!replaceMismatchedConfiguration) {
      throw new DaytonaSandboxLifecycleError(
        "Daytona sandbox configuration changed and requires reprovisioning.",
        { retryable: true }
      );
    }
    return resetMismatchedSandboxAndReprovision(
      agent,
      sandbox,
      configuration,
      dependencies,
      persistence
    );
  }
  await startOrRecoverSandbox(sandbox, dependencies.lifecycle);
  return { agent, sandbox };
}

/**
 * Subscriber-facing sandbox lifecycle for CRUD and prewarming. Dispatch work
 * must use ensureDaytonaSandboxForDispatch so ownership derives from its run.
 */
export function ensureDaytonaSandbox(
  principal: RunnerPrincipal,
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies
): Promise<{ agent: RunnerAgentRecord; sandbox: Sandbox }> {
  return ensureDaytonaSandboxWithPersistence(
    agent,
    configuration,
    dependencies,
    subscriberSandboxPersistence(principal, dependencies),
    /**
     * Prewarm replaces a sandbox whose configuration no longer matches, the
     * same as dispatch does. It is safe here because the subscriber reset
     * refuses while an attempt is live; before that guard existed this had to
     * be false, which left a drifted agent raising a retryable error on every
     * prewarm and never repairing itself.
     */
    true
  );
}

/**
 * Resolves and provisions a run's agent through the dispatch lease, never
 * through a subscriber identity. It shares the lifecycle implementation with
 * prewarming, while all ownership is derived by the store from the locked run.
 */
export async function ensureDaytonaSandboxForDispatch(
  operator: RunnerOperator,
  authority: RunnerDispatchAuthority,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxDependencies
): Promise<{ agent: RunnerAgentRecord; sandbox: Sandbox }> {
  const associated = await dependencies.store.getDispatchAgent(
    operator,
    authority
  );
  if (associated.kind !== "found") {
    throw new DaytonaSandboxLifecycleError(
      "Daytona dispatch is no longer live.",
      { retryable: true }
    );
  }
  return ensureDaytonaSandboxWithPersistence(
    associated.agent,
    configuration,
    dependencies,
    {
      attach: async (reserved, sandboxId) => {
        const result = await dependencies.store.attachDaytonaSandboxForDispatch(
          operator,
          authority,
          {
            expectedGeneration: reserved.sandboxGeneration,
            expectedVersion: reserved.version,
            sandboxId,
          }
        );
        return result.kind === "updated"
          ? result
          : {
              kind:
                result.kind === "not_live"
                  ? ("stale_version" as const)
                  : result.kind,
            };
      },
      beginReset: async (reserved) => {
        const result =
          await dependencies.store.beginDaytonaSandboxResetForDispatch(
            operator,
            authority,
            {
              agentId: reserved.id,
              expectedGeneration: reserved.sandboxGeneration,
              expectedVersion: reserved.version,
            }
          );
        return result.kind === "updated"
          ? result
          : {
              kind:
                result.kind === "not_live"
                  ? ("stale_version" as const)
                  : result.kind,
            };
      },
      fail: async (reserved) => {
        const result =
          await dependencies.store.failDaytonaSandboxReservationForDispatch(
            operator,
            authority,
            {
              expectedGeneration: reserved.sandboxGeneration,
              expectedVersion: reserved.version,
            }
          );
        return result.kind === "not_live"
          ? { kind: "stale_version" as const }
          : result;
      },
      finishReset: async (resetting) => {
        const result =
          await dependencies.store.finishDaytonaSandboxResetForDispatch(
            operator,
            authority,
            {
              agentId: resetting.id,
              expectedGeneration: resetting.sandboxGeneration,
              expectedVersion: resetting.version,
            }
          );
        return result.kind === "updated"
          ? result
          : {
              kind:
                result.kind === "not_live"
                  ? ("stale_version" as const)
                  : result.kind,
            };
      },
      markAmbiguous: async (reserved) => {
        const result =
          await dependencies.store.markDaytonaSandboxReservationAmbiguousForDispatch(
            operator,
            authority,
            {
              expectedGeneration: reserved.sandboxGeneration,
              expectedVersion: reserved.version,
            }
          );
        return result.kind === "not_live"
          ? { kind: "stale_version" as const }
          : result;
      },
      reserve: async () => {
        const result =
          await dependencies.store.reserveDaytonaSandboxForDispatch(
            operator,
            authority,
            {
              provisioningStaleBefore: new Date(
                Date.now() - SANDBOX_PROVISIONING_TIMEOUT_MS
              ),
            }
          );
        return result.kind === "not_live"
          ? { kind: "stale_version" as const }
          : result;
      },
    },
    true
  );
}

export async function warmDaytonaSandbox(
  principal: RunnerPrincipal,
  agent: RunnerAgentRecord,
  configuration: DaytonaSandboxConfiguration,
  dependencies: DaytonaSandboxWarmDependencies
): Promise<
  | { kind: "ready"; agent: RunnerAgentRecord; sandbox: Sandbox }
  | { kind: "in_progress"; agent: RunnerAgentRecord }
  | { kind: "not_found" | "stale_version" }
  | { kind: "unavailable"; source: "database" }
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
    return error instanceof DaytonaError ||
      error instanceof DaytonaSandboxLifecycleError
      ? { error: classifyDaytonaProviderError(error), kind: "failed" }
      : { kind: "unavailable", source: "database" };
  }
  if (lifecycleAborted(dependencies.lifecycle)) {
    return { error: "retryable", kind: "failed" };
  }

  const warm = await dependencies.store.beginDaytonaSandboxWarm(principal, {
    agentId: ensured.agent.id,
    expectedGeneration: ensured.agent.sandboxGeneration,
    expectedVersion: ensured.agent.version,
  });
  if (warm.kind === "in_progress") {
    return { agent: warm.value, kind: "in_progress" };
  }
  if (warm.kind === "not_found" || warm.kind === "stale_version") {
    return warm;
  }
  const probeSessionId = daytonaProbeSessionName(
    warm.value.id,
    warm.value.sandboxGeneration,
    warm.value.warmAttemptVersion,
    warm.value.warmUpdatedAt
  );

  const finishFailedWarm = () =>
    dependencies.store.finishDaytonaSandboxWarm(principal, {
      agentId: warm.value.id,
      expectedGeneration: warm.value.sandboxGeneration,
      expectedVersion: warm.value.version,
      status: "failed",
    });
  const settleFailedWarm = () =>
    settleCleanupWithinLifecycle(finishFailedWarm(), dependencies.lifecycle);

  if (lifecycleAborted(dependencies.lifecycle)) {
    await settleFailedWarm();
    return { error: "retryable", kind: "failed" };
  }

  try {
    await dependencies.probe(
      ensured.sandbox,
      dependencies.lifecycle?.signal,
      providerTimeoutSeconds(dependencies.lifecycle),
      probeSessionId
    );
  } catch (error) {
    if (isProbeCleanupPending(error)) {
      return { agent: warm.value, kind: "in_progress" };
    }
    const failed = await settleFailedWarm();
    if (
      failed.kind === "settled" &&
      (failed.value.kind === "not_found" ||
        failed.value.kind === "stale_version")
    ) {
      return failed.value;
    }
    return {
      error: lifecycleAborted(dependencies.lifecycle)
        ? "retryable"
        : classifyDaytonaProviderError(error),
      kind: "failed",
    };
  }
  if (lifecycleAborted(dependencies.lifecycle)) {
    await settleFailedWarm();
    return { error: "retryable", kind: "failed" };
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
  if (finished.kind === "not_found" || finished.kind === "stale_version") {
    return finished;
  }
  return { agent: finished.value, kind: "ready", sandbox: ensured.sandbox };
}

/**
 * Fences the durable row before asking Daytona to delete and removes the row
 * only after Daytona confirms deletion. Provider 404/410 means a known
 * sandbox is already gone; ambiguous creations must reconcile separately.
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
  if (decommission.kind === "cleanup_required") {
    try {
      const sandbox = await dependencies.daytona.get(
        daytonaSandboxName(decommission.value.tenant, decommission.value.id)
      );
      const attached = await dependencies.store.attachDaytonaSandbox(
        principal,
        {
          agentId: decommission.value.id,
          expectedGeneration: decommission.value.sandboxGeneration,
          expectedVersion: decommission.value.version,
          sandboxId: sandbox.id,
        }
      );
      if (attached.kind !== "updated") {
        return { error: "retryable", kind: "failed" };
      }
    } catch {
      return { error: "retryable", kind: "failed" };
    }
    return deleteDaytonaSandbox(principal, agentId, dependencies);
  }
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
