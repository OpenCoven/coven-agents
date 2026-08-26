import { getSandbox } from "@cloudflare/sandbox";
import {
  type AgentDefinition,
  agentDefinitionSchema,
  type CommandEvidence,
  type FileEvidence,
  type RunEvent,
  type RunResult,
  type RunSnapshot,
  runAgentInputSchema,
  runSnapshotToResult,
  startRunInputSchema,
  type WarmState,
} from "@opencoven/agent-contracts";
import type {
  HarnessStatus,
  RunEvent as HarnessStreamEvent,
} from "@opencoven/harness";
import {
  Agent,
  type FiberRecoveryContext,
  type FiberRecoveryResult,
} from "agents";
import {
  HarnessError,
  listCloudHarnesses,
  PROBE_TIMEOUT_MS,
  RUN_TIMEOUT_MS,
  runHarnessInSandbox,
  warmSandbox,
} from "./harness-runner";
import {
  AlreadyRunningError,
  appendEvents,
  type CloudRunRecord,
  cloudFiberKey,
  dispatchCloudRun,
  finishCloudRunRecord,
  hashOperation,
  isTerminal,
  liveCloudRunEvent,
  nextEventId,
  OperationConflictError,
  planCloudRunStart,
  recoverCloudRunRecord,
  retainCloudRuns,
  validateCloudWorkspace,
} from "./run-state";
import { sandboxKey, tenantOf } from "./tenant";
import {
  fetchTenantCredential,
  normalizeCredential,
} from "./tenant-credentials";

type DirectoryState = {
  agents: AgentDefinition[];
  /**
   * Run id to agent id. A run route receives only a run id, and the Durable
   * Object that owns the run cannot be addressed without knowing which agent
   * it belongs to, so the mapping has to live somewhere both can reach.
   */
  runs?: Record<string, string>;
  pendingUnregisters?: Record<string, string>;
};

type AdmissionFence = {
  generation?: number;
  tokens?: string[];
};

type YoloAgentState = {
  admissionFences?: Record<string, AdmissionFence | string[]>;
  admissionTokens?: Record<string, string>;
  definition: AgentDefinition | null;
  identityTokens?: Record<string, string>;
  runs: CloudRunRecord[];
};

const WARM_FIBER_KEY = "warm";
const MAX_LEGACY_ADMISSION_FENCE_TOKENS = 32;
const MAX_ADMISSION_FENCE_TOMBSTONES = 128;

function dispatchGeneration(dispatchToken: string): number | undefined {
  const prefix = dispatchToken.match(/^([1-9]\d*):/u)?.[1];
  if (!prefix) {
    return;
  }
  const generation = Number(prefix);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

function normalizeAdmissionFence(
  fence: AdmissionFence | string[] | undefined
): AdmissionFence {
  if (Array.isArray(fence)) {
    return { tokens: fence };
  }
  return fence ?? {};
}

function rejectsAdmissionToken(
  fence: AdmissionFence | string[] | undefined,
  dispatchToken?: string
): boolean {
  const normalized = normalizeAdmissionFence(fence);
  if (normalized.generation !== undefined && !dispatchToken) {
    return true;
  }
  if (!dispatchToken) {
    return false;
  }
  const generation = dispatchGeneration(dispatchToken);
  if (
    normalized.generation !== undefined &&
    (generation === undefined || generation <= normalized.generation)
  ) {
    return true;
  }
  return normalized.tokens?.includes(dispatchToken) ?? false;
}

/**
 * How long a warmed-but-idle container is kept before it sleeps, and — the
 * same number on purpose — how long a recorded `ready` is trusted before a
 * new trigger re-probes. The container pool caps at ten lite instances, so
 * this is the paid-idle window per warmed profile, chosen to cover the gap
 * between creating a profile and typing its first mission.
 */
const WARM_SLEEP_AFTER = "10m";
const WARM_TRUST_WINDOW_MS = 10 * 60 * 1000;
/**
 * When a non-terminal run is provably a ghost: the probe deadline plus the
 * run deadline plus two minutes of margin for dispatch and persistence. No
 * live fiber can exist past this — both deadlines throw, and the catch
 * closes the record — so anything older with a live status was interrupted
 * before its catch could run.
 */
const RUN_OVERDUE_MS = PROBE_TIMEOUT_MS + RUN_TIMEOUT_MS + 120_000;

/**
 * The harness and the contract name file operations differently — the harness
 * reports `created`/`edited`/`deleted`, the contract accepts
 * `create`/`modify`/`delete`. Translating explicitly is the point: filtering to
 * the values the contract allows would have matched none of them and dropped
 * every file operation without a word.
 */
export const FILE_OPERATIONS: Record<string, FileEvidence["operation"]> = {
  created: "create",
  deleted: "delete",
  edited: "modify",
};

export function toFileEvidence(
  operations: { operation: string; path: string }[]
): FileEvidence[] {
  return operations.flatMap((entry) => {
    const operation = Object.hasOwn(FILE_OPERATIONS, entry.operation)
      ? FILE_OPERATIONS[entry.operation]
      : undefined;
    if (!operation) {
      // An unmapped verb means the harness grew one the contract has not
      // learned. Say so rather than discarding the evidence silently.
      console.warn(
        JSON.stringify({
          event: "runner.evidence.unmapped_file_operation",
          operation: entry.operation,
        })
      );
      return [];
    }
    return [{ operation, path: entry.path }];
  });
}

/**
 * Delegates to the contract so the worker and the browser client cannot
 * disagree about how a snapshot becomes a result.
 */
export function toRunResult(record: CloudRunRecord): RunResult {
  return runSnapshotToResult(record.run);
}

export class AgentDirectory extends Agent<Env, DirectoryState> {
  initialState: DirectoryState = {
    agents: [],
    pendingUnregisters: {},
    runs: {},
  };

  list(tenantId: string): AgentDefinition[] {
    this.drainPendingUnregisters();
    return this.state.agents
      .filter((agent) => tenantOf(agent) === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  upsert(definition: AgentDefinition): AgentDefinition {
    const parsed = agentDefinitionSchema.parse(definition);
    this.setState({
      // Spread first: replacing the whole object would drop the run index and
      // orphan every run id already registered against this directory.
      ...this.state,
      agents: [
        parsed,
        ...this.state.agents.filter((agent) => agent.id !== parsed.id),
      ],
    });
    return parsed;
  }

  remove(agentId: string): void {
    // Drops the agent's run index with it. Leaving entries behind would let a
    // stale run id resolve to an agent that no longer exists, and the run
    // route would then address an empty Durable Object rather than 404.
    const runs = Object.fromEntries(
      Object.entries(this.state.runs ?? {}).filter(
        ([, owner]) => owner !== agentId
      )
    );
    this.setState({
      agents: this.state.agents.filter((agent) => agent.id !== agentId),
      runs,
    });
  }

  registerRun(runId: string, agentId: string): boolean {
    const runs = this.state.runs ?? {};
    if (Object.hasOwn(runs, runId)) {
      return false;
    }
    this.setState({
      ...this.state,
      runs: { ...runs, [runId]: agentId },
    });
    return true;
  }

  unregisterRun(runId: string, agentId: string): boolean {
    this.drainPendingUnregisters();
    const runs = this.state.runs ?? {};
    if (!Object.hasOwn(runs, runId) || runs[runId] !== agentId) {
      return false;
    }
    const remaining = { ...runs };
    delete remaining[runId];
    this.setState({ ...this.state, runs: remaining });
    return true;
  }

  lookupRun(runId: string): string | null {
    this.drainPendingUnregisters();
    // Own-property check: a run id of "constructor" or "__proto__" would
    // otherwise resolve to something off Object.prototype and be treated as an
    // agent id.
    const runs = this.state.runs ?? {};
    return Object.hasOwn(runs, runId) ? (runs[runId] ?? null) : null;
  }

  enqueueRunMappingCleanup(runId: string, agentId: string): void {
    this.setState({
      ...this.state,
      pendingUnregisters: {
        ...(this.state.pendingUnregisters ?? {}),
        [runId]: agentId,
      },
    });
  }

  private drainPendingUnregisters(): void {
    const pending = this.state.pendingUnregisters ?? {};
    const entries = Object.entries(pending);
    if (entries.length === 0) {
      return;
    }
    const runs = { ...(this.state.runs ?? {}) };
    const remaining = { ...pending };
    for (const [runId, agentId] of entries) {
      if (runs[runId] === agentId) {
        delete runs[runId];
      }
      delete remaining[runId];
    }
    this.setState({ ...this.state, pendingUnregisters: remaining, runs });
  }

  harnesses(): Promise<HarnessStatus[]> {
    return listCloudHarnesses(
      getSandbox(this.env.Sandbox, "harness-probe", {
        enableDefaultSession: false,
        sleepAfter: "30s",
      })
    );
  }
}

export class YoloAgent extends Agent<Env, YoloAgentState> {
  initialState: YoloAgentState = {
    admissionFences: {},
    admissionTokens: {},
    definition: null,
    identityTokens: {},
    runs: [],
  };
  private readonly admissionReleaseInFlight = new Map<string, Promise<void>>();
  private readonly admissionReleaseCompleted = new Set<string>();

  configure(definition: AgentDefinition): AgentDefinition {
    const parsed = agentDefinitionSchema.parse(definition);
    this.setState({ ...this.state, definition: parsed });
    return parsed;
  }

  snapshot(): AgentDefinition | null {
    return this.state.definition;
  }

  private requireDefinition(): AgentDefinition {
    const { definition } = this.state;
    if (!definition) {
      throw new Error("Agent has not been configured.");
    }
    return definition;
  }

  /**
   * Executes the mission by driving an already-signed-in coding CLI inside the
   * sandbox. The Worker never calls a model provider, so no provider API key
   * exists in this path — only the tenant's own harness credential, borrowed
   * for this run and handed to the harness under its documented environment
   * variable name.
   */
  async execute(input: unknown, identityToken: string): Promise<RunResult> {
    const { task } = runAgentInputSchema.parse(input);
    const definition = this.requireDefinition();

    // Rejects anything but the /workspace scratch sandbox before a container is
    // started, so a bad workspace fails as a request error rather than as a
    // half-executed run.
    validateCloudWorkspace(definition);

    const createdAt = new Date().toISOString();
    const runId = crypto.randomUUID();
    /**
     * The HTTP route does not carry an operation id yet, so each call gets a
     * fresh one and nothing deduplicates. The plan is still the right way in:
     * it is the single place that decides whether a run may start, and it
     * refuses while another is active. Threading a client-supplied id through
     * later turns that dedup on without moving the decision.
     */
    const operationId = crypto.randomUUID();
    const plan = planCloudRunStart({
      agentId: definition.id,
      createdAt,
      operationHash: await hashOperation(definition.id, task),
      operationId,
      records: this.state.runs,
      runId,
      task,
    });

    if (plan.kind === "already_running") {
      throw new AlreadyRunningError();
    }
    if (plan.kind === "conflict") {
      throw new OperationConflictError();
    }
    if (plan.kind === "existing") {
      /**
       * Unreachable while `execute` mints its own operation id, so this can
       * only be a replay of a run that is already recorded.
       *
       * It previously projected the record onto a result unconditionally,
       * which would have reported a run still in flight as failed — `execute`
       * promises a finished outcome and has none to give here. A terminal
       * record is returned; anything else is reported as still running.
       */
      if (isTerminal(plan.record.run.status)) {
        return toRunResult(plan.record);
      }
      throw new AlreadyRunningError();
    }

    return toRunResult(
      await this.driveHarness(definition, plan.record, task, identityToken)
    );
  }

  /**
   * Borrows the tenant's own harness credential for the duration of this run.
   *
   * The worker holds no key material of its own — it asks the Next app, the
   * sole custodian, over an internal service call. `APP_ORIGIN` and
   * `RUNNER_SERVICE_TOKEN` missing is a deployment misconfiguration, not an
   * absent credential, so it fails closed with a thrown error rather than
   * quietly resolving to null and letting `requireHarness` report it as
   * merely "not signed in".
   */
  private async resolveTenantCredential(
    definition: AgentDefinition,
    identityToken: string,
    runId: string
  ): Promise<string | null> {
    const { APP_ORIGIN, RUNNER_SERVICE_TOKEN } = this.env;
    if (!APP_ORIGIN || !RUNNER_SERVICE_TOKEN) {
      throw new Error(
        "APP_ORIGIN and RUNNER_SERVICE_TOKEN must be configured to fetch a tenant credential."
      );
    }
    const fetched = await fetchTenantCredential(
      { harnessId: definition.runtime, runId, tenant: tenantOf(definition) },
      {
        endpoint: APP_ORIGIN,
        // Wrapped, never passed bare. A Workers built-in detached from its
        // receiver throws "Illegal invocation: function called with incorrect
        // `this` reference" the moment it is called -- which surfaced as a
        // failed run with zero commands and zero file operations, because the
        // credential fetch died before the sandbox ever started.
        fetchImpl: (input, init) => fetch(input, init),
        identityToken,
        serviceToken: RUNNER_SERVICE_TOKEN,
      }
    );

    // Normalised exactly once, here, because two consumers must agree on the
    // bytes: `requireHarness` trims before injecting into the sandbox, and the
    // same value is handed to evidence redaction. Trimming in only one of them
    // means the harness uses one string while redaction searches for another,
    // and a credential stored with stray whitespace leaks into stored output.
    return normalizeCredential(fetched);
  }

  /**
   * Drives the harness for one planned run and records the outcome.
   *
   * Shared by `execute`, which awaits it, and `start`, which runs it inside a
   * fiber. Keeping one body means the synchronous and asynchronous paths cannot
   * disagree about how evidence is captured or how a failure is recorded.
   */
  protected async driveHarness(
    definition: AgentDefinition,
    planned: CloudRunRecord,
    task: string,
    identityToken: string,
    signal?: AbortSignal
  ): Promise<CloudRunRecord> {
    let record = this.claimRunStart(planned);

    // Declared outside the try block, not `const` inside it: the catch
    // block below also hands its outcome to `finishCloudRunRecord`, and if
    // resolution itself throws (or something later throws with the
    // credential already in hand) that path needs the same value in scope
    // to redact with — never an unset variable that would either crash or,
    // worse, silently skip redaction.
    let credential: string | null = null;
    try {
      credential = await this.resolveTenantCredential(
        definition,
        identityToken,
        planned.run.id
      );
      /**
       * Streams each harness event into the record as it happens, so the
       * console shows what the run is doing rather than a spinner. Redaction
       * happens inside `liveCloudRunEvent` before the event exists; the
       * incremental persist is what the event stream reads, so a watcher
       * sees the activity within a poll interval of it occurring.
       */
      const toolNames = new Map<string, string>();
      const onEvent = (streamedEvent: HarnessStreamEvent) => {
        const mapped = liveCloudRunEvent(
          streamedEvent,
          nextEventId(record),
          credential,
          toolNames
        );
        if (mapped) {
          record = appendEvents(record, [mapped]);
          this.persistRun(record);
        }
      };

      const run = await runHarnessInSandbox({
        credential: { credential },
        instructions: `${definition.instructions}

You are running in a dedicated cloud sandbox. Tool calls are pre-approved. Work only inside the sandbox, verify the result, and include exact evidence in your final response.`,
        model: definition.model,
        onEvent,
        runtime: definition.runtime,
        sandbox: getSandbox(
          this.env.Sandbox,
          await sandboxKey(tenantOf(definition), definition.id),
          // Chosen rather than inherited: the same idle window the warm-up
          // uses, so a warmed container and a run container age identically.
          { sleepAfter: WARM_SLEEP_AFTER }
        ),
        signal,
        task,
        workspace: definition.workspace,
      });

      const completedAt = new Date().toISOString();
      const failed = run.summary.status === "failed" || run.exitCode !== 0;
      // A harness tool call is {tool, summary, success}, which is not the
      // command-evidence shape, so the translation is explicit. Everything is
      // handed to finishCloudRunRecord rather than trimmed here: that is where
      // evidence is redacted, normalized and capped, and doing any of it twice
      // would risk the two disagreeing.
      const commandEvidence: CommandEvidence[] = [
        {
          command: run.command,
          exitCode: run.exitCode,
          stderr: run.stderr,
          stdout: run.summary.output,
        },
        // A tool call has no streams of its own, so its summary is the stdout
        // and stderr stays empty rather than duplicating it into both.
        ...run.summary.toolCalls.map((call) => ({
          command: call.tool,
          exitCode: call.success ? 0 : 1,
          stderr: "",
          stdout: call.summary,
        })),
      ];
      const fileEvidence = toFileEvidence(run.summary.fileOperations);

      record = finishCloudRunRecord(record, {
        commandEvidence,
        completedAt,
        credential,
        fileEvidence,
        output:
          run.summary.output ||
          run.stderr.trim() ||
          "The harness produced no output.",
        status: failed ? "failed" : "completed",
      });
      if (this.persistRun(record)) {
        this.updateDefinition({
          lastRunAt: completedAt,
          status: failed ? "error" : "idle",
          updatedAt: completedAt,
        });
        return record;
      }
      return (
        this.state.runs.find(
          (candidate) => candidate.run.id === planned.run.id
        ) ?? record
      );
    } catch (error) {
      /**
       * A timed-out exec means the container is suspect, not just the run:
       * the process that blew the deadline is still in there consuming the
       * lite instance's CPU, and — observed tonight — every retry then
       * queues onto the starved container while its probes count as
       * activity, so the zombie never even idles out. Destroying the
       * sandbox costs the next run one clean cold start instead of
       * inheriting a wedged one. Failure to destroy is swallowed: the run
       * is already failed, and the idle reaper remains the backstop.
       */
      if (error instanceof HarnessError && error.code === "harness_timeout") {
        console.warn({
          agentId: definition.id,
          event: "sandbox.reap_after_timeout",
          runId: planned.run.id,
        });
        await getSandbox(
          this.env.Sandbox,
          await sandboxKey(tenantOf(definition), definition.id)
        )
          .destroy()
          .catch(() => undefined);
      }
      const completedAt = new Date().toISOString();
      record = finishCloudRunRecord(record, {
        completedAt,
        credential,
        error: {
          code:
            error instanceof HarnessError ? "harness_failed" : "internal_error",
          message:
            error instanceof Error ? error.message : "Agent execution failed.",
          retryable: false,
        },
        output:
          error instanceof Error ? error.message : "Agent execution failed.",
        status: "failed",
      });
      if (this.persistRun(record)) {
        this.updateDefinition({
          lastRunAt: completedAt,
          status: "error",
          updatedAt: completedAt,
        });
        return record;
      }
      return (
        this.state.runs.find(
          (candidate) => candidate.run.id === planned.run.id
        ) ?? record
      );
    }
  }

  /**
   * Accepts a run and returns immediately, leaving the harness executing in a
   * durable fiber.
   *
   * `startRunInputSchema` carries an operation id, so unlike `execute` this
   * path deduplicates: replaying the same id returns the recorded run rather
   * than starting a second one, and reusing it for a different task is a
   * conflict. The fiber is keyed on the run id so `stop` can find it.
   */
  /**
   * `identityToken` is the signed claim the caller presented. It is carried
   * through to the credential fetch so the app can bind the request to a
   * tenant rather than trusting one named in a request body. The fiber starts
   * immediately, well inside the token's lifetime.
   */
  async start(
    input: unknown,
    identityToken: string
  ): Promise<{ created: boolean; run: RunSnapshot }> {
    const { operationId, task } = startRunInputSchema.parse(input);
    const definition = this.requireDefinition();
    validateCloudWorkspace(definition);

    const plan = planCloudRunStart({
      agentId: definition.id,
      createdAt: new Date().toISOString(),
      operationHash: await hashOperation(definition.id, task),
      operationId,
      records: this.state.runs,
      runId: crypto.randomUUID(),
      task,
    });

    if (plan.kind === "already_running") {
      throw new AlreadyRunningError();
    }
    if (plan.kind === "conflict") {
      throw new OperationConflictError();
    }

    /**
     * Recorded before dispatch, not inside the fiber. Answering 202 promises
     * the run exists, so it has to be readable the instant the caller is told
     * about it. Persisting only once the fiber begins leaves a window where
     * `getRun` returns null, `stop` cannot find it, and the concurrency guard
     * sees no active run and admits a second one.
     */
    this.persistRun(plan.record);

    return await dispatchCloudRun(plan, (record, fiberKey) =>
      this.startFiber(
        fiberKey,
        async (fiber) => {
          try {
            await this.driveHarness(
              definition,
              record,
              task,
              identityToken,
              fiber.signal
            );
          } finally {
            await this.reportAdmissionTerminal(record.run.id);
          }
        },
        // Keyed on the fiber key rather than the operation id: `stop` cancels
        // by run, and a run is what a caller can name.
        { idempotencyKey: fiberKey, metadata: { runId: record.run.id } }
      )
    );
  }

  /**
   * Records a run after the admission object has accepted it, but does not
   * create a sandbox or dispatch a fiber. Queued runs keep their identity
   * token in this agent's durable state until they are dispatched; the global
   * admission object stores only the pseudonymous tenant hash.
   */
  enqueue(
    input: unknown,
    runId: string,
    requestHash: string,
    identityToken: string
  ): Promise<{ created: boolean; run: RunSnapshot }> {
    const { operationId, task } = startRunInputSchema.parse(input);
    const definition = this.requireDefinition();
    validateCloudWorkspace(definition);

    const plan = planCloudRunStart(
      {
        agentId: definition.id,
        createdAt: new Date().toISOString(),
        operationHash: requestHash,
        operationId,
        records: this.state.runs,
        runId,
        task,
      },
      { allowQueued: true }
    );
    if (plan.kind === "conflict") {
      throw new OperationConflictError();
    }
    if (plan.kind === "existing") {
      return Promise.resolve({ created: false, run: plan.record.run });
    }

    this.persistRun(plan.record);
    this.setState({
      ...this.state,
      identityTokens: {
        ...(this.state.identityTokens ?? {}),
        [runId]: identityToken,
      },
    });
    return Promise.resolve({ created: true, run: plan.record.run });
  }

  /**
   * Starts a run selected by RunAdmission. The admission object marks its
   * record active before this RPC, and a terminal callback in `finally`
   * releases that capacity even when the harness throws.
   */
  async startAdmitted(runId: string, dispatchToken?: string): Promise<boolean> {
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (
      rejectsAdmissionToken(this.state.admissionFences?.[runId], dispatchToken)
    ) {
      return false;
    }
    if (!record || isTerminal(record.run.status)) {
      return false;
    }
    if (
      dispatchToken &&
      record.run.status !== "queued" &&
      record.dispatchToken !== dispatchToken
    ) {
      return false;
    }
    const identityToken = this.state.identityTokens?.[runId];
    if (!identityToken) {
      throw new Error("Queued run identity is unavailable.");
    }
    const definition = this.requireDefinition();
    if (dispatchToken) {
      const tokenized = { ...record, dispatchToken };
      this.persistRun(tokenized, { allowDispatchTokenReplacement: true });
      this.setState({
        ...this.state,
        admissionTokens: {
          ...(this.state.admissionTokens ?? {}),
          [runId]: dispatchToken,
        },
      });
    }
    const claimed = this.claimRunStart(
      dispatchToken ? { ...record, dispatchToken } : record
    );
    const token = claimed.dispatchToken;
    try {
      const receipt = await this.startFiber(
        cloudFiberKey(runId),
        async (fiber) => {
          try {
            await this.driveHarness(
              definition,
              claimed,
              claimed.run.task,
              identityToken,
              fiber.signal
            );
          } finally {
            if (
              fiber.signal.aborted &&
              this.dispatchTokenMatches(runId, token)
            ) {
              await this.destroyAgentSandbox(definition);
            }
            await this.reportAdmissionTerminal(runId, token);
          }
        },
        {
          idempotencyKey: cloudFiberKey(runId),
          metadata: {
            runId,
            ...(token ? { dispatchToken: token } : {}),
          },
        }
      );
      if (!receipt.accepted) {
        if (receipt.status !== "pending" && receipt.status !== "running") {
          await this.failRunAfterDispatchError(
            runId,
            new Error("An existing cloud run fiber was no longer active."),
            token
          );
          await this.reportAdmissionTerminal(runId, token);
        }
        return false;
      }
    } catch (error) {
      await this.failRunAfterDispatchError(runId, error, token);
      await this.reportAdmissionTerminal(runId, token);
      throw error;
    }
    return true;
  }

  /**
   * Durably rejects a dispatch that the admission coordinator is about to
   * requeue. The queued status check and fence write happen in this Agent
   * Durable Object before the RPC yields, so a start that wins the race makes
   * this return false and keeps the coordinator's claim active.
   */
  fenceAdmitted(runId: string, dispatchToken: string): boolean {
    if (!dispatchToken) {
      return false;
    }
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (record && record.run.status !== "queued") {
      return false;
    }
    const existing = normalizeAdmissionFence(
      this.state.admissionFences?.[runId]
    );
    const generation = dispatchGeneration(dispatchToken);
    if (
      generation !== undefined &&
      existing.generation !== undefined &&
      existing.generation >= generation
    ) {
      return true;
    }
    if (generation === undefined && existing.tokens?.includes(dispatchToken)) {
      return true;
    }
    let nextFence: AdmissionFence;
    if (generation === undefined) {
      nextFence = {
        ...existing,
        tokens: [
          ...(existing.tokens ?? []).filter((token) => token !== dispatchToken),
          dispatchToken,
        ].slice(-MAX_LEGACY_ADMISSION_FENCE_TOKENS),
      };
    } else {
      nextFence = {
        ...existing,
        generation: Math.max(existing.generation ?? 0, generation),
      };
    }
    this.setState({
      ...this.state,
      admissionFences: this.pruneAdmissionFences({
        ...(this.state.admissionFences ?? {}),
        [runId]: nextFence,
      }),
    });
    return true;
  }

  private pruneAdmissionFences(
    fences: Record<string, AdmissionFence | string[]>
  ): Record<string, AdmissionFence | string[]> {
    const entries = Object.entries(fences);
    if (entries.length <= MAX_ADMISSION_FENCE_TOMBSTONES) {
      return fences;
    }
    return Object.fromEntries(entries.slice(-MAX_ADMISSION_FENCE_TOMBSTONES));
  }

  async onFiberRecovered(
    context: FiberRecoveryContext
  ): Promise<undefined | FiberRecoveryResult> {
    const metadataRunId = context.metadata?.runId;
    const metadataDispatchToken = context.metadata?.dispatchToken;
    const recoveredDispatchToken =
      typeof metadataDispatchToken === "string"
        ? metadataDispatchToken
        : undefined;
    const runId =
      typeof metadataRunId === "string"
        ? metadataRunId
        : context.name.startsWith("run:")
          ? context.name.slice("run:".length)
          : null;
    if (!runId) {
      const recovered = await super.onFiberRecovered(context);
      return recovered === undefined ? undefined : recovered;
    }

    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!current) {
      return {
        error: "Cloud run record was not retained after fiber recovery.",
        status: "error",
      };
    }
    const currentDispatchToken =
      current.dispatchToken ?? this.state.admissionTokens?.[runId];
    if (
      currentDispatchToken &&
      currentDispatchToken !== recoveredDispatchToken
    ) {
      return {
        reason: "Recovered fiber belongs to an obsolete admission dispatch.",
        status: "aborted",
      };
    }
    await this.destroyAgentSandbox();
    if (isTerminal(current.run.status)) {
      await this.reportAdmissionTerminal(
        runId,
        recoveredDispatchToken ?? currentDispatchToken
      );
      if (current.run.status === "cancelled") {
        return {
          reason: "Run was cancelled before recovery.",
          status: "aborted",
        };
      }
      return current.run.status === "completed"
        ? { status: "completed" }
        : {
            error:
              current.run.error?.message ??
              "Cloud run was already failed before fiber recovery.",
            status: "error",
          };
    }

    const recovered = recoverCloudRunRecord(current, new Date().toISOString());
    if (this.persistRun(recovered)) {
      this.updateDefinition({
        lastRunAt: recovered.run.completedAt ?? new Date().toISOString(),
        status: "error",
        updatedAt: recovered.run.completedAt ?? new Date().toISOString(),
      });
    }
    await this.reportAdmissionTerminal(
      runId,
      recoveredDispatchToken ?? currentDispatchToken
    );
    return {
      error: recovered.run.error?.message ?? "Cloud run was interrupted.",
      status: "error",
    };
  }

  /**
   * Claims the only agent execution slot before any asynchronous fiber call.
   * Admission can retry the same RPC, but two different run ids cannot both
   * observe a free slot while the first fiber is still being accepted.
   */
  private claimRunStart(planned: CloudRunRecord): CloudRunRecord {
    const current =
      this.state.runs.find(
        (candidate) => candidate.run.id === planned.run.id
      ) ?? planned;
    if (
      planned.dispatchToken &&
      current.dispatchToken !== planned.dispatchToken
    ) {
      throw new Error("Cloud run dispatch is obsolete.");
    }
    if (isTerminal(current.run.status)) {
      throw new AlreadyRunningError();
    }
    const active = this.state.runs.find(
      (candidate) =>
        candidate.run.id !== current.run.id &&
        candidate.run.status === "running"
    );
    if (active) {
      throw new AlreadyRunningError();
    }
    if (current.run.status === "running") {
      return current;
    }
    const startedAt = new Date().toISOString();
    const claimed = appendEvents(
      {
        ...current,
        run: { ...current.run, startedAt, status: "running" as const },
      },
      [
        {
          at: startedAt,
          id: nextEventId(current),
          status: "running",
          type: "status",
        },
      ]
    );
    this.persistRun(claimed);
    this.updateDefinition({ status: "running", updatedAt: startedAt });
    return claimed;
  }

  private failRunAfterDispatchError(
    runId: string,
    error: unknown,
    dispatchToken?: string
  ): void {
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!current || isTerminal(current.run.status)) {
      return;
    }
    if (dispatchToken && current.dispatchToken !== dispatchToken) {
      return;
    }
    const completedAt = new Date().toISOString();
    const failed = finishCloudRunRecord(current, {
      completedAt,
      credential: null,
      error: {
        code: "internal_error",
        message:
          error instanceof Error
            ? error.message
            : "Cloud run fiber could not be started.",
        retryable: false,
      },
      output:
        error instanceof Error
          ? error.message
          : "Cloud run fiber could not be started.",
      status: "failed",
    });
    if (this.persistRun(failed)) {
      this.updateDefinition({
        lastRunAt: completedAt,
        status: "error",
        updatedAt: completedAt,
      });
    }
  }

  /** Removes a prepared run when admission refuses it before dispatch. */
  discardRun(runId: string): boolean {
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (record?.run.status !== "queued") {
      return false;
    }
    this.setState({
      ...this.state,
      admissionFences: Object.fromEntries(
        Object.entries(this.state.admissionFences ?? {}).filter(
          ([candidate]) => candidate !== runId
        )
      ),
      identityTokens: Object.fromEntries(
        Object.entries(this.state.identityTokens ?? {}).filter(
          ([candidate]) => candidate !== runId
        )
      ),
      runs: this.state.runs.filter((candidate) => candidate.run.id !== runId),
    });
    return true;
  }

  /**
   * Cancels a run that is still in flight and records it as cancelled.
   *
   * Cancelling the fiber is not enough on its own — a cancelled fiber simply
   * stops, leaving the record stuck in `running` forever. The record has to be
   * closed here so a caller polling the run sees a terminal state.
   */
  async stop(
    runId: string,
    dispatchToken?: string,
    reason = "Run cancelled by operator request."
  ): Promise<RunSnapshot | null> {
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!record) {
      return null;
    }
    const currentDispatchToken =
      record.dispatchToken ?? this.state.admissionTokens?.[runId];
    const expectedDispatchToken = dispatchToken ?? currentDispatchToken;
    if (dispatchToken && currentDispatchToken !== dispatchToken) {
      return record.run;
    }
    if (isTerminal(record.run.status)) {
      // Already finished. Cancelling would be a no-op and rewriting the record
      // would discard the real outcome.
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      return record.run;
    }

    await this.cancelFiberByKey(cloudFiberKey(runId), "Cancelled by operator.");
    const afterCancel = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (
      expectedDispatchToken &&
      !this.dispatchTokenMatches(runId, expectedDispatchToken)
    ) {
      return afterCancel?.run ?? null;
    }
    await this.destroyAgentSandbox();
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!current) {
      return null;
    }
    if (
      expectedDispatchToken &&
      !this.dispatchTokenMatches(runId, expectedDispatchToken)
    ) {
      return current.run;
    }
    if (isTerminal(current.run.status)) {
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      return current.run;
    }
    const cancelled = finishCloudRunRecord(current, {
      completedAt: new Date().toISOString(),
      // Cancellation is an operator action outside `driveHarness`, so no
      // credential is in scope here — the static message below carries none,
      // and the run's already-persisted evidence was redacted when it was
      // first captured.
      credential: null,
      output: reason,
      status: "cancelled",
    });
    if (this.persistRun(cancelled)) {
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      this.updateDefinition({
        status: "idle",
        updatedAt: cancelled.run.completedAt ?? new Date().toISOString(),
      });
      return cancelled.run;
    }
    const latest = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (latest) {
      await this.reportAdmissionTerminal(runId, expectedDispatchToken);
      return latest.run;
    }
    return null;
  }

  /**
   * Events recorded after `lastEventId`, plus whether the run has finished.
   *
   * `terminal` is what lets the stream close rather than poll forever, so it
   * reports the run's status and not whether this batch happened to be empty.
   */
  /**
   * Closes any run that is provably dead but still marked live.
   *
   * Every path a run can take is bounded — the probe at 300s, the exec at
   * 900s — so a record still non-terminal past their sum plus margin has no
   * fiber behind it: the fiber either finished the record or died with a
   * restart before it could. `onFiberRecovered` is the fast path for that
   * case, but it was observed not firing for fibers interrupted by tonight's
   * deploys, and three ghost runs kept their agents' active-run slots and
   * their consoles reconnecting once a minute for an hour. Reconciling on
   * the read path is deterministic: the very next poll of a ghost closes it.
   */
  private reconcileOverdueRuns(): void {
    const now = Date.now();
    const completedAt = new Date(now).toISOString();
    let changed = false;
    const runs = this.state.runs.map((record) => {
      if (
        isTerminal(record.run.status) ||
        now - Date.parse(record.run.createdAt) < RUN_OVERDUE_MS
      ) {
        return record;
      }
      changed = true;
      console.warn({
        event: "run.recovered_after_interruption",
        runId: record.run.id,
        via: "overdue_reconcile",
      });
      return recoverCloudRunRecord(record, completedAt);
    });
    if (changed) {
      this.setState({ ...this.state, runs });
      if (this.state.definition) {
        this.updateDefinition({ status: "error", updatedAt: completedAt });
      }
    }
  }

  getEventStream(
    runId: string,
    lastEventId: number
  ): { events: RunEvent[]; terminal: boolean } | null {
    this.reconcileOverdueRuns();
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!record) {
      return null;
    }
    return {
      events: record.events.filter((event) => event.id > lastEventId),
      terminal: isTerminal(record.run.status),
    };
  }

  /** The recorded snapshot for one run, or null when this agent has no such run. */
  getRun(runId: string): RunSnapshot | null {
    this.reconcileOverdueRuns();
    return (
      this.state.runs.find((record) => record.run.id === runId)?.run ?? null
    );
  }

  /** Every run this agent still retains, newest first. */
  listRuns(): RunSnapshot[] {
    this.reconcileOverdueRuns();
    return [...this.state.runs]
      .sort(
        (left, right) =>
          Date.parse(right.run.createdAt) - Date.parse(left.run.createdAt)
      )
      .map((record) => record.run);
  }

  /**
   * Boots this agent's sandbox ahead of its next run.
   *
   * Fire-and-settle: the caller gets `provisioning` back as soon as the
   * fiber is spawned, and the fiber records `ready` or `failed` when the
   * probe answers. Idempotent by fiber key — a second trigger while one is
   * booting joins it, and a `ready` state younger than the container's idle
   * window is trusted rather than re-probed, so a burst of triggers cannot
   * boot anything twice. Warming never touches the credential route: no run
   * is counted and no credential is ever in scope here.
   */
  async warm(): Promise<WarmState> {
    const definition = this.requireDefinition();
    const current = definition.warm;
    const now = Date.now();
    if (
      current &&
      current.status !== "not_started" &&
      current.status !== "failed" &&
      now - Date.parse(current.updatedAt) < WARM_TRUST_WINDOW_MS
    ) {
      return current;
    }

    const provisioning: WarmState = {
      status: "provisioning",
      updatedAt: new Date(now).toISOString(),
    };
    this.updateDefinition({ warm: provisioning });

    await this.startFiber(
      WARM_FIBER_KEY,
      async () => {
        await this.driveWarm(definition);
      },
      { idempotencyKey: WARM_FIBER_KEY }
    );
    return provisioning;
  }

  private async driveWarm(definition: AgentDefinition): Promise<void> {
    const startedAt = Date.now();
    const outcome = await warmSandbox(
      getSandbox(
        this.env.Sandbox,
        await sandboxKey(tenantOf(definition), definition.id),
        { sleepAfter: WARM_SLEEP_AFTER }
      ),
      definition.runtime
    );
    console.log({
      agentId: definition.id,
      durationMs: Date.now() - startedAt,
      event: "sandbox.warm",
      outcome: outcome.ready ? "ready" : "failed",
      version: outcome.version,
    });
    // The agent may have been decommissioned while the container booted; a
    // cleared definition must stay cleared rather than be resurrected by a
    // late warm result.
    if (this.state.definition?.id === definition.id) {
      this.updateDefinition({
        warm: {
          status: outcome.ready ? "ready" : "failed",
          updatedAt: new Date().toISOString(),
        },
      });
    }
  }

  /**
   * Closes the records of fibers a restart killed.
   *
   * A worker deploy interrupts every in-flight fiber, and until this hook
   * existed the run it was driving stayed `running` forever: the console
   * streamed it endlessly, the active-run guard refused new runs, and
   * nothing anywhere would ever change either fact. `recoverCloudRunRecord`
   * was written for exactly this and then never wired to anything — this is
   * the wiring. An interrupted warm just becomes `failed`; the next trigger
   * re-warms.
   */
  override onFiberRecovered(context: {
    name: string;
  }): Promise<{ status: "completed" }> {
    const completedAt = new Date().toISOString();
    if (context.name === WARM_FIBER_KEY && this.state.definition) {
      this.updateDefinition({
        warm: { status: "failed", updatedAt: completedAt },
      });
      return Promise.resolve({ status: "completed" });
    }

    const record = this.state.runs.find(
      (candidate) =>
        cloudFiberKey(candidate.run.id) === context.name &&
        !isTerminal(candidate.run.status)
    );
    if (record) {
      console.warn({
        event: "run.recovered_after_interruption",
        runId: record.run.id,
      });
      this.persistRun(recoverCloudRunRecord(record, completedAt));
      this.updateDefinition({ status: "error", updatedAt: completedAt });
    }
    return Promise.resolve({ status: "completed" });
  }

  private async destroyAgentSandbox(
    definition = this.requireDefinition()
  ): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Retries must be ordered to bound cleanup.
        await getSandbox(
          this.env.Sandbox,
          await sandboxKey(tenantOf(definition), definition.id)
        ).destroy();
        return;
      } catch (error) {
        failure = error;
      }
    }
    throw failure instanceof Error
      ? failure
      : new Error("Agent sandbox cleanup failed.");
  }

  async decommission(): Promise<void> {
    const { definition } = this.state;
    if (definition) {
      await this.cancelFiberByKey(
        WARM_FIBER_KEY,
        "Agent decommissioned during warm-up."
      );
      await getSandbox(
        this.env.Sandbox,
        await sandboxKey(tenantOf(definition), definition.id)
      ).destroy();
    }
    this.setState(this.initialState);
  }

  private updateDefinition(
    patch: Partial<
      Pick<AgentDefinition, "status" | "updatedAt" | "lastRunAt" | "warm">
    >
  ): AgentDefinition {
    const current = this.state.definition;
    if (!current) {
      throw new Error("Agent has not been configured.");
    }
    const definition = { ...current, ...patch };
    this.setState({ ...this.state, definition });
    return definition;
  }

  /**
   * Writes one run record, replacing any earlier revision of the same run so a
   * queued entry is superseded rather than duplicated as it progresses.
   *
   * Retention is delegated to `retainCloudRuns`, which keeps every active run
   * and only trims terminal ones. The previous `slice(0, 20)` counted from the
   * front of an unsorted list, so a long-running agent could have dropped a run
   * that was still executing.
   */
  private persistRun(
    record: CloudRunRecord,
    options: { allowDispatchTokenReplacement?: boolean } = {}
  ): boolean {
    const current = this.state.runs.find(
      (candidate) => candidate.run.id === record.run.id
    );
    if (
      current &&
      current.dispatchToken !== record.dispatchToken &&
      !options.allowDispatchTokenReplacement
    ) {
      return false;
    }
    if (
      current &&
      (isTerminal(current.run.status) ||
        (current.run.status === "running" && record.run.status === "queued"))
    ) {
      return false;
    }
    const others = this.state.runs.filter(
      (candidate) => candidate.run.id !== record.run.id
    );
    const runs = retainCloudRuns([record, ...others]);
    const retainedRunIds = new Set(runs.map((candidate) => candidate.run.id));
    this.setState({
      ...this.state,
      admissionFences: Object.fromEntries(
        Object.entries(this.state.admissionFences ?? {}).filter(([runId]) =>
          retainedRunIds.has(runId)
        )
      ),
      admissionTokens: Object.fromEntries(
        Object.entries(this.state.admissionTokens ?? {}).filter(([runId]) =>
          retainedRunIds.has(runId)
        )
      ),
      identityTokens: Object.fromEntries(
        Object.entries(this.state.identityTokens ?? {}).filter(([runId]) =>
          retainedRunIds.has(runId)
        )
      ),
      runs,
    });
    return true;
  }

  private dispatchTokenMatches(
    runId: string,
    dispatchToken: string | undefined
  ): boolean {
    if (!dispatchToken) {
      return true;
    }
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    return (
      record?.dispatchToken === dispatchToken ||
      (!record?.dispatchToken &&
        this.state.admissionTokens?.[runId] === dispatchToken)
    );
  }

  private async reportAdmissionTerminal(
    runId: string,
    dispatchToken?: string
  ): Promise<void> {
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!record || !isTerminal(record.run.status)) {
      return;
    }
    if (this.admissionReleaseCompleted.has(runId)) {
      return;
    }
    const inFlight = this.admissionReleaseInFlight.get(runId);
    if (inFlight) {
      await inFlight;
      return;
    }
    const currentDispatchToken =
      record.dispatchToken ?? this.state.admissionTokens?.[runId];
    const token = dispatchToken ?? currentDispatchToken;
    if (currentDispatchToken && currentDispatchToken !== token) {
      return;
    }
    const identityTokens = Object.fromEntries(
      Object.entries(this.state.identityTokens ?? {}).filter(
        ([candidate]) => candidate !== runId
      )
    );
    this.setState({ ...this.state, identityTokens });
    const release = (async () => {
      try {
        const released = await this.env.RunAdmission.getByName(
          "deployment"
        ).release(runId, token);
        if (released || !token) {
          this.admissionReleaseCompleted.add(runId);
          const retainedRunIds = new Set(
            this.state.runs.map((candidate) => candidate.run.id)
          );
          for (const completedRunId of this.admissionReleaseCompleted) {
            if (!retainedRunIds.has(completedRunId)) {
              this.admissionReleaseCompleted.delete(completedRunId);
            }
          }
          this.setState({
            ...this.state,
            admissionTokens: Object.fromEntries(
              Object.entries(this.state.admissionTokens ?? {}).filter(
                ([candidate]) => candidate !== runId
              )
            ),
          });
        }
      } catch {
        // The admission alarm reconciles an active record if this callback fails.
      } finally {
        this.admissionReleaseInFlight.delete(runId);
      }
    })();
    this.admissionReleaseInFlight.set(runId, release);
    await release;
  }
}
