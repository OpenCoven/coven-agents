import { getSandbox } from "@cloudflare/sandbox";
import {
  AGENT_RUNNER_LIMITS,
  type AgentDefinition,
  agentDefinitionSchema,
  type RunResult,
  runAgentInputSchema,
} from "@opencoven/agent-contracts";
import type { HarnessStatus } from "@opencoven/harness";
import { Agent } from "agents";
import {
  HarnessError,
  listCloudHarnesses,
  runHarnessInSandbox,
} from "./harness-runner";
import { sandboxKey, tenantOf } from "./tenant";

type DirectoryState = {
  agents: AgentDefinition[];
};

type YoloAgentState = {
  definition: AgentDefinition | null;
  runs: RunResult[];
};

export class AgentDirectory extends Agent<Env, DirectoryState> {
  initialState: DirectoryState = { agents: [] };

  list(tenantId: string): AgentDefinition[] {
    return this.state.agents
      .filter((agent) => tenantOf(agent) === tenantId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  upsert(definition: AgentDefinition): AgentDefinition {
    const parsed = agentDefinitionSchema.parse(definition);
    this.setState({
      agents: [
        parsed,
        ...this.state.agents.filter((agent) => agent.id !== parsed.id),
      ],
    });
    return parsed;
  }

  remove(agentId: string): void {
    this.setState({
      agents: this.state.agents.filter((agent) => agent.id !== agentId),
    });
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

  /**
   * Executes the mission by driving an already-signed-in coding CLI inside the
   * sandbox. The Worker never calls a model provider, so no provider API key
   * exists in this path — only the harness's own credential, which the harness
   * itself reads from its documented environment variable.
   */
  async execute(input: unknown): Promise<RunResult> {
    const { task } = runAgentInputSchema.parse(input);
    const { definition } = this.state;
    if (!definition) {
      throw new Error("Agent has not been configured.");
    }
    if (definition.status === "running") {
      throw new Error("Agent is already running a mission.");
    }

    const startedAt = new Date().toISOString();
    this.updateDefinition({ status: "running", updatedAt: startedAt });

    try {
      const run = await runHarnessInSandbox({
        env: this.env,
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
      const result: RunResult = {
        agentId: definition.id,
        commandResults: [
          {
            command: run.command,
            exitCode: run.exitCode,
            stderr: run.stderr,
            stdout: run.summary.output,
          },
          // A harness tool call is {tool, summary, success}, which is not the
          // command-result shape. It was previously spread in raw because
          // commandResults was typed z.unknown(); the contract now describes
          // and caps the field, so the translation has to be explicit.
          ...run.summary.toolCalls.map((call) => ({
            command: call.tool,
            exitCode: call.success ? 0 : 1,
            stdout: call.summary,
          })),
        ].slice(0, AGENT_RUNNER_LIMITS.maxCommandResults),
        completedAt,
        fileOperations: run.summary.fileOperations,
        id: crypto.randomUUID(),
        output:
          run.summary.output ||
          run.stderr.trim() ||
          "The harness produced no output.",
        startedAt,
        status: failed ? "failed" : "completed",
      };
      this.finishRun(result, completedAt, failed ? "error" : "idle");
      return result;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const result: RunResult = {
        agentId: definition.id,
        commandResults: [],
        completedAt,
        fileOperations: [],
        id: crypto.randomUUID(),
        output:
          error instanceof HarnessError || error instanceof Error
            ? error.message
            : "Agent execution failed.",
        startedAt,
        status: "failed",
      };
      this.finishRun(result, completedAt, "error");
      return result;
    }
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

  private finishRun(
    result: RunResult,
    completedAt: string,
    status: AgentDefinition["status"]
  ): void {
    const definition = this.updateDefinition({
      lastRunAt: completedAt,
      status,
      updatedAt: completedAt,
    });
    this.setState({
      definition,
      runs: [result, ...this.state.runs].slice(0, 20),
    });
  }
}
