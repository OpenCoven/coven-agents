import "server-only";

import { randomBytes } from "node:crypto";
import type { RunSnapshot } from "@opencoven/agent-contracts";
import {
  isRunnableHarness,
  UNSUPPORTED_HARNESS_RUN_ERROR,
} from "@opencoven/harness";
import {
  acquireRunnerCredential,
  type RunnerCredentialAcquireInput,
  type RunnerCredentialAcquireResult,
  type RunnerCredentialDependencies,
} from "@/lib/credentials/runner-credential";
import {
  type RunnerAttemptRedactionEnvelope,
  sealRunnerAttemptRedactionFromEnvironment,
} from "./attempt-redaction";
import { daytonaDispatchAuthorizers } from "./daytona/dispatch";
import {
  DaytonaProcessError,
  type DaytonaProcessSandbox,
  type DaytonaStartedProcess,
  inspectRestrictedWorkspace,
  type RestrictedWorkspaceInspection,
  startDaytonaProcess,
} from "./daytona/process";
import {
  type DaytonaSandboxConfiguration,
  type DaytonaSandboxDependencies,
  ensureDaytonaSandboxForDispatch,
} from "./daytona/sandbox";
import type { RunnerStore } from "./store";
import {
  DEFAULT_RUNNER_ADMISSION_LIMITS,
  type RunnerAdmissionLimits,
  type RunnerAgentRecord,
  type RunnerClaimedDispatch,
  type RunnerDispatchAuthority,
  type RunnerOperator,
  type RunnerPrincipal,
  type RunnerRunRecord,
  type StartRunnerRunInput,
} from "./types";

export {
  DEFAULT_RUNNER_ADMISSION_LIMITS,
  type RunnerAdmissionLimits,
} from "./types";

export type RunnerAdmissionEnvironment = Readonly<{
  RUN_ADMISSION_CONSECUTIVE_MAX?: string;
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX?: string;
  RUN_ADMISSION_MODE?: string;
  RUN_ADMISSION_TENANT_ACTIVE_MAX?: string;
  RUN_ADMISSION_TENANT_QUEUE_MAX?: string;
}>;

export class RunnerAdmissionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerAdmissionConfigurationError";
  }
}

export type RunnerAdmissionErrorCode =
  | "admission_unavailable"
  | "agent_not_found"
  | "global_busy"
  | "operation_conflict"
  | "sandbox_trust_conflict"
  | "sandbox_unavailable"
  | "tenant_queue_full";

/**
 * Typed, transport-neutral admission error. Routes decide whether an outcome
 * becomes a 409, 429, or 503 response; this layer never does.
 */
export class RunnerAdmissionError extends Error {
  readonly code: RunnerAdmissionErrorCode;
  readonly retryable: boolean;

  constructor(
    code: RunnerAdmissionErrorCode,
    message: string,
    retryable: boolean
  ) {
    super(message);
    this.name = "RunnerAdmissionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export const DEFAULT_DISPATCH_LEASE_MS = 60_000;
const MAX_DISPATCH_LEASE_MS = 5 * 60_000;
const MIN_DISPATCH_LEASE_MS = 1000;

type AdmissionStore = Pick<RunnerStore, "startRun">;
type DispatchStore = Pick<
  RunnerStore,
  | "authorizeDaytonaLaunch"
  | "authorizeDaytonaPreparation"
  | "authorizeUnrestrictedExecution"
  | "claimNextDispatch"
  | "getDispatchAgent"
  | "markDispatchRunningForDispatch"
  | "persistAttemptRedaction"
  | "deleteAttemptRedaction"
  | "releaseDaytonaPreparation"
  | "releaseUnstartedDispatch"
> &
  Partial<Pick<RunnerStore, "cleanupTerminalLease" | "finalizeRun">>;

export type RunnerAdmissionDependencies = Readonly<{
  clock?: () => Date;
  dispatchLeaseMs?: number;
  limits?: RunnerAdmissionLimits;
  randomToken?: () => string;
  store: AdmissionStore;
}>;

export type AdmitRunnerRunInput = Omit<
  StartRunnerRunInput,
  "admission" | "initialDispatch"
> &
  Readonly<{ principal: RunnerPrincipal }>;

export type AdmitRunnerRunResult =
  | { claimed: RunnerClaimedDispatch; kind: "claimed"; run: RunSnapshot }
  | { kind: "created" | "duplicate"; run: RunSnapshot }
  | { error: RunnerAdmissionError; kind: "refused" };

export type RunnerDispatchResult =
  | { kind: "idle" }
  | { kind: "started"; runId: string }
  | { kind: "unavailable"; reason: "admission_unavailable" }
  | {
      kind: "retained";
      reason:
        | "attached_accounting_pending"
        | "cleanup_pending"
        | "launch_fenced";
      runId: string;
    }
  | {
      kind: "retryable";
      reason:
        | "credential_unavailable"
        | "dispatch_failed"
        | "sandbox_unavailable";
      runId: string;
    }
  | {
      kind: "refused";
      reason: "authority" | "capacity" | "credential" | "harness" | "workspace";
      runId: string;
    };

export type RunnerDispatchDependencies = Readonly<{
  acquireCredential: (
    input: RunnerCredentialAcquireInput
  ) => Promise<RunnerCredentialAcquireResult>;
  clock?: () => Date;
  credentialInput: (
    run: RunnerRunRecord,
    agent: RunnerAgentRecord
  ) => RunnerCredentialAcquireInput;
  dispatchLeaseMs?: number;
  ensureSandbox: (
    authority: RunnerDispatchAuthority
  ) => Promise<{ agent: RunnerAgentRecord; sandbox: DaytonaProcessSandbox }>;
  inspectRestrictedWorkspace?: (
    sandbox: DaytonaProcessSandbox,
    workspace: string
  ) => Promise<RestrictedWorkspaceInspection>;
  limits: RunnerAdmissionLimits;
  operator: RunnerOperator;
  randomToken?: () => string;
  sealAttemptRedaction?: (input: {
    attemptId: string;
    credential: string;
    runId: string;
    tenant: string;
  }) => Promise<RunnerAttemptRedactionEnvelope>;
  startProcess?: (
    input: Parameters<typeof startDaytonaProcess>[0]
  ) => Promise<DaytonaStartedProcess>;
  store: DispatchStore;
}>;

export type DaytonaRunnerDispatchDependencies = Omit<
  RunnerDispatchDependencies,
  "acquireCredential" | "ensureSandbox" | "store"
> &
  Readonly<{
    credentialDependencies: RunnerCredentialDependencies;
    sandboxConfiguration: DaytonaSandboxConfiguration;
    sandboxDependencies: Omit<DaytonaSandboxDependencies, "store">;
    store: RunnerStore;
  }>;

/**
 * Production composition for the injectable dispatcher. The lower-level
 * service remains testable without a Daytona SDK or database, while this
 * adapter guarantees dispatch uses the run-fenced sandbox lifecycle.
 */
export function daytonaRunnerDispatchDependencies(
  dependencies: DaytonaRunnerDispatchDependencies
): RunnerDispatchDependencies {
  return {
    ...dependencies,
    acquireCredential: (input) =>
      acquireRunnerCredential(input, dependencies.credentialDependencies),
    ensureSandbox: async (authority) => {
      const ensured = await ensureDaytonaSandboxForDispatch(
        dependencies.operator,
        authority,
        dependencies.sandboxConfiguration,
        { ...dependencies.sandboxDependencies, store: dependencies.store }
      );
      return {
        agent: ensured.agent,
        sandbox: ensured.sandbox as unknown as DaytonaProcessSandbox,
      };
    },
  };
}

function configuredLimit(
  environment: RunnerAdmissionEnvironment,
  name:
    | "RUN_ADMISSION_CONSECUTIVE_MAX"
    | "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX"
    | "RUN_ADMISSION_TENANT_ACTIVE_MAX"
    | "RUN_ADMISSION_TENANT_QUEUE_MAX",
  fallback: number
): number {
  const raw = environment[name]?.trim();
  if (!raw) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new RunnerAdmissionConfigurationError(
      `${name} must be a non-negative safe integer no greater than ${fallback}.`
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > fallback) {
    throw new RunnerAdmissionConfigurationError(
      `${name} must be a non-negative safe integer no greater than ${fallback}.`
    );
  }
  return value;
}

/**
 * The runtime validator and the admission service intentionally share these
 * bounded defaults. A value of zero means zero capacity, not "unlimited".
 */
export function admissionLimitsFromEnvironment(
  environment: RunnerAdmissionEnvironment = process.env as RunnerAdmissionEnvironment
): RunnerAdmissionLimits {
  const mode = environment.RUN_ADMISSION_MODE?.trim();
  if (mode && mode !== "queue") {
    throw new RunnerAdmissionConfigurationError(
      'RUN_ADMISSION_MODE must be "queue" when set.'
    );
  }
  return {
    consecutiveDispatches: configuredLimit(
      environment,
      "RUN_ADMISSION_CONSECUTIVE_MAX",
      DEFAULT_RUNNER_ADMISSION_LIMITS.consecutiveDispatches
    ),
    deploymentActiveRuns: configuredLimit(
      environment,
      "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX",
      DEFAULT_RUNNER_ADMISSION_LIMITS.deploymentActiveRuns
    ),
    tenantActiveRuns: configuredLimit(
      environment,
      "RUN_ADMISSION_TENANT_ACTIVE_MAX",
      DEFAULT_RUNNER_ADMISSION_LIMITS.tenantActiveRuns
    ),
    tenantQueuedRuns: configuredLimit(
      environment,
      "RUN_ADMISSION_TENANT_QUEUE_MAX",
      DEFAULT_RUNNER_ADMISSION_LIMITS.tenantQueuedRuns
    ),
  };
}

function dispatchLease(
  clock: () => Date,
  randomToken: () => string,
  dispatchLeaseMs = DEFAULT_DISPATCH_LEASE_MS
): { leaseExpiresAt: Date; leaseToken: string } {
  if (
    !Number.isSafeInteger(dispatchLeaseMs) ||
    dispatchLeaseMs < MIN_DISPATCH_LEASE_MS ||
    dispatchLeaseMs > MAX_DISPATCH_LEASE_MS
  ) {
    throw new RunnerAdmissionConfigurationError(
      `Dispatch lease duration must be an integer between ${MIN_DISPATCH_LEASE_MS} and ${MAX_DISPATCH_LEASE_MS} milliseconds.`
    );
  }
  const leaseToken = randomToken();
  if (!leaseToken || leaseToken.length > 80 || /\p{Cc}/u.test(leaseToken)) {
    throw new RunnerAdmissionConfigurationError(
      "Dispatch lease token generator returned an invalid value."
    );
  }
  const now = clock();
  if (Number.isNaN(now.valueOf())) {
    throw new RunnerAdmissionConfigurationError(
      "Dispatch clock returned an invalid timestamp."
    );
  }
  return {
    leaseExpiresAt: new Date(now.getTime() + dispatchLeaseMs),
    leaseToken,
  };
}

function secureDispatchToken(): string {
  return randomBytes(32).toString("base64url");
}

function configuredDependencies(
  dependencies: Pick<
    RunnerAdmissionDependencies | RunnerDispatchDependencies,
    "clock" | "dispatchLeaseMs" | "randomToken"
  >
) {
  return {
    clock: dependencies.clock ?? (() => new Date()),
    dispatchLeaseMs: dependencies.dispatchLeaseMs,
    randomToken: dependencies.randomToken ?? secureDispatchToken,
  };
}

/** Inserts a queue-only run and preserves the immutable operation binding. */
export async function admitRunnerRun(
  input: AdmitRunnerRunInput,
  dependencies: RunnerAdmissionDependencies
): Promise<AdmitRunnerRunResult> {
  const { clock, dispatchLeaseMs, randomToken } =
    configuredDependencies(dependencies);
  const limits =
    dependencies.limits ??
    admissionLimitsFromEnvironment(process.env as RunnerAdmissionEnvironment);
  const initialDispatch =
    limits.tenantQueuedRuns === 0
      ? dispatchLease(clock, randomToken, dispatchLeaseMs)
      : undefined;
  let result: Awaited<ReturnType<AdmissionStore["startRun"]>>;
  try {
    result = await dependencies.store.startRun(input.principal, {
      admission: limits,
      agentId: input.agentId,
      ...(input.agentSnapshot ? { agentSnapshot: input.agentSnapshot } : {}),
      authVersion: input.authVersion,
      executionPermission: input.executionPermission ?? "unrestricted",
      id: input.id,
      ...(initialDispatch ? { initialDispatch } : {}),
      operationId: input.operationId,
      requestHash: input.requestHash,
      task: input.task,
    });
  } catch {
    return {
      error: new RunnerAdmissionError(
        "admission_unavailable",
        "Runner admission is temporarily unavailable.",
        true
      ),
      kind: "refused",
    };
  }

  switch (result.kind) {
    case "claimed":
      return { claimed: result.claimed, kind: "claimed", run: result.run };
    case "created":
    case "duplicate":
      return result;
    case "conflict":
      return {
        error: new RunnerAdmissionError(
          "operation_conflict",
          "The operation identifier is already bound to a different request.",
          false
        ),
        kind: "refused",
      };
    case "sandbox_trust_conflict":
      return {
        error: new RunnerAdmissionError(
          "sandbox_trust_conflict",
          "Restricted execution requires a sandbox with no unrestricted run history.",
          false
        ),
        kind: "refused",
      };
    case "refused":
      return {
        error: new RunnerAdmissionError(
          result.reason,
          result.reason === "tenant_queue_full"
            ? "The tenant queue is full."
            : "Runner capacity is currently full.",
          true
        ),
        kind: "refused",
      };
    case "not_found":
      return {
        error: new RunnerAdmissionError(
          "agent_not_found",
          "The requested runner agent was not found.",
          false
        ),
        kind: "refused",
      };
    case "sandbox_unavailable":
      return {
        error: new RunnerAdmissionError(
          "sandbox_unavailable",
          "The runner sandbox is temporarily unavailable.",
          true
        ),
        kind: "refused",
      };
    default:
      return {
        error: new RunnerAdmissionError(
          "global_busy",
          "Runner admission is unavailable.",
          true
        ),
        kind: "refused",
      };
  }
}

async function releaseUnstarted(
  dependencies: RunnerDispatchDependencies,
  authority: RunnerDispatchAuthority
): Promise<boolean> {
  try {
    return (
      (
        await dependencies.store.releaseUnstartedDispatch(
          dependencies.operator,
          authority
        )
      ).kind === "released"
    );
  } catch {
    return false;
  }
}

export async function terminalizeUnstartedDispatchFailure(
  dependencies: Readonly<{
    clock?: () => Date;
    operator: RunnerOperator;
    store: Partial<Pick<RunnerStore, "cleanupTerminalLease" | "finalizeRun">>;
  }>,
  authority: RunnerDispatchAuthority,
  run: RunnerRunRecord,
  code:
    | "authority_revoked"
    | "capacity_refused"
    | "credential_unavailable"
    | "dispatch_failed"
    | "harness_unsupported"
    | "no_credential"
    | "sandbox_trust_conflict"
    | "workspace_configuration_unsafe"
    | "workspace_required",
  message: string,
  retryable: boolean
): Promise<boolean> {
  if (
    !dependencies.store.finalizeRun ||
    !dependencies.store.cleanupTerminalLease
  ) {
    return false;
  }
  try {
    const finalized = await dependencies.store.finalizeRun(
      dependencies.operator,
      {
        commandEvidence: [],
        completedAt: (dependencies.clock ?? (() => new Date()))(),
        error: { code, message, retryable },
        expectedVersion: authority.expectedVersion,
        fileEvidence: [],
        leaseToken: authority.leaseToken,
        output: "",
        runId: run.id,
        status: "failed",
      }
    );
    if (finalized.kind !== "finalized") {
      return false;
    }
    const cleaned = await dependencies.store.cleanupTerminalLease(
      dependencies.operator,
      {
        expectedVersion: finalized.run.version,
        leaseToken: authority.leaseToken,
        runId: run.id,
      } as RunnerDispatchAuthority
    );
    return cleaned.kind === "updated";
  } catch {
    return false;
  }
}

function cleanupMayRemain(error: unknown): boolean {
  return (
    error instanceof DaytonaProcessError &&
    (error.code === "durable_release_failed" ||
      error.code === "sandbox_reset_required")
  );
}

/**
 * Starts one already-claimed run. It holds no plaintext credential outside
 * the `startProcess` call and never converts provider errors into output.
 */
export async function dispatchRunnerClaim(
  claimed: RunnerClaimedDispatch,
  dependencies: RunnerDispatchDependencies
): Promise<RunnerDispatchResult> {
  const { authority, run } = claimed;
  const associated = await dependencies.store.getDispatchAgent(
    dependencies.operator,
    authority
  );
  if (associated.kind !== "found") {
    return { kind: "retained", reason: "launch_fenced", runId: run.id };
  }
  if (!isRunnableHarness(run.agentRuntime)) {
    return (await terminalizeUnstartedDispatchFailure(
      dependencies,
      authority,
      run,
      UNSUPPORTED_HARNESS_RUN_ERROR.code,
      UNSUPPORTED_HARNESS_RUN_ERROR.message,
      UNSUPPORTED_HARNESS_RUN_ERROR.retryable
    ))
      ? { kind: "refused", reason: "harness", runId: run.id }
      : { kind: "retained", reason: "cleanup_pending", runId: run.id };
  }
  if (
    run.executionPermission !== "unrestricted" &&
    !run.agentWorkspace?.trim()
  ) {
    return (await terminalizeUnstartedDispatchFailure(
      dependencies,
      authority,
      run,
      "workspace_required",
      "Restricted runner execution requires a workspace.",
      false
    ))
      ? { kind: "refused", reason: "workspace", runId: run.id }
      : { kind: "retained", reason: "cleanup_pending", runId: run.id };
  }

  let ensured: { agent: RunnerAgentRecord; sandbox: DaytonaProcessSandbox };
  try {
    ensured = await dependencies.ensureSandbox(authority);
  } catch {
    return (await releaseUnstarted(dependencies, authority))
      ? { kind: "retryable", reason: "sandbox_unavailable", runId: run.id }
      : { kind: "retained", reason: "cleanup_pending", runId: run.id };
  }
  if (
    run.executionPermission !== "unrestricted" &&
    ensured.agent.sandboxTrust === "unrestricted"
  ) {
    return (await terminalizeUnstartedDispatchFailure(
      dependencies,
      authority,
      run,
      "sandbox_trust_conflict",
      "Restricted runner execution requires a clean sandbox trust profile.",
      false
    ))
      ? { kind: "refused", reason: "workspace", runId: run.id }
      : { kind: "retained", reason: "cleanup_pending", runId: run.id };
  }
  if (
    run.executionPermission !== "unrestricted" &&
    ensured.agent.warmStatus === "provisioning"
  ) {
    return (await releaseUnstarted(dependencies, authority))
      ? { kind: "retryable", reason: "sandbox_unavailable", runId: run.id }
      : { kind: "retained", reason: "cleanup_pending", runId: run.id };
  }
  if (run.executionPermission !== "unrestricted") {
    const inspection = await (
      dependencies.inspectRestrictedWorkspace ?? inspectRestrictedWorkspace
    )(ensured.sandbox, run.agentWorkspace as string);
    if (inspection.kind === "unavailable") {
      return (await releaseUnstarted(dependencies, authority))
        ? { kind: "retryable", reason: "sandbox_unavailable", runId: run.id }
        : { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
    if (inspection.kind === "unsafe") {
      return (await terminalizeUnstartedDispatchFailure(
        dependencies,
        authority,
        run,
        "workspace_configuration_unsafe",
        "Restricted runner execution cannot load repository hooks or settings.",
        false
      ))
        ? { kind: "refused", reason: "workspace", runId: run.id }
        : { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
  }

  const credential = await dependencies.acquireCredential(
    dependencies.credentialInput(run, ensured.agent)
  );
  if (credential.kind !== "acquired") {
    if (credential.kind === "refused") {
      return (await terminalizeUnstartedDispatchFailure(
        dependencies,
        authority,
        run,
        "capacity_refused",
        "Run capacity was unavailable.",
        false
      ))
        ? {
            kind: "refused",
            reason: "capacity",
            runId: run.id,
          }
        : { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
    if (
      credential.kind === "already_consumed" ||
      credential.kind === "released"
    ) {
      return (await terminalizeUnstartedDispatchFailure(
        dependencies,
        authority,
        run,
        "credential_unavailable",
        "Runner credential capacity is no longer available.",
        false
      ))
        ? {
            kind: "refused",
            reason: "credential",
            runId: run.id,
          }
        : { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
    if (credential.kind === "reservation_pending") {
      return (await releaseUnstarted(dependencies, authority))
        ? { kind: "retryable", reason: "credential_unavailable", runId: run.id }
        : { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
    if (credential.kind === "unavailable") {
      if (credential.error.code === "cleanup_pending") {
        return { kind: "retained", reason: "cleanup_pending", runId: run.id };
      }
      if (credential.error.code === "no_credential") {
        return (await terminalizeUnstartedDispatchFailure(
          dependencies,
          authority,
          run,
          "no_credential",
          "No credential is configured for this runner.",
          false
        ))
          ? { kind: "refused", reason: "credential", runId: run.id }
          : { kind: "retained", reason: "cleanup_pending", runId: run.id };
      }
      if (credential.error.code !== "capacity_unavailable") {
        return (await terminalizeUnstartedDispatchFailure(
          dependencies,
          authority,
          run,
          "credential_unavailable",
          "Runner credential could not be acquired.",
          credential.error.retryable
        ))
          ? { kind: "refused", reason: "credential", runId: run.id }
          : { kind: "retained", reason: "cleanup_pending", runId: run.id };
      }
      return (await releaseUnstarted(dependencies, authority))
        ? {
            kind: "retryable",
            reason: "credential_unavailable",
            runId: run.id,
          }
        : { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
    return (await releaseUnstarted(dependencies, authority))
      ? { kind: "retryable", reason: "credential_unavailable", runId: run.id }
      : { kind: "retained", reason: "cleanup_pending", runId: run.id };
  }

  try {
    await credential.acquisition.commit();
  } catch {
    try {
      await credential.acquisition.compensate();
    } catch {
      return { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
    return (await releaseUnstarted(dependencies, authority))
      ? { kind: "retryable", reason: "credential_unavailable", runId: run.id }
      : { kind: "retained", reason: "cleanup_pending", runId: run.id };
  }

  const callbacks = daytonaDispatchAuthorizers(
    dependencies.store,
    dependencies.operator,
    authority
  );
  let started: DaytonaStartedProcess;
  try {
    started = await credential.acquisition.use((credentialAtBoundary) =>
      (dependencies.startProcess ?? startDaytonaProcess)({
        ...callbacks,
        credential: credentialAtBoundary,
        deleteAttemptRedaction: async () =>
          (
            await dependencies.store.deleteAttemptRedaction(
              dependencies.operator,
              callbacks.currentAuthority()
            )
          ).kind === "deleted",
        executionPermission: run.executionPermission,
        instructions: run.agentInstructions,
        model: run.agentModel,
        persistAttemptRedaction: async ({
          attemptId,
          credential: credentialForRedaction,
          runId,
        }) => {
          const envelope = await (
            dependencies.sealAttemptRedaction ??
            sealRunnerAttemptRedactionFromEnvironment
          )({
            attemptId,
            credential: credentialForRedaction,
            runId,
            tenant: run.tenant,
          });
          return (
            (
              await dependencies.store.persistAttemptRedaction(
                dependencies.operator,
                callbacks.currentAuthority(),
                { ...envelope, attemptId }
              )
            ).kind === "persisted"
          );
        },
        runId: run.id,
        runtime: run.agentRuntime,
        sandbox: ensured.sandbox,
        task: run.task,
        workspace: run.agentWorkspace ?? undefined,
      })
    );
  } catch (error) {
    if (cleanupMayRemain(error)) {
      return { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
    try {
      await credential.acquisition.compensate();
    } catch {
      return { kind: "retained", reason: "cleanup_pending", runId: run.id };
    }
    const cleanupAuthority = callbacks.currentAuthority();
    return (await terminalizeUnstartedDispatchFailure(
      dependencies,
      cleanupAuthority,
      run,
      "dispatch_failed",
      "Runner process could not be started.",
      true
    ))
      ? { kind: "retryable", reason: "dispatch_failed", runId: run.id }
      : (await releaseUnstarted(dependencies, cleanupAuthority))
        ? { kind: "retryable", reason: "dispatch_failed", runId: run.id }
        : { kind: "retained", reason: "cleanup_pending", runId: run.id };
  }

  try {
    const marked = await dependencies.store.markDispatchRunningForDispatch(
      dependencies.operator,
      started.dispatchAuthority
    );
    return marked.kind === "updated"
      ? { kind: "started", runId: run.id }
      : { kind: "retained", reason: "launch_fenced", runId: run.id };
  } catch {
    return { kind: "retained", reason: "launch_fenced", runId: run.id };
  }
}

/** Claims and starts at most one fair, capacity-bounded queued run. */
export async function dispatchNextRunnerRun(
  dependencies: RunnerDispatchDependencies
): Promise<RunnerDispatchResult> {
  const { clock, dispatchLeaseMs, randomToken } =
    configuredDependencies(dependencies);
  let claimed: RunnerClaimedDispatch | null;
  try {
    claimed = await dependencies.store.claimNextDispatch(
      dependencies.operator,
      {
        ...dispatchLease(clock, randomToken, dispatchLeaseMs),
        limits: dependencies.limits,
      }
    );
  } catch {
    return { kind: "unavailable", reason: "admission_unavailable" };
  }
  return claimed
    ? await dispatchRunnerClaim(claimed, dependencies)
    : { kind: "idle" };
}
