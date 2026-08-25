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
} from "@opencoven/agent-contracts";
import type { HarnessStatus } from "@opencoven/harness";
import { Agent } from "agents";
import {
  HarnessError,
  listCloudHarnesses,
  runHarnessInSandbox,
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
  nextEventId,
  OperationConflictError,
  planCloudRunStart,
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
};

type YoloAgentState = {
  definition: AgentDefinition | null;
  runs: CloudRunRecord[];
};

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
  initialState: DirectoryState = { agents: [], runs: {} };

  list(tenantId: string): AgentDefinition[] {
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

  registerRun(runId: string, agentId: string): void {
    this.setState({
      ...this.state,
      runs: { ...this.state.runs, [runId]: agentId },
    });
  }

  lookupRun(runId: string): string | null {
    // Own-property check: a run id of "constructor" or "__proto__" would
    // otherwise resolve to something off Object.prototype and be treated as an
    // agent id.
    const runs = this.state.runs ?? {};
    return Object.hasOwn(runs, runId) ? (runs[runId] ?? null) : null;
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
  initialState: YoloAgentState = { definition: null, runs: [] };

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
  private async driveHarness(
    definition: AgentDefinition,
    planned: CloudRunRecord,
    task: string,
    identityToken: string
  ): Promise<CloudRunRecord> {
    const startedAt = new Date().toISOString();
    let record = appendEvents(
      {
        ...planned,
        run: { ...planned.run, startedAt, status: "running" as const },
      },
      [
        // There is no "started" event in the contract; a transition is reported
        // as a `status` event carrying the new status. Only `accepted` carries
        // operationId and runId, and the schema is strict, so adding them here
        // would fail to parse.
        {
          at: startedAt,
          id: nextEventId(planned),
          status: "running",
          type: "status",
        },
      ]
    );
    this.persistRun(record);
    this.updateDefinition({ status: "running", updatedAt: startedAt });

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
      const run = await runHarnessInSandbox({
        credential: { credential },
        instructions: `${definition.instructions}

You are running in a dedicated cloud sandbox. Tool calls are pre-approved. Work only inside the sandbox, verify the result, and include exact evidence in your final response.`,
        model: definition.model,
        runtime: definition.runtime,
        sandbox: getSandbox(
          this.env.Sandbox,
          sandboxKey(tenantOf(definition), definition.id)
        ),
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
      this.persistRun(record);
      this.updateDefinition({
        lastRunAt: completedAt,
        status: failed ? "error" : "idle",
        updatedAt: completedAt,
      });
      return record;
    } catch (error) {
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
      this.persistRun(record);
      this.updateDefinition({
        lastRunAt: completedAt,
        status: "error",
        updatedAt: completedAt,
      });
      return record;
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
        async () => {
          await this.driveHarness(definition, record, task, identityToken);
        },
        // Keyed on the fiber key rather than the operation id: `stop` cancels
        // by run, and a run is what a caller can name.
        { idempotencyKey: fiberKey }
      )
    );
  }

  /**
   * Cancels a run that is still in flight and records it as cancelled.
   *
   * Cancelling the fiber is not enough on its own — a cancelled fiber simply
   * stops, leaving the record stuck in `running` forever. The record has to be
   * closed here so a caller polling the run sees a terminal state.
   */
  async stop(runId: string): Promise<RunSnapshot | null> {
    const record = this.state.runs.find(
      (candidate) => candidate.run.id === runId
    );
    if (!record) {
      return null;
    }
    if (isTerminal(record.run.status)) {
      // Already finished. Cancelling would be a no-op and rewriting the record
      // would discard the real outcome.
      return record.run;
    }

    await this.cancelFiberByKey(cloudFiberKey(runId), "Cancelled by operator.");
    const cancelled = finishCloudRunRecord(record, {
      completedAt: new Date().toISOString(),
      // Cancellation is an operator action outside `driveHarness`, so no
      // credential is in scope here — the static message below carries none,
      // and the run's already-persisted evidence was redacted when it was
      // first captured.
      credential: null,
      output: "Run cancelled by operator request.",
      status: "cancelled",
    });
    this.persistRun(cancelled);
    this.updateDefinition({
      status: "idle",
      updatedAt: cancelled.run.completedAt ?? new Date().toISOString(),
    });
    return cancelled.run;
  }

  /**
   * Events recorded after `lastEventId`, plus whether the run has finished.
   *
   * `terminal` is what lets the stream close rather than poll forever, so it
   * reports the run's status and not whether this batch happened to be empty.
   */
  getEventStream(
    runId: string,
    lastEventId: number
  ): { events: RunEvent[]; terminal: boolean } | null {
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
    return (
      this.state.runs.find((record) => record.run.id === runId)?.run ?? null
    );
  }

  /** Every run this agent still retains, newest first. */
  listRuns(): RunSnapshot[] {
    return [...this.state.runs]
      .sort(
        (left, right) =>
          Date.parse(right.run.createdAt) - Date.parse(left.run.createdAt)
      )
      .map((record) => record.run);
  }

  async decommission(): Promise<void> {
    const { definition } = this.state;
    if (definition) {
      await getSandbox(
        this.env.Sandbox,
        sandboxKey(tenantOf(definition), definition.id)
      ).destroy();
    }
    this.setState(this.initialState);
  }

  private updateDefinition(
    patch: Partial<Pick<AgentDefinition, "status" | "updatedAt" | "lastRunAt">>
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
  private persistRun(record: CloudRunRecord): void {
    const others = this.state.runs.filter(
      (candidate) => candidate.run.id !== record.run.id
    );
    this.setState({
      ...this.state,
      runs: retainCloudRuns([record, ...others]),
    });
  }
}
