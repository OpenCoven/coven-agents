import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AgentDefinition,
  agentDefinitionSchema,
} from "@opencoven/agent-contracts";
import { z } from "zod";

const storeSchema = z.object({
  agents: z.array(agentDefinitionSchema),
});

export class AgentStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  async list(): Promise<AgentDefinition[]> {
    return (await this.read()).agents.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt)
    );
  }

  async get(id: string): Promise<AgentDefinition | null> {
    return (await this.read()).agents.find((agent) => agent.id === id) ?? null;
  }

  async upsert(agent: AgentDefinition): Promise<void> {
    const parsed = agentDefinitionSchema.parse(agent);
    await this.mutate((agents) => [
      parsed,
      ...agents.filter((candidate) => candidate.id !== parsed.id),
    ]);
  }

  async remove(id: string): Promise<void> {
    await this.mutate((agents) => agents.filter((agent) => agent.id !== id));
  }

  private async mutate(
    change: (agents: AgentDefinition[]) => AgentDefinition[]
  ): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const current = await this.read();
      await this.write({ agents: change(current.agents) });
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async read(): Promise<{ agents: AgentDefinition[] }> {
    try {
      return storeSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { agents: [] };
      }
      throw error;
    }
  }

  private async write(value: { agents: AgentDefinition[] }): Promise<void> {
    await mkdir(dirname(this.path), { mode: 0o700, recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }
}
