import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  AGENT_RUNNER_LIMITS,
  type RunEvent,
  type RunSnapshot,
  runEventsSchema,
  runSnapshotSchema,
} from "@opencoven/agent-contracts";
import { z } from "zod";

export const MAX_EVENTS_PER_RUN = 200;
export const MAX_TERMINAL_RUNS_PER_AGENT = 20;

const storedRunSchema = z
  .object({
    events: runEventsSchema,
    operationHash: z.string().min(1).max(128),
    run: runSnapshotSchema,
  })
  .strict();

const runStoreSchema = z
  .object({
    runs: z.array(storedRunSchema),
  })
  .strict();

export type StoredRun = z.infer<typeof storedRunSchema>;

export type CreateRunInput = StoredRun;

export type CreateOrGetResult =
  | { kind: "created"; record: StoredRun }
  | { kind: "existing"; record: StoredRun }
  | { kind: "conflict"; record: StoredRun };

const terminalStatuses = new Set<RunSnapshot["status"]>([
  "cancelled",
  "completed",
  "failed",
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function truncateRunText(value: string): string {
  if (value.length <= AGENT_RUNNER_LIMITS.maxEventOutputLength) {
    return value;
  }
  const suffix = "\n[output truncated by runner]";
  return `${value.slice(
    0,
    AGENT_RUNNER_LIMITS.maxEventOutputLength - suffix.length
  )}${suffix}`;
}

function appendEvent(record: StoredRun, event: RunEvent): StoredRun {
  return {
    ...record,
    events: [...record.events, event].slice(-MAX_EVENTS_PER_RUN),
  };
}

function retainTerminalRuns(records: StoredRun[]): StoredRun[] {
  const terminalIds = new Set<string>();
  const byAgent = new Map<string, StoredRun[]>();

  for (const record of records) {
    if (!terminalStatuses.has(record.run.status)) {
      continue;
    }
    const entries = byAgent.get(record.run.agentId) ?? [];
    entries.push(record);
    byAgent.set(record.run.agentId, entries);
  }

  for (const entries of byAgent.values()) {
    const retained = entries
      .sort(
        (left, right) =>
          Date.parse(right.run.completedAt ?? right.run.createdAt) -
          Date.parse(left.run.completedAt ?? left.run.createdAt)
      )
      .slice(0, MAX_TERMINAL_RUNS_PER_AGENT);
    for (const retainedRecord of retained) {
      terminalIds.add(retainedRecord.run.id);
    }
  }

  return records.filter(
    (record) =>
      !terminalStatuses.has(record.run.status) || terminalIds.has(record.run.id)
  );
}

export class RunStore {
  private readonly path: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.path = path;
  }

  createOrGet(input: CreateRunInput): Promise<CreateOrGetResult> {
    const candidate = storedRunSchema.parse({
      ...input,
      events: input.events.slice(-MAX_EVENTS_PER_RUN),
    });
    return this.mutate((records) => {
      const existing = records.find(
        (record) => record.run.operationId === candidate.run.operationId
      );
      if (existing) {
        return {
          records,
          value: {
            kind:
              existing.operationHash === candidate.operationHash
                ? "existing"
                : "conflict",
            record: clone(existing),
          } as CreateOrGetResult,
        };
      }

      return {
        records: retainTerminalRuns([candidate, ...records]),
        value: {
          kind: "created",
          record: clone(candidate),
        } as CreateOrGetResult,
      };
    });
  }

  async get(runId: string): Promise<StoredRun | null> {
    await this.writeQueue;
    return (
      (await this.read()).runs.find((record) => record.run.id === runId) ?? null
    );
  }

  async listForAgent(agentId: string): Promise<StoredRun[]> {
    await this.writeQueue;
    return (await this.read()).runs.filter(
      (record) => record.run.agentId === agentId
    );
  }

  async findFirstByAgentStatus(
    agentId: string,
    status: RunSnapshot["status"]
  ): Promise<StoredRun | null> {
    const matches = (await this.listForAgent(agentId))
      .filter((record) => record.run.status === status)
      .sort(
        (left, right) =>
          Date.parse(left.run.createdAt) - Date.parse(right.run.createdAt)
      );
    return matches[0] ?? null;
  }

  async listEventsAfter(runId: string, eventId: number): Promise<RunEvent[]> {
    const record = await this.get(runId);
    return record?.events.filter((event) => event.id > eventId) ?? [];
  }

  recoverInterrupted(): Promise<StoredRun[]> {
    return this.mutate((records) => {
      const completedAt = new Date().toISOString();
      const error = {
        code: "interrupted",
        details: "The local runner restarted before this run completed.",
        message: "Run interrupted by runner restart.",
        retryable: true,
      };
      const recovered: StoredRun[] = [];
      const updated = records.map((record) => {
        if (terminalStatuses.has(record.run.status)) {
          return record;
        }
        const event: RunEvent = {
          at: completedAt,
          error,
          id: (record.events.at(-1)?.id ?? 0) + 1,
          type: "failed",
        };
        const interrupted = appendEvent(
          {
            ...record,
            run: {
              ...record.run,
              completedAt,
              error,
              output: truncateRunText(
                `${record.run.output}\n[runner restart interrupted this run]`.trim()
              ),
              status: "failed",
            },
          },
          event
        );
        recovered.push(interrupted);
        return interrupted;
      });
      return {
        records: retainTerminalRuns(updated),
        value: recovered,
      };
    });
  }

  async removeForAgent(agentId: string): Promise<void> {
    await this.mutate((records) => ({
      records: records.filter((record) => record.run.agentId !== agentId),
      value: undefined,
    }));
  }

  update(
    runId: string,
    change: (record: StoredRun) => StoredRun
  ): Promise<StoredRun | null> {
    return this.mutate((records) => {
      const index = records.findIndex((record) => record.run.id === runId);
      if (index < 0) {
        return { records, value: null };
      }
      const updatedRecord = storedRunSchema.parse(
        change(clone(records[index]))
      );
      const next = [...records];
      next[index] = updatedRecord;
      return {
        records: retainTerminalRuns(next),
        value: clone(updatedRecord),
      };
    });
  }

  private mutate<T>(
    change: (records: StoredRun[]) => { records: StoredRun[]; value: T }
  ): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const current = await this.read();
      const result = change(current.runs);
      await this.write({ runs: result.records });
      return result.value;
    });
    this.writeQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }

  private async read(): Promise<{ runs: StoredRun[] }> {
    try {
      return runStoreSchema.parse(
        JSON.parse(await readFile(this.path, "utf8"))
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return { runs: [] };
      }
      throw error;
    }
  }

  private async write(value: { runs: StoredRun[] }): Promise<void> {
    await mkdir(dirname(this.path), { mode: 0o700, recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.path);
  }
}
