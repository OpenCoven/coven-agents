import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  type AgentDefinition,
  agentIdSchema,
  createAgentInputSchema,
  importVerifyKeyRing,
  type RunnerClaims,
  type RunnerVerificationKeyRing,
  type RunSnapshot,
  sanitizeEvidenceText,
  startRunInputSchema,
  type WarmState,
} from "@opencoven/agent-contracts";
import { isRunnableHarness, SUPPORTED_HARNESS_IDS } from "@opencoven/harness";
import {
  enforceWorkerEdgeLimit,
  type WorkerAbuseDecision,
  workerRouteClass,
} from "./abuse.js";
import {
  type AdmissionDecision,
  type AdmissionRecord,
  type AdmissionRequest,
  AdmissionUnavailableError,
  admissionMode,
  tenantAdmissionHash,
} from "./admission.js";
import type { RunRegistrationResult } from "./agents.js";
import {
  corsHeaders,
  errorEnvelope,
  HttpError,
  hasValidHeaderToken,
  json,
  readJson,
} from "./http.js";
import { verifyRunnerToken } from "./identity.js";
import {
  type AdmissionCleanupCapability,
  type AdmissionCleanupGuard,
  type AdmissionConfirmationOutcome,
  AgentBusyError,
  AgentDecommissioningError,
  AlreadyRunningError,
  hashOperation,
  isTerminal,
  OperationConflictError,
  type PreparedAdmissionConfirmationOutcome,
} from "./run-state.js";
import {
  checkRunnerAuthority,
  type RunnerAuthorityResult,
} from "./runner-authority.js";
import {
  createRunEventStream,
  type RunEventStreamOptions,
  type RunEventStreamSnapshot,
} from "./sse.js";
import { tenantOf } from "./tenant.js";

type Awaitable<T> = T | Promise<T>;

export type CloudRunnerEnvironment = Omit<
  Pick<
    Env,
    | "AGENT_CONTROL_TOKEN"
    | "ALLOWED_ORIGIN"
    | "APP_ORIGIN"
    | "RUNNER_VERIFY_KEY"
    | "RUNNER_VERIFY_KEY_ID"
    | "RUNNER_SERVICE_TOKEN"
    | "RUNNER_VERIFY_PREVIOUS_KEY_ID"
    | "RUNNER_VERIFY_PREVIOUS_KEY"
    | "RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT"
    | "RUNNER_VERIFY_PREVIOUS_RETIRE_AT"
  >,
  "ALLOWED_ORIGIN"
> & {
  ALLOWED_ORIGIN: string;
  EDGE_ABUSE_KEY_SECRET?: string;
  RUN_ADMISSION_CONSECUTIVE_MAX?: string;
  RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX?: string;
  RUN_ADMISSION_MODE?: string;
  RUN_ADMISSION_TENANT_ACTIVE_MAX?: string;
  RUN_ADMISSION_TENANT_QUEUE_MAX?: string;
  EDGE_REQUEST_LIMITER: RateLimit;
  TENANT_MUTATION_LIMITER: RateLimit;
  TENANT_RUN_LIMITER: RateLimit;
};

/**
 * Importing an SPKI key on every request would be wasteful, but the cache is
 * keyed on the SPKI string itself rather than unconditionally reused: a
 * rotated key must be picked up immediately, not served stale until a
 * redeploy.
 */
let verifyKeyCache: {
  configKey: string;
  ring: RunnerVerificationKeyRing;
} | null = null;

async function getVerifyKeyRing(
  environment: CloudRunnerEnvironment
): Promise<RunnerVerificationKeyRing> {
  const currentPublicKey = environment.RUNNER_VERIFY_KEY?.trim()
    ? environment.RUNNER_VERIFY_KEY
    : undefined;
  if (!currentPublicKey) {
    throw new Error("Runner verify key is not configured.");
  }
  const optional = (value: string | undefined): string | undefined =>
    value?.trim() ? value : undefined;
  const config = {
    currentId: optional(environment.RUNNER_VERIFY_KEY_ID) ?? "legacy",
    currentPublicKey,
    previousId: optional(environment.RUNNER_VERIFY_PREVIOUS_KEY_ID),
    previousLastSignedAt: optional(
      environment.RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT
    ),
    previousPublicKey: optional(environment.RUNNER_VERIFY_PREVIOUS_KEY),
    previousRetireAt: optional(environment.RUNNER_VERIFY_PREVIOUS_RETIRE_AT),
  };
  const configKey = JSON.stringify(config);
  if (verifyKeyCache?.configKey === configKey) {
    return verifyKeyCache.ring;
  }
  const ring = await importVerifyKeyRing(config);
  verifyKeyCache = { configKey, ring };
  return ring;
}

export type CloudRunnerDirectory = {
  /**
   * Takes the tenant rather than filtering at the call site, so a listing can
   * never be assembled without one. An accidental `list()` is a type error.
   */
  list: (tenantId: string) => Awaitable<AgentDefinition[]>;
  registerRun: (
    runId: string,
    agentId: string,
    status?: "active" | "queued" | "terminal"
  ) => Awaitable<RunRegistrationResult | boolean>;
  unregisterRun: (
    runId: string,
    agentId: string,
    expectedSequence?: number
  ) => Awaitable<boolean | undefined>;
  markRunStatus?: (
    runId: string,
    agentId: string,
    status: "active" | "queued" | "terminal"
  ) => Awaitable<boolean | undefined>;
  enqueueRunMappingCleanup?: (
    runId: string,
    agentId: string,
    expectedSequence?: number
  ) => Awaitable<void>;
  remove: (agentId: string) => Awaitable<void>;
  upsert: (definition: AgentDefinition) => Awaitable<AgentDefinition>;
  lookupRun: (runId: string) => Awaitable<string | null>;
};

export type CloudRunnerAgent = {
  configure: (definition: AgentDefinition) => Awaitable<AgentDefinition>;
  confirmAdmission?: (
    runId: string,
    operationId: string,
    requestHash: string,
    capability?: AdmissionCleanupCapability | null
  ) => Awaitable<AdmissionConfirmationOutcome>;
  isAdmissionConfirmed?: (
    runId: string,
    prepareOwner: string
  ) => Awaitable<boolean>;
  ensurePendingAdmissionCleanup?: (runId: string) => Awaitable<boolean>;
  prepareOwnerMatches?: (
    runId: string,
    prepareOwner: string
  ) => Awaitable<boolean>;
  discardRun: (
    runId: string,
    prepareOwner?: string
  ) => Awaitable<boolean | undefined>;
  discardPreparedRun?: (
    runId: string,
    prepareOwner: string
  ) => Awaitable<boolean | "protected" | "confirmed">;
  decommission: () => Awaitable<void>;
  enqueue: (
    input: unknown,
    runId: string,
    requestHash: string,
    identityToken: string,
    allowQueued?: boolean
  ) => Awaitable<{
    created: boolean;
    prepareOwner?: string;
    scheduleFailed?: boolean;
    run: RunSnapshot;
  }>;
  getEventStream: (
    runId: string,
    lastEventId: number
  ) => Awaitable<RunEventStreamSnapshot | null>;
  getRun: (runId: string) => Awaitable<RunSnapshot | null>;
  listRuns: () => Awaitable<RunSnapshot[]>;
  snapshot: () => Awaitable<AgentDefinition | null>;
  warm: () => Awaitable<WarmState>;
  stop: (
    runId: string,
    dispatchToken?: string,
    reason?: string,
    guard?: AdmissionCleanupGuard
  ) => Awaitable<RunSnapshot | null>;
};

export type CloudRunnerAdmission = {
  admit: (input: AdmissionRequest) => Awaitable<AdmissionDecision>;
  getRecord?: (runId: string) => Awaitable<AdmissionRecord | null>;
  getByOperationId?: (operationId: string) => Awaitable<AdmissionRecord | null>;
  getCleanupCapability?: (
    runId: string,
    expected?: Pick<
      AdmissionCleanupCapability,
      "agentId" | "operationId" | "requestHash" | "runId"
    >
  ) => Awaitable<AdmissionCleanupCapability | null>;
  validateCleanup?: (
    capability: AdmissionCleanupCapability
  ) => Awaitable<boolean>;
  enqueueCleanup?: (
    agentId: string,
    runId: string,
    capability?: AdmissionCleanupCapability
  ) => Awaitable<void>;
  enqueueProvisionalCleanup?: (
    agentId: string,
    runId: string,
    prepareOwner: string,
    operationId?: string,
    requestHash?: string
  ) => Awaitable<void>;
  confirmPreparedAdmission?: (
    runId: string,
    prepareOwner: string | undefined,
    capability: AdmissionCleanupCapability
  ) => Awaitable<PreparedAdmissionConfirmationOutcome>;
  release: (
    runId: string,
    dispatchToken?: string,
    admissionSequence?: number
  ) => Awaitable<boolean>;
};

export type CloudRunnerDependencies<
  Environment extends CloudRunnerEnvironment,
> = {
  createEventStream?: (
    options: RunEventStreamOptions
  ) => ReadableStream<Uint8Array>;
  diagnoseSandbox?: (environment: Environment) => Awaitable<{
    exitCode: number | null;
    ok: boolean;
    output: string;
  }>;
  checkAuthority?: (
    claims: Pick<RunnerClaims, "authVersion" | "plan" | "sub" | "tenant">,
    environment: Environment
  ) => Awaitable<RunnerAuthorityResult>;
  getDirectory: (environment: Environment) => Awaitable<CloudRunnerDirectory>;
  getAdmission?: (environment: Environment) => Awaitable<CloudRunnerAdmission>;
  getYoloAgent: (
    environment: Environment,
    agentId: string
  ) => Awaitable<CloudRunnerAgent>;
};

type CleanupRunOptions = {
  admissionCapability?: AdmissionCleanupCapability;
  admission?: CloudRunnerAdmission;
  allowUnowned?: boolean;
  prepareOwner?: string;
  stopFirst?: boolean;
};

async function cleanupRun(
  agent: CloudRunnerAgent,
  runId: string,
  agentId: string,
  options: CleanupRunOptions = {}
): Promise<unknown | null> {
  const {
    admissionCapability,
    admission,
    allowUnowned = false,
    prepareOwner,
    stopFirst = false,
  } = options;
  if (!prepareOwner && !allowUnowned) {
    return null;
  }
  if (
    allowUnowned &&
    !prepareOwner &&
    (!admissionCapability ||
      admissionCapability.agentId !== agentId ||
      admissionCapability.runId !== runId ||
      !admission?.validateCleanup ||
      !(await admission.validateCleanup(admissionCapability)))
  ) {
    return null;
  }
  let firstError: unknown | null = null;
  let prepareOwnerVerified = false;
  const remember = (error: unknown) => {
    if (firstError === null) {
      firstError = error;
    }
  };
  const attempt = async (action: () => Awaitable<unknown>) => {
    try {
      return { ok: true, value: await action() } as const;
    } catch (error) {
      remember(error);
      return { ok: false, value: undefined } as const;
    }
  };

  if (prepareOwner && agent.prepareOwnerMatches) {
    let ownerMatches = false;
    try {
      ownerMatches = await agent.prepareOwnerMatches(runId, prepareOwner);
      prepareOwnerVerified = ownerMatches;
      if (!ownerMatches && !allowUnowned) {
        return null;
      }
    } catch {
      return null;
    }
    if (
      !ownerMatches &&
      (!admissionCapability ||
        admissionCapability.agentId !== agentId ||
        admissionCapability.runId !== runId ||
        !admission?.validateCleanup ||
        !(await admission.validateCleanup(admissionCapability)))
    ) {
      return null;
    }
  }

  let safeToRelease = false;
  if (stopFirst) {
    if (prepareOwner) {
      const discarded = await attempt(() =>
        agent.discardRun(runId, prepareOwner)
      );
      if (discarded.ok && discarded.value !== false) {
        safeToRelease = true;
      } else {
        if (prepareOwner) {
          if (agent.prepareOwnerMatches) {
            try {
              if (
                !(await agent.prepareOwnerMatches(runId, prepareOwner)) &&
                !allowUnowned
              ) {
                return firstError;
              }
            } catch {
              if (!allowUnowned) {
                return firstError;
              }
            }
          } else if (!allowUnowned) {
            return firstError;
          }
        }
        if (prepareOwner && !admissionCapability) {
          if (agent.ensurePendingAdmissionCleanup) {
            await attempt(() => agent.ensurePendingAdmissionCleanup?.(runId));
          }
          return firstError;
        }
        if (
          allowUnowned &&
          !prepareOwnerVerified &&
          (!admissionCapability ||
            admissionCapability.agentId !== agentId ||
            admissionCapability.runId !== runId ||
            !admission?.validateCleanup ||
            !(await admission.validateCleanup(admissionCapability)))
        ) {
          return firstError;
        }
        const guard = admissionCapability
          ? { ...admissionCapability, queuedOnly: false }
          : undefined;
        const stopped = await attempt(() =>
          agent.stop(runId, undefined, undefined, guard)
        );
        safeToRelease =
          stopped.ok &&
          (stopped.value === null ||
            (typeof stopped.value === "object" &&
              stopped.value !== null &&
              "status" in stopped.value &&
              typeof stopped.value.status === "string" &&
              isTerminal(stopped.value.status as RunSnapshot["status"])));
      }
    } else {
      const guard = admissionCapability
        ? { ...admissionCapability, queuedOnly: false }
        : undefined;
      const stopped = await attempt(() =>
        agent.stop(runId, undefined, undefined, guard)
      );
      safeToRelease =
        stopped.ok &&
        (stopped.value === null ||
          (typeof stopped.value === "object" &&
            stopped.value !== null &&
            "status" in stopped.value &&
            typeof stopped.value.status === "string" &&
            isTerminal(stopped.value.status as RunSnapshot["status"])));
    }
  } else {
    const discarded = await attempt(() =>
      agent.discardRun(runId, prepareOwner)
    );
    if (discarded.ok && discarded.value !== false) {
      safeToRelease = true;
    } else if (prepareOwner && !admissionCapability) {
      if (agent.ensurePendingAdmissionCleanup) {
        await attempt(() => agent.ensurePendingAdmissionCleanup?.(runId));
      }
      return firstError;
    } else if (allowUnowned) {
      if (
        !admissionCapability ||
        admissionCapability.agentId !== agentId ||
        admissionCapability.runId !== runId ||
        !admission?.validateCleanup ||
        !(await admission.validateCleanup(admissionCapability))
      ) {
        return firstError;
      }
      const guard = admissionCapability
        ? { ...admissionCapability, queuedOnly: false }
        : undefined;
      const stopped = await attempt(() =>
        agent.stop(runId, undefined, undefined, guard)
      );
      safeToRelease =
        stopped.ok &&
        (stopped.value === null ||
          (typeof stopped.value === "object" &&
            stopped.value !== null &&
            "status" in stopped.value &&
            typeof stopped.value.status === "string" &&
            isTerminal(stopped.value.status as RunSnapshot["status"])));
    }
  }
  if (admission && safeToRelease) {
    let exactCapability = admissionCapability;
    if (
      !exactCapability &&
      admission.getRecord &&
      admission.getCleanupCapability
    ) {
      const recordResult = await attempt(() => admission.getRecord?.(runId));
      const record =
        recordResult.ok && recordResult.value
          ? (recordResult.value as AdmissionRecord)
          : null;
      if (record && record.agentId === agentId) {
        const capability = await attempt(() =>
          admission.getCleanupCapability?.(runId, {
            agentId: record.agentId,
            operationId: record.operationId,
            requestHash: record.requestHash,
            runId: record.runId,
          })
        );
        if (capability.ok) {
          exactCapability =
            (capability.value as AdmissionCleanupCapability | null) ??
            undefined;
        }
      }
    }
    if (exactCapability) {
      const released = await attempt(() =>
        admission.release(
          runId,
          exactCapability?.dispatchToken,
          exactCapability?.admissionSequence
        )
      );
      if (!released.ok && admission.enqueueCleanup) {
        await attempt(() =>
          admission.enqueueCleanup?.(agentId, runId, exactCapability)
        );
      }
    } else if (admission.enqueueCleanup) {
      await attempt(() =>
        admission.enqueueCleanup?.(agentId, runId, admissionCapability)
      );
    }
  } else if (admission?.enqueueCleanup) {
    await attempt(() =>
      admission.enqueueCleanup?.(agentId, runId, admissionCapability)
    );
  }
  return firstError;
}

function isOperationConflict(error: unknown): boolean {
  return (
    error instanceof OperationConflictError ||
    (error instanceof Error && error.name === "OperationConflictError")
  );
}

function directoryRunStatus(
  run: RunSnapshot
): "active" | "queued" | "terminal" {
  if (isTerminal(run.status)) {
    return "terminal";
  }
  return run.status === "queued" ? "queued" : "active";
}

async function markDirectoryRunStatus(
  directory: CloudRunnerDirectory,
  run: RunSnapshot,
  agentId: string
): Promise<boolean | undefined> {
  if (!directory.markRunStatus) {
    return;
  }
  return await directory.markRunStatus(
    run.id,
    agentId,
    directoryRunStatus(run)
  );
}

async function compensateDirectoryRunMapping(
  directory: CloudRunnerDirectory,
  runId: string,
  agentId: string,
  expectedSequence?: number
): Promise<void> {
  try {
    const unregistered = await directory.unregisterRun(
      runId,
      agentId,
      expectedSequence
    );
    if (unregistered === false && directory.enqueueRunMappingCleanup) {
      await directory.enqueueRunMappingCleanup(
        runId,
        agentId,
        expectedSequence
      );
    }
  } catch {
    if (directory.enqueueRunMappingCleanup) {
      try {
        await directory.enqueueRunMappingCleanup(
          runId,
          agentId,
          expectedSequence
        );
      } catch {
        // Preserve the original registration failure.
      }
    }
  }
}

function registeredSequence(
  result: RunRegistrationResult | boolean
): number | undefined {
  return typeof result === "object" && result.kind === "registered"
    ? result.sequence
    : undefined;
}

function registrationSucceeded(
  result: RunRegistrationResult | boolean
): boolean {
  return (
    result === true ||
    (typeof result === "object" && result.kind === "registered")
  );
}

async function registerExistingRunMapping(
  directory: CloudRunnerDirectory,
  run: RunSnapshot,
  agentId: string
): Promise<void> {
  let expectedSequence: number | undefined;
  try {
    const registered = await directory.registerRun(
      run.id,
      agentId,
      directoryRunStatus(run)
    );
    if (!registrationSucceeded(registered)) {
      throw new Error("Run directory registration was ambiguous.");
    }
    expectedSequence = registeredSequence(registered);
    if ((await markDirectoryRunStatus(directory, run, agentId)) === false) {
      throw new Error("Run directory status update was ambiguous.");
    }
  } catch (error) {
    await compensateDirectoryRunMapping(
      directory,
      run.id,
      agentId,
      expectedSequence
    );
    throw error;
  }
}

async function releaseTerminalAdmission(
  directory: CloudRunnerDirectory,
  run: RunSnapshot,
  agentId: string,
  admission?: CloudRunnerAdmission,
  admissionCapability?: AdmissionCleanupCapability
): Promise<void> {
  let releaseError: unknown;
  try {
    if (admission) {
      let capability = admissionCapability;
      if (
        !capability &&
        admission.getRecord &&
        admission.getCleanupCapability
      ) {
        const record = await admission.getRecord(run.id);
        if (
          record &&
          record.agentId === agentId &&
          record.operationId === run.operationId &&
          record.runId === run.id
        ) {
          capability =
            (await admission.getCleanupCapability(run.id, {
              agentId: record.agentId,
              operationId: record.operationId,
              requestHash: record.requestHash,
              runId: record.runId,
            })) ?? undefined;
        }
      }
      if (capability) {
        const released = await admission.release(
          run.id,
          capability.dispatchToken,
          capability.admissionSequence
        );
        if (!released && admission.enqueueCleanup) {
          await admission.enqueueCleanup(agentId, run.id, capability);
        }
      } else if (admission.enqueueCleanup) {
        await admission.enqueueCleanup(agentId, run.id);
      }
    }
  } catch (error) {
    releaseError = error;
  } finally {
    try {
      await markDirectoryRunStatus(directory, run, agentId);
    } catch {
      // The terminal run remains authoritative; a later callback can repair
      // the directory without turning an idempotent terminal response into a
      // busy error.
    }
  }
  if (releaseError) {
    throw releaseError;
  }
}

async function reconcilePreparedAdmissionOutcome(
  directory: CloudRunnerDirectory,
  agent: CloudRunnerAgent,
  runId: string,
  agentId: string,
  admission: CloudRunnerAdmission,
  admissionCapability: AdmissionCleanupCapability | null,
  prepareOwner: string | undefined,
  cors: Headers
): Promise<Response> {
  const local = await agent.getRun(runId);
  if (local && isTerminal(local.status)) {
    await registerExistingRunMapping(directory, local, agentId);
    await releaseTerminalAdmission(
      directory,
      local,
      agentId,
      admission,
      admissionCapability ?? undefined
    );
    return json(
      {
        apiVersion: AGENT_RUNNER_API_VERSION,
        run: local,
      },
      { status: 202 },
      cors
    );
  }
  const cleanupError = await cleanupRun(agent, runId, agentId, {
    admission,
    admissionCapability: admissionCapability ?? undefined,
    allowUnowned: true,
    prepareOwner,
    stopFirst: true,
  });
  if (cleanupError) {
    throw cleanupError;
  }
  return busyResponse("global_busy", cors);
}

async function finalizePreparedAdmission(
  agent: CloudRunnerAgent,
  admission: CloudRunnerAdmission,
  runId: string,
  operationId: string,
  requestHash: string,
  admissionCapability: AdmissionCleanupCapability | null,
  prepareOwner?: string
): Promise<{
  agentConfirmed: boolean;
  confirmation?: AdmissionConfirmationOutcome;
  coordinatorConfirmed: boolean;
  coordinatorOutcome?: PreparedAdmissionConfirmationOutcome;
}> {
  if (!agent.confirmAdmission) {
    return { agentConfirmed: false, coordinatorConfirmed: true };
  }
  const confirmation = await agent.confirmAdmission(
    runId,
    operationId,
    requestHash,
    admissionCapability
  );
  if (confirmation.kind !== "confirmed") {
    return {
      agentConfirmed: false,
      confirmation,
      coordinatorConfirmed: false,
    };
  }
  if (!admissionCapability || !admission.confirmPreparedAdmission) {
    return {
      agentConfirmed: true,
      confirmation,
      coordinatorConfirmed: true,
    };
  }
  const coordinatorOutcome = await admission.confirmPreparedAdmission(
    runId,
    prepareOwner,
    admissionCapability
  );
  return {
    agentConfirmed: true,
    confirmation,
    coordinatorConfirmed: coordinatorOutcome.kind === "confirmed",
    coordinatorOutcome,
  };
}

async function releaseAdmissionRecord(
  admission: CloudRunnerAdmission,
  record: AdmissionRecord,
  capability?: AdmissionCleanupCapability | null
): Promise<boolean> {
  const exact =
    capability ??
    (admission.getCleanupCapability
      ? await admission.getCleanupCapability(record.runId, {
          agentId: record.agentId,
          operationId: record.operationId,
          requestHash: record.requestHash,
          runId: record.runId,
        })
      : null);
  if (!exact) {
    if (admission.enqueueCleanup) {
      await admission.enqueueCleanup(record.agentId, record.runId);
    }
    return false;
  }
  const released = await admission.release(
    record.runId,
    exact.dispatchToken,
    exact.admissionSequence
  );
  if (!released && admission.enqueueCleanup) {
    await admission.enqueueCleanup(record.agentId, record.runId, exact);
  }
  return released;
}

/**
 * The contract permits any harness runtime; this runner can only drive the ones
 * it actually ships. Checked at both create and update, because an update that
 * skipped it could move a working agent onto a runtime that cannot run.
 */
function assertRunnableHarness(runtime: string): void {
  if (!isRunnableHarness(runtime)) {
    throw new HttpError(
      `Cloud agents must select a supported harness runtime: ${SUPPORTED_HARNESS_IDS.join(", ")}.`,
      400,
      "harness_unsupported"
    );
  }
}

function fail(error: unknown, cors: Headers): Response {
  if (error instanceof HttpError) {
    return json(
      errorEnvelope(error.code, error.message, error.retryable, error.details),
      { status: error.status },
      cors
    );
  }
  /**
   * Matched by name as well as prototype, like the ZodError branch below and
   * for the same reason: these are thrown inside the YoloAgent Durable Object,
   * and the RPC boundary preserves an error's name and message but strips its
   * prototype chain. `instanceof` was therefore false for every DO-thrown
   * instance, and a run refused because one was already active fell through to
   * the 500 catch-all — the client saw a retryable `internal_error` instead of
   * the 409 that names the actual condition, and retrying was guaranteed to
   * hit the same wall.
   */
  if (
    error instanceof OperationConflictError ||
    (error instanceof Error && error.name === "OperationConflictError")
  ) {
    return json(
      errorEnvelope(
        "operation_conflict",
        "Operation ID was already used for a different request.",
        false
      ),
      { status: 409 },
      cors
    );
  }
  if (
    error instanceof AdmissionUnavailableError ||
    (error instanceof Error && error.name === "AdmissionUnavailableError")
  ) {
    return json(
      errorEnvelope(
        "admission_unavailable",
        "Run admission is temporarily unavailable. Try again later.",
        true
      ),
      { status: 503 },
      cors
    );
  }
  if (
    error instanceof AgentDecommissioningError ||
    (error instanceof Error && error.name === "AgentDecommissioningError")
  ) {
    return json(
      errorEnvelope(
        "agent_decommissioning",
        "Agent decommission is still in progress. Try again later.",
        true
      ),
      { status: 409 },
      cors
    );
  }
  if (
    error instanceof AlreadyRunningError ||
    error instanceof AgentBusyError ||
    (error instanceof Error &&
      (error.name === "AlreadyRunningError" || error.name === "AgentBusyError"))
  ) {
    return json(
      errorEnvelope(
        "already_running",
        "An agent already has an active run.",
        false
      ),
      { status: 409 },
      cors
    );
  }
  if (error instanceof Error && error.name === "ZodError") {
    return json(
      errorEnvelope("invalid_request", "Request validation failed.", false),
      { status: 400 },
      cors
    );
  }
  /**
   * The fallback, and the only place an unrecognised failure is ever seen.
   *
   * This used to log the sentence and drop the error, so every unhandled throw
   * in the worker produced one indistinguishable line. That is what made four
   * separate defects each take a round of guesswork to find: the run reached
   * the worker, returned 500, and the log said nothing about why. An error
   * handler that destroys the error is worse than no handler, because it looks
   * like the failure was accounted for.
   *
   * Sanitised, because a thrown error can carry a credential in its message —
   * a failed fetch stringifies its request, and a harness token travels in an
   * Authorization header. `sanitizeEvidenceText` is the same redaction the run
   * evidence goes through before it is persisted.
   */
  const detail =
    error instanceof Error
      ? {
          message: sanitizeEvidenceText(error.message),
          name: error.name,
          stack: error.stack ? sanitizeEvidenceText(error.stack) : undefined,
        }
      : { message: sanitizeEvidenceText(String(error)), name: "UnknownError" };

  console.error("Cloud runner request failed.", detail);

  return json(
    errorEnvelope("internal_error", "Runner request failed.", true),
    { status: 500 },
    cors
  );
}

function parseLastEventId(request: Request): number {
  const raw = request.headers.get("last-event-id");
  if (raw === null) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new HttpError(
      "Last-Event-ID must be a non-negative integer.",
      400,
      "invalid_event_cursor"
    );
  }
  return parsed;
}

function eventStream(
  stream: ReadableStream<Uint8Array>,
  cors: Headers
): Response {
  const headers = new Headers(cors);
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("x-accel-buffering", "no");
  return new Response(stream, { headers });
}

function abuseResponse(
  decision: WorkerAbuseDecision,
  cors: Headers
): Response | null {
  if (decision.kind === "allowed") {
    return null;
  }
  const headers = new Headers({
    "cache-control": "no-store",
  });
  if (decision.kind === "limited") {
    headers.set("retry-after", String(decision.retryAfterSeconds));
    return json(
      errorEnvelope(
        "rate_limited",
        "Too many requests. Try again later.",
        true
      ),
      { headers, status: 429 },
      cors
    );
  }

  return json(
    errorEnvelope("abuse_control_unavailable", "Please try again later.", true),
    { headers, status: 503 },
    cors
  );
}

function authorityResponse(
  decision: Exclude<RunnerAuthorityResult, { kind: "allowed" }>,
  cors: Headers
): Response {
  if (decision.kind === "unauthorized") {
    return json(
      errorEnvelope("unauthorized", "Identity was rejected.", false),
      { status: 401 },
      cors
    );
  }
  if (decision.kind === "subscription_required") {
    return json(
      errorEnvelope(
        "subscription_required",
        "An active subscription is required.",
        false
      ),
      { status: 403 },
      cors
    );
  }
  return json(
    errorEnvelope(
      "authority_unavailable",
      "Runner authority is temporarily unavailable. Try again later.",
      true
    ),
    { status: 503 },
    cors
  );
}

function busyResponse(
  reason: "global_busy" | "tenant_queue_full",
  cors: Headers
): Response {
  const message =
    reason === "tenant_queue_full"
      ? "This tenant has too much work waiting."
      : "The cloud runner is busy. Try again later.";
  return json(errorEnvelope("busy", message, true), { status: 409 }, cors);
}

function matchesLocalAdmission(
  record: AdmissionRecord,
  expected: Pick<
    AdmissionRecord,
    "agentId" | "operationId" | "requestHash" | "runId" | "tenantHash"
  >
): boolean {
  return (
    record.agentId === expected.agentId &&
    record.operationId === expected.operationId &&
    record.requestHash === expected.requestHash &&
    record.runId === expected.runId &&
    record.tenantHash === expected.tenantHash
  );
}

function matchesLocalRun(
  run: RunSnapshot,
  expected: Pick<RunSnapshot, "agentId" | "id" | "operationId">
): boolean {
  return (
    run.agentId === expected.agentId &&
    run.id === expected.id &&
    run.operationId === expected.operationId
  );
}

export function createCloudRunner<Environment extends CloudRunnerEnvironment>(
  dependencies: CloudRunnerDependencies<Environment>
): {
  fetch: (request: Request, environment: Environment) => Promise<Response>;
} {
  const createEventStream =
    dependencies.createEventStream ?? createRunEventStream;

  return {
    async fetch(request: Request, environment: Environment): Promise<Response> {
      const cors = corsHeaders(request, environment.ALLOWED_ORIGIN);
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: cors, status: 204 });
      }

      const url = new URL(request.url);
      const routeClass = workerRouteClass(request.method, url.pathname);
      const sourceAdmission = abuseResponse(
        await enforceWorkerEdgeLimit({
          env: environment,
          ip: request.headers.get("cf-connecting-ip"),
          routeClass,
          stage: "source",
        }),
        cors
      );
      if (sourceAdmission) {
        return sourceAdmission;
      }

      if (url.pathname === "/api/health" && request.method === "GET") {
        return json(
          {
            apiVersion: AGENT_RUNNER_API_VERSION,
            capabilities: [...AGENT_RUNNER_CAPABILITIES],
            minimumClientVersion: "1.0.0",
            mode: "cloud",
          },
          {},
          cors
        );
      }

      if (
        !hasValidHeaderToken(
          request,
          "x-runner-token",
          environment.AGENT_CONTROL_TOKEN ?? ""
        )
      ) {
        return json(
          errorEnvelope("unauthorized", "Runner token was rejected.", false),
          { status: 401 },
          cors
        );
      }

      /**
       * Identity and authorization are now two different tokens on two
       * different headers, on purpose. `X-Runner-Token` above proves only
       * that the caller may reach this worker at all — it is a coarse
       * deployment gate, and no tenant may ever be derived from it. Identity
       * comes from `Authorization: Bearer <token>`: a claim signed by a key
       * this worker can verify but not mint, so the worker can trust the
       * `tenant` inside it without being able to forge one itself. If the
       * worker cannot verify identity — no verify key configured — it must
       * refuse rather than fall back to a default tenant.
       */
      if (!environment.RUNNER_VERIFY_KEY?.trim()) {
        return json(
          errorEnvelope("unauthorized", "Identity cannot be verified.", false),
          { status: 401 },
          cors
        );
      }
      const authorization = request.headers.get("authorization");
      if (!authorization?.startsWith("Bearer ")) {
        return json(
          errorEnvelope("unauthorized", "Identity was rejected.", false),
          { status: 401 },
          cors
        );
      }
      let verifyKeyRing: RunnerVerificationKeyRing;
      try {
        verifyKeyRing = await getVerifyKeyRing(environment);
      } catch {
        return json(
          errorEnvelope("unauthorized", "Identity cannot be verified.", false),
          { status: 401 },
          cors
        );
      }
      const claims = await verifyRunnerToken(
        authorization.slice(7),
        verifyKeyRing
      );
      if (!claims) {
        return json(
          errorEnvelope("unauthorized", "Identity was rejected.", false),
          { status: 401 },
          cors
        );
      }
      const callerTenant = claims.tenant;
      const tenantAdmission = abuseResponse(
        await enforceWorkerEdgeLimit({
          env: environment,
          ip: request.headers.get("cf-connecting-ip"),
          routeClass,
          stage: "tenant",
          tenant: callerTenant,
        }),
        cors
      );
      if (tenantAdmission) {
        return tenantAdmission;
      }

      const isDiagnosticsRoute =
        url.pathname === "/api/diagnostics/sandbox" &&
        request.method === "POST";
      if (!isDiagnosticsRoute) {
        const authority = dependencies.checkAuthority
          ? await dependencies.checkAuthority(claims, environment)
          : await checkRunnerAuthority(
              claims,
              {
                appOrigin: environment.APP_ORIGIN,
                serviceToken: environment.RUNNER_SERVICE_TOKEN,
              },
              (input, init) => fetch(input, init)
            );
        if (authority.kind !== "allowed") {
          return authorityResponse(authority, cors);
        }
      }

      if (isDiagnosticsRoute) {
        if (!dependencies.diagnoseSandbox) {
          return json(
            errorEnvelope("not_found", "Route was not found.", false),
            { status: 404 },
            cors
          );
        }
        try {
          return json(
            await dependencies.diagnoseSandbox(environment),
            {},
            cors
          );
        } catch (error) {
          return fail(error, cors);
        }
      }

      try {
        // Resolved inside the try: a Durable Object binding failure here would
        // otherwise escape `fail()` and return a bare platform 500, with no
        // error envelope and no CORS headers, so the browser would report it as
        // a network error rather than the failure it is.
        const directory = await dependencies.getDirectory(environment);
        const yoloAgent = (agentId: string): Promise<CloudRunnerAgent> =>
          Promise.resolve(dependencies.getYoloAgent(environment, agentId));

        if (url.pathname === "/api/agents") {
          if (request.method === "GET") {
            return json(
              { agents: await directory.list(callerTenant) },
              {},
              cors
            );
          }
          if (request.method === "POST") {
            const input = createAgentInputSchema.parse(await readJson(request));
            assertRunnableHarness(input.runtime);
            const now = new Date().toISOString();
            const definition: AgentDefinition = {
              ...input,
              createdAt: now,
              id: crypto.randomUUID(),
              lastRunAt: null,
              // Ownership is stamped from the caller, never from the request:
              // createAgentInputSchema omits `owner` and is strict, so a
              // submitted one is rejected rather than reaching this spread.
              owner: { kind: "tenant", tenantId: callerTenant },
              status: "idle",
              updatedAt: now,
            };
            const agent = await yoloAgent(definition.id);
            const configured = await agent.configure(definition);
            await directory.upsert(configured);
            // Creating a profile is a declared intent to run, so the
            // container starts booting while the user types their first
            // mission. Subscribers only — a demo tenant cannot run, so
            // warming for one would spend a container on nothing. A warm
            // failure never fails the creation it rides on.
            if (claims.plan === "subscriber") {
              await Promise.resolve(agent.warm()).catch(() => undefined);
            }
            return json({ agent: configured }, { status: 201 }, cors);
          }
        }

        if (
          url.pathname === "/api/tenant/prewarm" &&
          request.method === "POST"
        ) {
          // Sign-in-time warming for a returning user: boot the sandbox of
          // the agent they most recently ran. Idempotent — the agent's warm
          // state single-flights the fiber — and quota-free for the caller:
          // no run is counted and no credential is fetched.
          if (claims.plan !== "subscriber") {
            return json(
              errorEnvelope(
                "subscription_required",
                "Warming needs an active subscription.",
                false
              ),
              { status: 403 },
              cors
            );
          }
          const owned = await directory.list(callerTenant);
          const [target] = [...owned].sort(
            (left, right) =>
              Date.parse(right.lastRunAt ?? right.updatedAt) -
              Date.parse(left.lastRunAt ?? left.updatedAt)
          );
          if (!target) {
            return new Response(null, { headers: cors, status: 204 });
          }
          const warm = await Promise.resolve(
            (await yoloAgent(target.id)).warm()
          ).catch(() => null);
          return json({ agentId: target.id, warm }, { status: 202 }, cors);
        }

        const agentMatch = url.pathname.match(
          /^\/api\/agents\/([^/]+)(?:\/(runs))?$/
        );
        if (agentMatch) {
          const [, rawId, action] = agentMatch;
          const id = agentIdSchema.parse(decodeURIComponent(rawId ?? ""));
          const agent = await yoloAgent(id);
          const current = await agent.snapshot();
          /**
           * Knowing an agent id must not be enough to reach it. A definition
           * owned by another tenant is reported as 404 rather than 403, so the
           * endpoint does not confirm that the id exists for someone else.
           */
          if (!current || tenantOf(current) !== callerTenant) {
            throw new HttpError("Agent was not found.", 404, "not_found");
          }

          if (!action && request.method === "GET") {
            return json({ agent: current }, {}, cors);
          }
          if (!action && request.method === "PUT") {
            const input = createAgentInputSchema.parse(await readJson(request));
            assertRunnableHarness(input.runtime);
            const configured = await agent.configure({
              ...input,
              createdAt: current.createdAt,
              id,
              lastRunAt: current.lastRunAt,
              // An update must never move an agent between tenants, so the
              // stored owner is carried forward rather than taken from the
              // request or re-derived.
              owner: current.owner,
              status: current.status,
              updatedAt: new Date().toISOString(),
            });
            await directory.upsert(configured);
            // An edited profile is about to be run — same intent signal as
            // creation, same warm, same subscriber gate.
            if (claims.plan === "subscriber") {
              await Promise.resolve(agent.warm()).catch(() => undefined);
            }
            return json({ agent: configured }, {}, cors);
          }
          if (!action && request.method === "DELETE") {
            await agent.decommission();
            await directory.remove(id);
            return json({ ok: true }, {}, cors);
          }
          if (action === "runs" && request.method === "GET") {
            // The retained history (terminal runs plus any live one), newest
            // first. Without this a console refresh forgets every run the
            // agent still remembers.
            return json(
              {
                apiVersion: AGENT_RUNNER_API_VERSION,
                runs: await agent.listRuns(),
              },
              {},
              cors
            );
          }
          if (action === "runs" && request.method === "POST") {
            // The plan is enforced before the run, not only when the
            // credential is fetched. A lapsed user is issued a fresh `demo`
            // claim, and without this a run would start and fail late — or
            // succeed outright if a credential were still stored.
            if (claims.plan !== "subscriber") {
              return json(
                errorEnvelope(
                  "subscription_required",
                  "Starting a run needs an active subscription.",
                  false
                ),
                { status: 403 },
                cors
              );
            }
            const input = startRunInputSchema.parse(await readJson(request));
            const runAdmissionMode = admissionMode(environment);
            const requestHash = await hashOperation(id, input.task);
            let runId: string = crypto.randomUUID();
            let prepared: Awaited<ReturnType<CloudRunnerAgent["enqueue"]>>;
            try {
              prepared = await agent.enqueue(
                input,
                runId,
                requestHash,
                authorization.slice(7),
                runAdmissionMode === "queue"
              );
            } catch (error) {
              await cleanupRun(agent, runId, id);
              throw error;
            }
            let existingAdmission: CloudRunnerAdmission | null = null;
            let admissionRecord: AdmissionRecord | null = null;
            if (!prepared.created) {
              if (
                runAdmissionMode === "reject" &&
                prepared.run.operationId !== input.operationId &&
                !isTerminal(prepared.run.status)
              ) {
                return busyResponse("global_busy", cors);
              }
              if (isTerminal(prepared.run.status)) {
                let terminalAdmission: CloudRunnerAdmission | undefined;
                let stale: AdmissionRecord | null = null;
                try {
                  if (dependencies.getAdmission) {
                    terminalAdmission =
                      await dependencies.getAdmission(environment);
                    stale = terminalAdmission.getByOperationId
                      ? await terminalAdmission.getByOperationId(
                          input.operationId
                        )
                      : null;
                  }
                } catch (error) {
                  if (
                    error instanceof AdmissionUnavailableError ||
                    (error instanceof Error &&
                      error.name === "AdmissionUnavailableError")
                  ) {
                    throw error;
                  }
                  throw new AdmissionUnavailableError(
                    "Terminal run admission reconciliation failed.",
                    { cause: error }
                  );
                }
                if (stale) {
                  const tenantHash = await tenantAdmissionHash(
                    environment.EDGE_ABUSE_KEY_SECRET,
                    callerTenant
                  );
                  if (
                    !matchesLocalAdmission(stale, {
                      agentId: id,
                      operationId: input.operationId,
                      requestHash,
                      runId: prepared.run.id,
                      tenantHash,
                    })
                  ) {
                    throw new OperationConflictError();
                  }
                }
                await registerExistingRunMapping(directory, prepared.run, id);
                if (terminalAdmission && stale) {
                  try {
                    await releaseAdmissionRecord(terminalAdmission, stale);
                  } catch (error) {
                    if (
                      error instanceof AdmissionUnavailableError ||
                      (error instanceof Error &&
                        error.name === "AdmissionUnavailableError")
                    ) {
                      throw error;
                    }
                    throw new AdmissionUnavailableError(
                      "Terminal run admission reconciliation failed.",
                      { cause: error }
                    );
                  }
                }
                await releaseTerminalAdmission(directory, prepared.run, id);
                return json(
                  {
                    apiVersion: AGENT_RUNNER_API_VERSION,
                    run: prepared.run,
                  },
                  { status: 202 },
                  cors
                );
              }
              try {
                existingAdmission = dependencies.getAdmission
                  ? await dependencies.getAdmission(environment)
                  : null;
                admissionRecord = existingAdmission?.getByOperationId
                  ? await existingAdmission.getByOperationId(input.operationId)
                  : null;
              } catch {
                return busyResponse("global_busy", cors);
              }
              if (existingAdmission && admissionRecord) {
                const tenantHash = await tenantAdmissionHash(
                  environment.EDGE_ABUSE_KEY_SECRET,
                  callerTenant
                );
                if (
                  !matchesLocalAdmission(admissionRecord, {
                    agentId: id,
                    operationId: input.operationId,
                    requestHash,
                    runId: prepared.run.id,
                    tenantHash,
                  })
                ) {
                  throw new OperationConflictError();
                }
                const originalAgentId = await directory.lookupRun(
                  admissionRecord.runId
                );
                if (originalAgentId !== null && originalAgentId !== id) {
                  throw new OperationConflictError();
                }
                const originalAgent = originalAgentId
                  ? await yoloAgent(originalAgentId)
                  : agent;
                const original = await originalAgent.getRun(
                  admissionRecord.runId
                );
                if (!original) {
                  return busyResponse("global_busy", cors);
                }
                if (
                  !matchesLocalRun(original, {
                    agentId: id,
                    id: prepared.run.id,
                    operationId: input.operationId,
                  }) ||
                  (await hashOperation(original.agentId, original.task)) !==
                    requestHash
                ) {
                  throw new OperationConflictError();
                }
                if (
                  admissionRecord.state === "terminal" &&
                  !isTerminal(original.status)
                ) {
                  const capability = existingAdmission.getCleanupCapability
                    ? await existingAdmission.getCleanupCapability(
                        admissionRecord.runId,
                        {
                          agentId: id,
                          operationId: input.operationId,
                          requestHash,
                          runId: admissionRecord.runId,
                        }
                      )
                    : null;
                  const cleanupError = await cleanupRun(
                    originalAgent,
                    original.id,
                    id,
                    {
                      admission: existingAdmission,
                      admissionCapability: capability ?? undefined,
                      allowUnowned: true,
                      stopFirst: true,
                    }
                  );
                  if (cleanupError) {
                    throw cleanupError;
                  }
                  return busyResponse("global_busy", cors);
                }
                if (isTerminal(original.status)) {
                  await registerExistingRunMapping(directory, original, id);
                  await releaseTerminalAdmission(
                    directory,
                    original,
                    id,
                    existingAdmission
                  );
                } else {
                  const capability = existingAdmission.getCleanupCapability
                    ? await existingAdmission.getCleanupCapability(
                        admissionRecord.runId,
                        {
                          agentId: admissionRecord.agentId,
                          operationId: admissionRecord.operationId,
                          requestHash: admissionRecord.requestHash,
                          runId: admissionRecord.runId,
                        }
                      )
                    : null;
                  const { confirmation, coordinatorConfirmed } =
                    await finalizePreparedAdmission(
                      originalAgent,
                      existingAdmission,
                      original.id,
                      admissionRecord.operationId,
                      admissionRecord.requestHash,
                      capability
                    );
                  if (confirmation && confirmation.kind !== "confirmed") {
                    const latest = await originalAgent.getRun(original.id);
                    if (latest && isTerminal(latest.status)) {
                      await registerExistingRunMapping(directory, latest, id);
                      await releaseTerminalAdmission(
                        directory,
                        latest,
                        id,
                        existingAdmission
                      );
                      return json(
                        {
                          apiVersion: AGENT_RUNNER_API_VERSION,
                          run: latest,
                        },
                        { status: 202 },
                        cors
                      );
                    }
                    if (
                      confirmation.kind === "stale_provisional" ||
                      confirmation.kind === "expired"
                    ) {
                      const cleanupError = await cleanupRun(
                        originalAgent,
                        original.id,
                        id,
                        {
                          admission: existingAdmission,
                          admissionCapability:
                            confirmation.admissionCapability ??
                            capability ??
                            undefined,
                          prepareOwner: confirmation.prepareOwner,
                          stopFirst: true,
                        }
                      );
                      if (cleanupError) {
                        throw cleanupError;
                      }
                    }
                    return busyResponse("global_busy", cors);
                  }
                  if (!coordinatorConfirmed) {
                    return await reconcilePreparedAdmissionOutcome(
                      directory,
                      originalAgent,
                      original.id,
                      admissionRecord.agentId,
                      existingAdmission,
                      capability,
                      undefined,
                      cors
                    );
                  }
                  const latest = await originalAgent.getRun(original.id);
                  if (latest && isTerminal(latest.status)) {
                    await registerExistingRunMapping(directory, latest, id);
                    await releaseTerminalAdmission(
                      directory,
                      latest,
                      id,
                      existingAdmission
                    );
                    return json(
                      {
                        apiVersion: AGENT_RUNNER_API_VERSION,
                        run: latest,
                      },
                      { status: 202 },
                      cors
                    );
                  }
                }
                const latest = await originalAgent.getRun(original.id);
                if (!latest) {
                  return busyResponse("global_busy", cors);
                }
                await registerExistingRunMapping(directory, latest, id);
                return json(
                  {
                    apiVersion: AGENT_RUNNER_API_VERSION,
                    run: latest,
                  },
                  { status: 202 },
                  cors
                );
              }
              if (prepared.run.status !== "queued") {
                return busyResponse("global_busy", cors);
              }
              runId = prepared.run.id;
            }
            if (!dependencies.getAdmission) {
              await cleanupRun(agent, runId, id, {
                prepareOwner: prepared.prepareOwner,
              });
              throw new Error("Run admission is not configured.");
            }

            let admission: CloudRunnerAdmission;
            if (existingAdmission) {
              admission = existingAdmission;
            } else {
              try {
                admission = await dependencies.getAdmission(environment);
              } catch (error) {
                await cleanupRun(agent, runId, id, {
                  prepareOwner: prepared.prepareOwner,
                });
                if (runAdmissionMode === "reject") {
                  return busyResponse("global_busy", cors);
                }
                throw error;
              }
            }

            if (
              prepared.created &&
              prepared.scheduleFailed &&
              prepared.prepareOwner &&
              admission.enqueueProvisionalCleanup
            ) {
              try {
                await admission.enqueueProvisionalCleanup(
                  id,
                  runId,
                  prepared.prepareOwner,
                  input.operationId,
                  requestHash
                );
              } catch (error) {
                await cleanupRun(agent, runId, id, {
                  admission,
                  prepareOwner: prepared.prepareOwner,
                  stopFirst: true,
                });
                throw error;
              }
            }

            let decision: AdmissionDecision;
            const tenantHash = await tenantAdmissionHash(
              environment.EDGE_ABUSE_KEY_SECRET,
              callerTenant
            );
            try {
              decision = await admission.admit({
                agentId: id,
                mode: runAdmissionMode,
                operationId: input.operationId,
                prepareOwner: prepared.prepareOwner,
                requestHash,
                runId,
                tenantHash,
              });
            } catch (error) {
              await cleanupRun(agent, runId, id, {
                admission,
                prepareOwner: prepared.prepareOwner,
                stopFirst: true,
              });
              if (
                runAdmissionMode === "reject" &&
                !isOperationConflict(error)
              ) {
                return busyResponse("global_busy", cors);
              }
              throw error;
            }

            if (decision.kind === "refused") {
              const cleanupError = await cleanupRun(agent, runId, id, {
                admission,
                prepareOwner: prepared.prepareOwner,
                stopFirst: true,
              });
              if (cleanupError) {
                throw cleanupError;
              }
              return busyResponse(decision.reason, cors);
            }
            if (decision.kind === "duplicate") {
              let duplicateAdmission: AdmissionRecord | null = null;
              try {
                duplicateAdmission = admission.getByOperationId
                  ? await admission.getByOperationId(input.operationId)
                  : null;
              } catch {
                return busyResponse("global_busy", cors);
              }
              if (
                !duplicateAdmission ||
                !matchesLocalAdmission(duplicateAdmission, {
                  agentId: id,
                  operationId: input.operationId,
                  requestHash,
                  runId: decision.runId,
                  tenantHash,
                })
              ) {
                throw new OperationConflictError();
              }
              const originalAgentId = await directory.lookupRun(
                duplicateAdmission.runId
              );
              if (
                originalAgentId !== null &&
                originalAgentId !== duplicateAdmission.agentId
              ) {
                throw new OperationConflictError();
              }
              const originalAgent = originalAgentId
                ? await yoloAgent(originalAgentId)
                : agent;
              const original = await originalAgent.getRun(
                duplicateAdmission.runId
              );
              if (!original) {
                return busyResponse("global_busy", cors);
              }
              if (
                !matchesLocalRun(original, {
                  agentId: duplicateAdmission.agentId,
                  id: duplicateAdmission.runId,
                  operationId: duplicateAdmission.operationId,
                }) ||
                (await hashOperation(original.agentId, original.task)) !==
                  duplicateAdmission.requestHash
              ) {
                throw new OperationConflictError();
              }
              if (
                duplicateAdmission.state === "terminal" &&
                !isTerminal(original.status)
              ) {
                const capability = admission.getCleanupCapability
                  ? await admission.getCleanupCapability(
                      duplicateAdmission.runId,
                      {
                        agentId: duplicateAdmission.agentId,
                        operationId: duplicateAdmission.operationId,
                        requestHash: duplicateAdmission.requestHash,
                        runId: duplicateAdmission.runId,
                      }
                    )
                  : null;
                const cleanupError = await cleanupRun(
                  originalAgent,
                  original.id,
                  id,
                  {
                    admission,
                    admissionCapability: capability ?? undefined,
                    allowUnowned: true,
                    stopFirst: true,
                  }
                );
                if (cleanupError) {
                  throw cleanupError;
                }
                return busyResponse("global_busy", cors);
              }
              if (isTerminal(original.status)) {
                await registerExistingRunMapping(
                  directory,
                  original,
                  duplicateAdmission.agentId
                );
                await releaseTerminalAdmission(
                  directory,
                  original,
                  id,
                  admission
                );
              } else {
                const capability =
                  decision.admissionCapability ??
                  (admission.getCleanupCapability
                    ? await admission.getCleanupCapability(
                        duplicateAdmission.runId,
                        {
                          agentId: duplicateAdmission.agentId,
                          operationId: duplicateAdmission.operationId,
                          requestHash: duplicateAdmission.requestHash,
                          runId: duplicateAdmission.runId,
                        }
                      )
                    : null);
                const { confirmation, coordinatorConfirmed } =
                  await finalizePreparedAdmission(
                    originalAgent,
                    admission,
                    original.id,
                    duplicateAdmission.operationId,
                    duplicateAdmission.requestHash,
                    capability,
                    undefined
                  );
                if (confirmation && confirmation.kind !== "confirmed") {
                  const latest = await originalAgent.getRun(original.id);
                  if (latest && isTerminal(latest.status)) {
                    await registerExistingRunMapping(
                      directory,
                      latest,
                      duplicateAdmission.agentId
                    );
                    await releaseTerminalAdmission(
                      directory,
                      latest,
                      id,
                      admission
                    );
                    return json(
                      {
                        apiVersion: AGENT_RUNNER_API_VERSION,
                        run: latest,
                      },
                      { status: 202 },
                      cors
                    );
                  }
                  if (
                    confirmation.kind === "stale_provisional" ||
                    confirmation.kind === "expired"
                  ) {
                    const cleanupError = await cleanupRun(
                      originalAgent,
                      original.id,
                      id,
                      {
                        admission,
                        admissionCapability:
                          confirmation.admissionCapability ??
                          capability ??
                          undefined,
                        prepareOwner: confirmation.prepareOwner,
                        stopFirst: true,
                      }
                    );
                    if (cleanupError) {
                      throw cleanupError;
                    }
                  }
                  return busyResponse("global_busy", cors);
                }
                if (!coordinatorConfirmed) {
                  return await reconcilePreparedAdmissionOutcome(
                    directory,
                    originalAgent,
                    original.id,
                    duplicateAdmission.agentId,
                    admission,
                    capability,
                    undefined,
                    cors
                  );
                }
                const latest = await originalAgent.getRun(original.id);
                if (latest && isTerminal(latest.status)) {
                  await registerExistingRunMapping(
                    directory,
                    latest,
                    duplicateAdmission.agentId
                  );
                  await releaseTerminalAdmission(
                    directory,
                    latest,
                    id,
                    admission
                  );
                  return json(
                    {
                      apiVersion: AGENT_RUNNER_API_VERSION,
                      run: latest,
                    },
                    { status: 202 },
                    cors
                  );
                }
              }
              const latest = await originalAgent.getRun(original.id);
              if (!latest) {
                return busyResponse("global_busy", cors);
              }
              await registerExistingRunMapping(
                directory,
                latest,
                duplicateAdmission.agentId
              );
              return json(
                { apiVersion: AGENT_RUNNER_API_VERSION, run: latest },
                { status: 202 },
                cors
              );
            }
            if (decision.kind === "queued" && runAdmissionMode === "reject") {
              throw new AdmissionUnavailableError(
                "Reject-mode admission returned queued work."
              );
            }

            let admissionCapability: AdmissionCleanupCapability | null =
              decision.admissionCapability ?? null;
            let registrationSequence: number | undefined;
            let agentAdmissionConfirmed = false;
            let coordinatorAdmissionConfirmed = false;
            try {
              if (admission.getCleanupCapability) {
                admissionCapability = await admission.getCleanupCapability(
                  runId,
                  {
                    agentId: id,
                    operationId: input.operationId,
                    requestHash,
                    runId,
                  }
                );
              }
              const { agentConfirmed, confirmation, coordinatorConfirmed } =
                await finalizePreparedAdmission(
                  agent,
                  admission,
                  runId,
                  input.operationId,
                  requestHash,
                  admissionCapability,
                  prepared.prepareOwner
                );
              agentAdmissionConfirmed = agentConfirmed;
              coordinatorAdmissionConfirmed = coordinatorConfirmed;
              if (confirmation && confirmation.kind !== "confirmed") {
                const terminal = await agent.getRun(runId);
                if (terminal && isTerminal(terminal.status)) {
                  await releaseTerminalAdmission(
                    directory,
                    terminal,
                    id,
                    admission
                  );
                  return json(
                    {
                      apiVersion: AGENT_RUNNER_API_VERSION,
                      run: terminal,
                    },
                    { status: 202 },
                    cors
                  );
                }
                if (
                  confirmation.kind === "stale_provisional" ||
                  confirmation.kind === "expired"
                ) {
                  await cleanupRun(agent, runId, id, {
                    admission,
                    admissionCapability:
                      confirmation.admissionCapability ??
                      admissionCapability ??
                      undefined,
                    prepareOwner:
                      confirmation.prepareOwner ?? prepared.prepareOwner,
                    stopFirst: true,
                  });
                }
                return busyResponse("global_busy", cors);
              }
              if (!coordinatorAdmissionConfirmed) {
                return await reconcilePreparedAdmissionOutcome(
                  directory,
                  agent,
                  runId,
                  id,
                  admission,
                  admissionCapability,
                  prepared.prepareOwner,
                  cors
                );
              }
              const beforeRegistration = await agent.getRun(runId);
              if (!beforeRegistration) {
                throw new Error(
                  "Admitted run disappeared before registration."
                );
              }
              const registered = await directory.registerRun(
                runId,
                id,
                directoryRunStatus(beforeRegistration)
              );
              if (!registrationSucceeded(registered)) {
                throw new Error("Run directory registration was ambiguous.");
              }
              registrationSequence = registeredSequence(registered);
              const admittedRun = await agent.getRun(runId);
              if (!admittedRun) {
                throw new Error("Admitted run disappeared after registration.");
              }
              if (
                (await markDirectoryRunStatus(directory, admittedRun, id)) ===
                false
              ) {
                throw new Error("Run directory status update was ambiguous.");
              }
              if (isTerminal(admittedRun.status)) {
                await releaseTerminalAdmission(
                  directory,
                  admittedRun,
                  id,
                  admission
                );
              }
              return json(
                {
                  apiVersion: AGENT_RUNNER_API_VERSION,
                  run: admittedRun,
                },
                { status: 202 },
                cors
              );
            } catch (error) {
              try {
                const unregistered = await directory.unregisterRun(
                  runId,
                  id,
                  registrationSequence
                );
                if (
                  unregistered === false &&
                  directory.enqueueRunMappingCleanup
                ) {
                  await directory.enqueueRunMappingCleanup(
                    runId,
                    id,
                    registrationSequence
                  );
                }
              } catch {
                if (directory.enqueueRunMappingCleanup) {
                  try {
                    await directory.enqueueRunMappingCleanup(
                      runId,
                      id,
                      registrationSequence
                    );
                  } catch {
                    // Preserve the original request failure.
                  }
                }
              }
              let cleanupCapability = admissionCapability;
              if (admission.getCleanupCapability) {
                try {
                  cleanupCapability = await admission.getCleanupCapability(
                    runId,
                    {
                      agentId: id,
                      operationId: input.operationId,
                      requestHash,
                      runId,
                    }
                  );
                } catch {
                  cleanupCapability = null;
                }
              }
              if (!cleanupCapability && admission.enqueueCleanup) {
                try {
                  await admission.enqueueCleanup(id, runId);
                } catch {
                  // Preserve the original registration failure.
                }
              }
              if (!agentAdmissionConfirmed || coordinatorAdmissionConfirmed) {
                await cleanupRun(agent, runId, id, {
                  admission,
                  admissionCapability: cleanupCapability ?? undefined,
                  allowUnowned: true,
                  prepareOwner: prepared.prepareOwner,
                  stopFirst: true,
                });
              }
              throw error;
            }
          }
        }

        const runMatch = url.pathname.match(
          /^\/api\/runs\/([^/]+)(?:\/(events|stop))?$/
        );
        if (runMatch) {
          const [, rawId, action] = runMatch;
          const runId = agentIdSchema.parse(decodeURIComponent(rawId ?? ""));
          const agentId = await directory.lookupRun(runId);
          if (!agentId) {
            throw new HttpError("Run was not found.", 404, "run_not_found");
          }
          const agent = await yoloAgent(agentId);
          /**
           * A run id resolves to an agent, so reaching a run without checking
           * that agent's owner would let anyone holding an id read, stream or
           * cancel another tenant's run. The ownership check belongs here,
           * before the action, not on the agent routes alone.
           */
          const owning = await agent.snapshot();
          if (!owning || tenantOf(owning) !== callerTenant) {
            throw new HttpError("Run was not found.", 404, "run_not_found");
          }
          if (!action && request.method === "GET") {
            const run = await agent.getRun(runId);
            if (!run) {
              throw new HttpError("Run was not found.", 404, "run_not_found");
            }
            return json(
              { apiVersion: AGENT_RUNNER_API_VERSION, run },
              {},
              cors
            );
          }
          if (action === "events" && request.method === "GET") {
            const lastEventId = parseLastEventId(request);
            const snapshot = await agent.getEventStream(runId, lastEventId);
            if (!snapshot) {
              throw new HttpError("Run was not found.", 404, "run_not_found");
            }
            return eventStream(
              createEventStream({
                lastEventId,
                read: (cursor) =>
                  Promise.resolve(agent.getEventStream(runId, cursor)),
                signal: request.signal,
              }),
              cors
            );
          }
          if (action === "stop" && request.method === "POST") {
            await readJson(request, true);
            const run = await agent.stop(runId);
            if (!run) {
              throw new HttpError("Run was not found.", 404, "run_not_found");
            }
            return json(
              { apiVersion: AGENT_RUNNER_API_VERSION, run },
              {},
              cors
            );
          }
        }

        throw new HttpError("Route was not found.", 404, "not_found");
      } catch (error) {
        return fail(error, cors);
      }
    },
  };
}
