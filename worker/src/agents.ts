import { getSandbox } from "@cloudflare/sandbox";
import { Editor, Shell } from "@cloudflare/sandbox/openai";
import {
  applyPatchTool,
  Agent as OpenAIAgent,
  run,
  shellTool,
} from "@openai/agents";
import {
  type AgentDefinition,
  agentDefinitionSchema,
  type RunResult,
  runAgentInputSchema,
} from "@opencoven/agent-contracts";
import { Agent } from "agents";

type DirectoryState = {
  agents: AgentDefinition[];
};

type YoloAgentState = {
  definition: AgentDefinition | null;
  runs: RunResult[];
};

export class AgentDirectory extends Agent<Env, DirectoryState> {
  initialState: DirectoryState = { agents: [] };

  list(): AgentDefinition[] {
    return [...this.state.agents].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
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
    const sandbox = getSandbox(this.env.Sandbox, `agent-${definition.id}`);
    const shell = new Shell(sandbox);
    const editor = new Editor(sandbox, definition.workspace ?? "/workspace");
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
      const result = await run(agent, task);
      const completedAt = new Date().toISOString();
      const runResult: RunResult = {
        agentId: definition.id,
        commandResults: [...shell.results],
        completedAt,
        fileOperations: [...editor.results],
        id: crypto.randomUUID(),
        output:
          typeof result.finalOutput === "string"
            ? result.finalOutput
            : JSON.stringify(result.finalOutput ?? ""),
        startedAt,
        status: "completed",
      };
      this.finishRun(runResult, completedAt, "idle");
      return runResult;
    } catch (error) {
      const completedAt = new Date().toISOString();
      const failed: RunResult = {
        agentId: definition.id,
        commandResults: [...shell.results],
        completedAt,
        fileOperations: [...editor.results],
        id: crypto.randomUUID(),
        output:
          error instanceof Error ? error.message : "Agent execution failed.",
        startedAt,
        status: "failed",
      };
      this.finishRun(failed, completedAt, "error");
      return failed;
    }
  }

  async decommission(): Promise<void> {
    const { definition } = this.state;
    if (definition) {
      await getSandbox(this.env.Sandbox, `agent-${definition.id}`).destroy();
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
