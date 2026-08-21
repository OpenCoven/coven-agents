import { getSandbox } from "@cloudflare/sandbox";
import {
  type CommandResult,
  Editor,
  type FileOperationResult,
  Shell,
} from "@cloudflare/sandbox/openai";
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
  appendEvents,
  type CloudRunRecord,
  createQueuedRun,
  hashOperation,
  isTerminal,
  MAX_CAPTURED_OUTPUT_BYTES,
  MAX_EVIDENCE_PER_RUN,
  nextEventId,
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

export class OperationConflictError extends Error {
  constructor() {
    super("Operation ID was already used for a different request.");
    this.name = "OperationConflictError";
  }
}

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

function retainRuns(records: CloudRunRecord[]): CloudRunRecord[] {
  const active = records.filter((record) => !isTerminal(record.run.status));
  const terminal = records
    .filter((record) => isTerminal(record.run.status))
    .sort(
      (left, right) =>
        Date.parse(right.run.completedAt ?? right.run.createdAt) -
        Date.parse(left.run.completedAt ?? left.run.createdAt)
    )
    .slice(0, 20);
  return [...active, ...terminal];
}

function commandEvidence(results: CommandResult[]): {
  evidence: CommandEvidence[];
  outputExceeded: boolean;
} {
  let remainingBytes = MAX_CAPTURED_OUTPUT_BYTES;
  let outputExceeded = false;
  const fit = (value: string): string => {
    const text = safeRunText(value);
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= remainingBytes) {
      remainingBytes -= bytes.byteLength;
      return text;
    }
    outputExceeded = true;
    const bounded = new TextDecoder().decode(bytes.slice(0, remainingBytes));
    remainingBytes = 0;
    return safeRunText(bounded);
  };
  return {
    evidence: results.slice(-MAX_EVIDENCE_PER_RUN).map((result) => ({
      command: result.command.trim() || "sandbox command",
      completedAt: new Date(result.timestamp).toISOString(),
      exitCode: result.exitCode,
      stderr: fit(result.stderr),
      stdout: fit(result.stdout),
    })),
    outputExceeded,
  };
}

function fileEvidence(results: FileOperationResult[]): FileEvidence[] {
  return results
    .filter((result) => result.status === "completed")
    .slice(-MAX_EVIDENCE_PER_RUN)
    .map((result) => ({
      occurredAt: new Date(result.timestamp).toISOString(),
      operation: result.operation === "update" ? "modify" : result.operation,
      path: result.path,
    }));
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

  async start(input: unknown): Promise<{
    created: boolean;
    run: RunSnapshot;
  }> {
    const request = startRunInputSchema.parse(input);
    const definition = this.requireDefinition();
    const operationHash = await hashOperation(definition.id, request.task);
    const existing = this.state.runs.find(
      (candidate) => candidate.run.operationId === request.operationId
    );
    const key = this.fiberKey(request.operationId);
    if (existing) {
      await this.inspectFiberByKey(key);
      if (existing.operationHash !== operationHash) {
        throw new OperationConflictError();
      }
      return { created: false, run: existing.run };
    }

    const createdAt = new Date().toISOString();
    const record = {
      ...createQueuedRun(
        definition.id,
        request.operationId,
        request.task,
        crypto.randomUUID(),
        createdAt
      ),
      operationHash,
    };
    this.setRuns([record, ...this.state.runs]);
    this.updateDefinition({ status: "running", updatedAt: createdAt });
    await this.syncDirectory();

    const receipt = await this.startFiber(
      "agent-run",
      async (context) => {
        const checkpoint: RecoverySnapshot = {
          agentId: definition.id,
          operationId: request.operationId,
          runId: record.run.id,
        };
        context.stash(checkpoint);
        await this.executeRun(record.run.id, context.signal, (value) =>
          context.stash(value)
        );
      },
      {
        fiberId: record.run.id,
        idempotencyKey: key,
        metadata: {
          agentId: definition.id,
          operationHash,
          operationId: request.operationId,
          runId: record.run.id,
        },
      }
    );
    if (!receipt.accepted) {
      const duplicate = this.findRecord(record.run.id);
      return { created: false, run: duplicate?.run ?? record.run };
    }
    return { created: true, run: record.run };
  }

  async stop(runId: string): Promise<RunSnapshot | null> {
    const record = this.findRecord(runId);
    if (!record || isTerminal(record.run.status)) {
      return record?.run ?? null;
    }
    await this.cancelFiberByKey(
      this.fiberKey(record.run.operationId),
      "Cancelled by operator request."
    );
    const completedAt = new Date().toISOString();
    const cancelled = this.finishRecord(record, {
      completedAt,
      output: "Run cancelled by operator request.",
      status: "cancelled",
    });
    this.replaceRecord(cancelled);
    this.updateDefinition({
      lastRunAt: completedAt,
      status: "idle",
      updatedAt: completedAt,
    });
    await this.syncDirectory();
    return cancelled.run;
  }

  async decommission(): Promise<void> {
    const { definition } = this.state;
    if (definition) {
      await getSandbox(this.env.Sandbox, `agent-${definition.id}`).destroy();
    }
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
    const interrupted = this.finishRecord(record, {
      completedAt,
      error: createRunError(
        "interrupted",
        "Cloud run was interrupted before completion.",
        true
      ),
      output: "Cloud durable execution was interrupted.",
      status: "failed",
    });
    this.replaceRecord(interrupted);
    this.updateDefinition({
      lastRunAt: completedAt,
      status: "error",
      updatedAt: completedAt,
    });
    await this.syncDirectory();
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
        const captured = commandEvidence(shell.results);
        const cancelled = this.finishRecord(current, {
          commandEvidence: captured.evidence,
          completedAt: new Date().toISOString(),
          fileEvidence: fileEvidence(editor.results),
          output: "Run cancelled by operator request.",
          status: "cancelled",
        });
        this.replaceRecord(cancelled);
        await this.finishDefinition(cancelled.run);
        return;
      }
      const captured = commandEvidence(shell.results);
      if (captured.outputExceeded) {
        const failed = this.finishRecord(current, {
          commandEvidence: captured.evidence,
          completedAt: new Date().toISOString(),
          error: createRunError(
            "output_limit",
            "Cloud run exceeded the captured output limit.",
            false
          ),
          fileEvidence: fileEvidence(editor.results),
          output: "Cloud run exceeded the captured output limit.",
          status: "failed",
        });
        this.replaceRecord(failed);
        await this.finishDefinition(failed.run);
        return;
      }
      const completed = this.finishRecord(current, {
        commandEvidence: captured.evidence,
        completedAt: new Date().toISOString(),
        fileEvidence: fileEvidence(editor.results),
        output: finalOutput(result.finalOutput),
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
      const captured = commandEvidence(shell.results);
      const failed = this.finishRecord(current, {
        commandEvidence: captured.evidence,
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
        fileEvidence: fileEvidence(editor.results),
        output:
          status === "failed"
            ? captured.outputExceeded
              ? "Cloud run exceeded the captured output limit."
              : "Cloud agent execution failed."
            : "Run cancelled by operator request.",
        status,
      });
      this.replaceRecord(failed);
      await this.finishDefinition(failed.run);
    }
  }

  private findRecord(runId: string): CloudRunRecord | null {
    return this.state.runs.find((record) => record.run.id === runId) ?? null;
  }

  private fiberKey(operationId: string): string {
    return `run:${operationId}`;
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
    if (isTerminal(record.run.status)) {
      return record;
    }
    const run: RunSnapshot = {
      ...record.run,
      commandEvidence: result.commandEvidence ?? record.run.commandEvidence,
      completedAt: result.completedAt,
      error: result.error ?? null,
      fileEvidence: result.fileEvidence ?? record.run.fileEvidence,
      output: safeRunText(result.output),
      status: result.status,
    };
    const events: RunEvent[] = [];
    let eventId = nextEventId(record);
    const takeEventId = (): number => {
      const id = eventId;
      eventId += 1;
      return id;
    };
    for (const evidence of run.commandEvidence) {
      events.push({
        at: result.completedAt,
        evidence,
        id: takeEventId(),
        type: "command",
      });
    }
    for (const evidence of run.fileEvidence) {
      events.push({
        at: result.completedAt,
        evidence,
        id: takeEventId(),
        type: "file",
      });
    }
    if (run.output) {
      events.push({
        at: result.completedAt,
        id: takeEventId(),
        output: run.output,
        type: "output",
      });
    }
    events.push({
      at: result.completedAt,
      id: takeEventId(),
      status: result.status,
      type: "status",
    });
    if (result.status === "completed") {
      events.push({
        at: result.completedAt,
        id: takeEventId(),
        run,
        type: "completed",
      });
    }
    if (result.status === "failed" && result.error) {
      events.push({
        at: result.completedAt,
        error: result.error,
        id: takeEventId(),
        type: "failed",
      });
    }
    return appendEvents({ ...record, run }, events);
  }

  private async finishDefinition(run: RunSnapshot): Promise<void> {
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
      runs: retainRuns(runs),
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
