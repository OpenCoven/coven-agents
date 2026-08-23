import { getSandbox } from "@cloudflare/sandbox";
import { Editor, Shell } from "@cloudflare/sandbox/openai";
import {
  applyPatchTool,
  Agent as OpenAIAgent,
  run as runAgent,
  shellTool,
} from "@openai/agents";
import {
  type AgentDefinition,
  agentDefinitionSchema,
  type CommandEvidence,
  compareAgentTimestamps,
  type FileEvidence,
  type RunError,
  type RunEvent,
  type RunSnapshot,
  startRunInputSchema,
} from "@opencoven/agent-contracts";
import {
  Agent,
  type FiberRecoveryContext,
  type FiberRecoveryResult,
  getAgentByName,
} from "agents";
import {
  AlreadyRunningError,
  appendEvents,
  type CloudRunRecord,
  cloudFiberKey,
  destroyCloudAgentSandbox,
  dispatchCloudRun,
  finishCloudRunRecord,
  hashOperation,
  isTerminal,
  nextEventId,
  normalizeCloudCommandEvidence,
  normalizeCloudFileEvidence,
  OperationConflictError,
  planCloudRunStart,
  recoverCloudRunRecord,
  retainCloudRuns,
  safeRunText,
  validateCloudWorkspace,
} from "./run-state.js";

type DirectoryState = {
  agents: AgentDefinition[];
  runIndex: Record<string, string>;
};

type YoloAgentState = {
  definition: AgentDefinition | null;
  runs: CloudRunRecord[];
};

type RecoverySnapshot = {
  agentId: string;
  operationId: string;
  runId: string;
};

function createRunError(
  code: string,
  message: string,
  retryable: boolean,
  details?: string
): RunError {
  return {
    code,
    ...(details ? { details } : {}),
    message,
    retryable,
  };
}

function finalOutput(value: unknown): string {
  if (typeof value === "string") {
    return safeRunText(value);
  }
  try {
    return safeRunText(JSON.stringify(value ?? ""));
  } catch {
    return "Cloud agent returned a non-serializable final response.";
  }
}

function captureCloudEvidence(
  commandResults: unknown[],
  fileResults: unknown[]
): {
  commandEvidence: CommandEvidence[];
  diagnostics: string[];
  fileEvidence: FileEvidence[];
  outputExceeded: boolean;
} {
  const commands = normalizeCloudCommandEvidence(commandResults);
  const files = normalizeCloudFileEvidence(fileResults);
  return {
    commandEvidence: commands.evidence,
    diagnostics: [...commands.diagnostics, ...files.diagnostics],
    fileEvidence: files.evidence,
    outputExceeded: commands.outputExceeded,
  };
}

function appendEvidenceDiagnostics(
  output: string,
  diagnostics: string[]
): string {
  return diagnostics.length > 0
    ? safeRunText(`${output}\n${diagnostics.join("\n")}`)
    : output;
}

function recoverySnapshot(value: unknown): RecoverySnapshot | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("agentId" in value) ||
    !("operationId" in value) ||
    !("runId" in value)
  ) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.agentId !== "string" ||
    typeof candidate.operationId !== "string" ||
    typeof candidate.runId !== "string"
  ) {
    return null;
  }
  return {
    agentId: candidate.agentId,
    operationId: candidate.operationId,
    runId: candidate.runId,
  };
}

export class AgentDirectory extends Agent<Env, DirectoryState> {
  initialState: DirectoryState = { agents: [], runIndex: {} };

  list(): AgentDefinition[] {
    return [...this.state.agents].sort((left, right) =>
      compareAgentTimestamps(right.updatedAt, left.updatedAt)
    );
  }

  lookupRun(runId: string): string | null {
    return this.state.runIndex?.[runId] ?? null;
  }

  remove(agentId: string): void {
    const runIndex = Object.fromEntries(
      Object.entries(this.state.runIndex ?? {}).filter(
        ([, indexedAgentId]) => indexedAgentId !== agentId
      )
    );
    this.setState({
      agents: this.state.agents.filter((agent) => agent.id !== agentId),
      runIndex,
    });
  }

  registerRun(runId: string, agentId: string): void {
    this.setState({
      ...this.state,
      runIndex: {
        ...(this.state.runIndex ?? {}),
        [runId]: agentId,
      },
    });
  }

  syncRuns(agentId: string, runIds: string[]): void {
    const runIndex = Object.fromEntries(
      Object.entries(this.state.runIndex ?? {}).filter(
        ([, indexedAgentId]) => indexedAgentId !== agentId
      )
    );
    for (const runId of runIds) {
      runIndex[runId] = agentId;
    }
    this.setState({ ...this.state, runIndex });
  }

  upsert(definition: AgentDefinition): AgentDefinition {
    const parsed = agentDefinitionSchema.parse(definition);
    this.setState({
      ...this.state,
      agents: [
        parsed,
        ...this.state.agents.filter((agent) => agent.id !== parsed.id),
      ],
      runIndex: this.state.runIndex ?? {},
    });
    return parsed;
  }
}

export class YoloAgent extends Agent<Env, YoloAgentState> {
  initialState: YoloAgentState = { definition: null, runs: [] };

  configure(definition: AgentDefinition): AgentDefinition {
    const parsed = agentDefinitionSchema.parse(definition);
    const configured = {
      ...parsed,
      workspace: validateCloudWorkspace(parsed),
    };
    this.setState({ ...this.state, definition: configured });
    return configured;
  }

  snapshot(): AgentDefinition | null {
    return this.state.definition;
  }

  getRun(runId: string): RunSnapshot | null {
    return this.findRecord(runId)?.run ?? null;
  }

  getEvents(runId: string, lastEventId: number): RunEvent[] | null {
    const record = this.findRecord(runId);
    return record?.events.filter((event) => event.id > lastEventId) ?? null;
  }

  getEventStream(
    runId: string,
    lastEventId: number
  ): { events: RunEvent[]; terminal: boolean } | null {
    const record = this.findRecord(runId);
    if (!record) {
      return null;
    }
    return {
      events: record.events.filter((event) => event.id > lastEventId),
      terminal: isTerminal(record.run.status),
    };
  }

  async start(input: unknown): Promise<{
    created: boolean;
    run: RunSnapshot;
  }> {
    const request = startRunInputSchema.parse(input);
    const definition = this.requireDefinition();
    const operationHash = await hashOperation(definition.id, request.task);
    const createdAt = new Date().toISOString();
    const plan = planCloudRunStart({
      agentId: definition.id,
      createdAt,
      operationHash,
      operationId: request.operationId,
      records: this.state.runs,
      runId: crypto.randomUUID(),
      task: request.task,
    });
    if (plan.kind === "conflict") {
      throw new OperationConflictError();
    }
    if (plan.kind === "already_running") {
      throw new AlreadyRunningError();
    }
    if (plan.kind === "existing") {
      return dispatchCloudRun(plan);
    }
    const { record } = plan;
    this.setRuns([record, ...this.state.runs]);
    this.updateDefinition({ status: "running", updatedAt: createdAt });
    await this.syncDirectory();

    return dispatchCloudRun(plan, async (fiberRecord, fiberKey) => {
      const receipt = await this.startFiber(
        "agent-run",
        async (context) => {
          const checkpoint: RecoverySnapshot = {
            agentId: definition.id,
            operationId: request.operationId,
            runId: fiberRecord.run.id,
          };
          context.stash(checkpoint);
          await this.executeRun(fiberRecord.run.id, context.signal, (value) =>
            context.stash(value)
          );
        },
        {
          fiberId: fiberRecord.run.id,
          idempotencyKey: fiberKey,
          metadata: {
            agentId: definition.id,
            operationHash,
            operationId: request.operationId,
            runId: fiberRecord.run.id,
          },
        }
      );
      return { accepted: receipt.accepted };
    });
  }

  async stop(runId: string): Promise<RunSnapshot | null> {
    const record = this.findRecord(runId);
    if (!record || isTerminal(record.run.status)) {
      return record?.run ?? null;
    }
    await this.cancelFiberByKey(
      cloudFiberKey(record.run.id),
      "Cancelled by operator request."
    );
    const current = this.findRecord(runId);
    if (!current || isTerminal(current.run.status)) {
      return current?.run ?? null;
    }
    const completedAt = new Date().toISOString();
    const cancelled = this.finishRecord(current, {
      completedAt,
      output: "Run cancelled by operator request.",
      status: "cancelled",
    });
    this.replaceRecord(cancelled);
    await this.finishDefinition(cancelled.run);
    return cancelled.run;
  }

  async decommission(): Promise<void> {
    const { definition } = this.state;
    const activeRuns = this.state.runs.filter(
      (record) => !isTerminal(record.run.status)
    );
    await Promise.all(
      activeRuns.map(async (record) => {
        try {
          await this.cancelFiberByKey(
            cloudFiberKey(record.run.id),
            "Cancelled because the agent was decommissioned."
          );
        } catch {
          // Sandbox destruction below still interrupts an unresponsive fiber.
        }
      })
    );
    const completedAt = new Date().toISOString();
    this.setRuns(
      this.state.runs.map((record) => {
        if (isTerminal(record.run.status)) {
          return record;
        }
        return this.finishRecord(record, {
          completedAt,
          output: "Run cancelled because the agent was decommissioned.",
          status: "cancelled",
        });
      })
    );
    await destroyCloudAgentSandbox(definition, async (name) => {
      await getSandbox(this.env.Sandbox, name).destroy();
    });
    this.setState(this.initialState);
  }

  async onFiberRecovered(
    context: FiberRecoveryContext
  ): Promise<FiberRecoveryResult | undefined> {
    if (context.name !== "agent-run") {
      return;
    }
    const checkpoint =
      recoverySnapshot(context.snapshot) ?? recoverySnapshot(context.metadata);
    if (!checkpoint) {
      return {
        error: "Cloud run recovery did not include a valid checkpoint.",
        status: "error",
      };
    }
    const record = this.findRecord(checkpoint.runId);
    if (!record || isTerminal(record.run.status)) {
      return { status: "completed" };
    }
    const completedAt = new Date().toISOString();
    const interrupted = recoverCloudRunRecord(record, completedAt);
    this.replaceRecord(interrupted);
    await this.finishDefinition(interrupted.run);
    return {
      error: "Cloud run was interrupted before completion.",
      snapshot: checkpoint,
      status: "error",
    };
  }

  private async executeRun(
    runId: string,
    signal: AbortSignal,
    checkpoint: (snapshot: RecoverySnapshot) => void
  ): Promise<void> {
    const record = this.findRecord(runId);
    if (!record || isTerminal(record.run.status)) {
      return;
    }
    const definition = this.requireDefinition();
    const startedAt = new Date().toISOString();
    const running = this.transitionRecord(record, "running", startedAt);
    this.replaceRecord(running);
    checkpoint({
      agentId: definition.id,
      operationId: record.run.operationId,
      runId,
    });

    const sandbox = getSandbox(this.env.Sandbox, `agent-${definition.id}`);
    const shell = new Shell(sandbox);
    const editor = new Editor(sandbox, validateCloudWorkspace(definition));
    const agent = new OpenAIAgent({
      instructions: `${definition.instructions}

You are running in a dedicated cloud sandbox. Tool calls are pre-approved. Work only inside the sandbox, verify the result, and include exact evidence in your final response.`,
      model: definition.model,
      name: definition.name,
      tools: [
        shellTool({ needsApproval: false, shell }),
        applyPatchTool({ editor, needsApproval: false }),
      ],
    });

    try {
      if (signal.aborted) {
        throw new DOMException("Run was cancelled.", "AbortError");
      }
      const result = await runAgent(agent, record.run.task, { signal });
      const current = this.findRecord(runId);
      if (!current || isTerminal(current.run.status)) {
        return;
      }
      if (signal.aborted) {
        const captured = captureCloudEvidence(shell.results, editor.results);
        const cancelled = this.finishRecord(current, {
          commandEvidence: captured.commandEvidence,
          completedAt: new Date().toISOString(),
          fileEvidence: captured.fileEvidence,
          output: appendEvidenceDiagnostics(
            "Run cancelled by operator request.",
            captured.diagnostics
          ),
          status: "cancelled",
        });
        this.replaceRecord(cancelled);
        await this.finishDefinition(cancelled.run);
        return;
      }
      const captured = captureCloudEvidence(shell.results, editor.results);
      if (captured.outputExceeded) {
        const failed = this.finishRecord(current, {
          commandEvidence: captured.commandEvidence,
          completedAt: new Date().toISOString(),
          error: createRunError(
            "output_limit",
            "Cloud run exceeded the captured output limit.",
            false
          ),
          fileEvidence: captured.fileEvidence,
          output: appendEvidenceDiagnostics(
            "Cloud run exceeded the captured output limit.",
            captured.diagnostics
          ),
          status: "failed",
        });
        this.replaceRecord(failed);
        await this.finishDefinition(failed.run);
        return;
      }
      const completed = this.finishRecord(current, {
        commandEvidence: captured.commandEvidence,
        completedAt: new Date().toISOString(),
        fileEvidence: captured.fileEvidence,
        output: appendEvidenceDiagnostics(
          finalOutput(result.finalOutput),
          captured.diagnostics
        ),
        status: "completed",
      });
      this.replaceRecord(completed);
      await this.finishDefinition(completed.run);
    } catch {
      const current = this.findRecord(runId);
      if (!current || isTerminal(current.run.status)) {
        return;
      }
      const status = signal.aborted ? "cancelled" : "failed";
      const captured = captureCloudEvidence(shell.results, editor.results);
      const failed = this.finishRecord(current, {
        commandEvidence: captured.commandEvidence,
        completedAt: new Date().toISOString(),
        error:
          status === "failed"
            ? captured.outputExceeded
              ? createRunError(
                  "output_limit",
                  "Cloud run exceeded the captured output limit.",
                  false
                )
              : createRunError(
                  "cloud_execution_failed",
                  "Cloud agent execution failed.",
                  true
                )
            : undefined,
        fileEvidence: captured.fileEvidence,
        output: appendEvidenceDiagnostics(
          status === "failed"
            ? captured.outputExceeded
              ? "Cloud run exceeded the captured output limit."
              : "Cloud agent execution failed."
            : "Run cancelled by operator request.",
          captured.diagnostics
        ),
        status,
      });
      this.replaceRecord(failed);
      await this.finishDefinition(failed.run);
    }
  }

  private findRecord(runId: string): CloudRunRecord | null {
    return this.state.runs.find((record) => record.run.id === runId) ?? null;
  }

  private finishRecord(
    record: CloudRunRecord,
    result: {
      commandEvidence?: CommandEvidence[];
      completedAt: string;
      error?: RunError;
      fileEvidence?: FileEvidence[];
      output: string;
      status: Extract<
        RunSnapshot["status"],
        "cancelled" | "completed" | "failed"
      >;
    }
  ): CloudRunRecord {
    return finishCloudRunRecord(record, result);
  }

  private async finishDefinition(run: RunSnapshot): Promise<void> {
    if (
      !this.state.definition ||
      this.state.runs.some(
        (candidate) =>
          candidate.run.id !== run.id && !isTerminal(candidate.run.status)
      )
    ) {
      return;
    }
    const status = run.status === "failed" ? "error" : "idle";
    this.updateDefinition({
      lastRunAt: run.completedAt,
      status,
      updatedAt: run.completedAt ?? new Date().toISOString(),
    });
    await this.syncDirectory();
  }

  private replaceRecord(record: CloudRunRecord): void {
    this.setRuns([
      record,
      ...this.state.runs.filter(
        (candidate) => candidate.run.id !== record.run.id
      ),
    ]);
  }

  private requireDefinition(): AgentDefinition {
    if (!this.state.definition) {
      throw new Error("Agent has not been configured.");
    }
    return this.state.definition;
  }

  private setRuns(runs: CloudRunRecord[]): void {
    this.setState({
      ...this.state,
      runs: retainCloudRuns(runs),
    });
  }

  private async syncDirectory(): Promise<void> {
    const { definition } = this.state;
    if (!definition) {
      return;
    }
    const directory = await getAgentByName<Env, AgentDirectory>(
      this.env.AgentDirectory,
      "default"
    );
    await directory.upsert(definition);
    await directory.syncRuns(
      definition.id,
      this.state.runs.map((record) => record.run.id)
    );
  }

  private transitionRecord(
    record: CloudRunRecord,
    status: Extract<RunSnapshot["status"], "running">,
    at: string
  ): CloudRunRecord {
    return appendEvents(
      {
        ...record,
        run: {
          ...record.run,
          startedAt: at,
          status,
        },
      },
      [
        {
          at,
          id: nextEventId(record),
          status,
          type: "status",
        },
      ]
    );
  }

  private updateDefinition(
    patch: Partial<Pick<AgentDefinition, "lastRunAt" | "status" | "updatedAt">>
  ): AgentDefinition {
    const definition = { ...this.requireDefinition(), ...patch };
    this.setState({ ...this.state, definition });
    return definition;
  }
}
