import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  type AgentDefinition,
  type RunEvent,
  type RunSnapshot,
  startRunInputSchema,
} from "@opencoven/agent-contracts";
import { createCloudRunner } from "./routes.js";
import {
  AlreadyRunningError,
  createQueuedRun,
  isTerminal,
  OperationConflictError,
} from "./run-state.js";
import { createRunEventStream } from "./sse.js";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const agentDefinition: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-20T20:00:00.000Z",
  description: "Cloud test profile",
  id: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
  instructions: "Work in the sandbox.",
  lastRunAt: null,
  model: "gpt-5.1",
  name: "Cloud runner",
  owner: { kind: "standalone" },
  runtime: "cloud",
  status: "idle",
  updatedAt: "2026-08-20T20:00:00.000Z",
  workspace: "/workspace",
};

type FakeRecord = ReturnType<typeof createQueuedRun> & {
  operationHash: string;
};

class FakeDirectory {
  readonly runIndex = new Map<string, string>();

  list(): AgentDefinition[] {
    return [agentDefinition];
  }

  lookupRun(runId: string): string | null {
    return this.runIndex.get(runId) ?? null;
  }

  registerRun(runId: string, agentId: string): void {
    this.runIndex.set(runId, agentId);
  }

  remove(): void {
    // This fake only exercises routes that do not alter profile inventory.
  }

  upsert(definition: AgentDefinition): AgentDefinition {
    return definition;
  }
}

class FakeYoloAgent {
  readonly records = new Map<string, FakeRecord>();
  stopCalls = 0;

  configure(definition: AgentDefinition): AgentDefinition {
    return definition;
  }

  decommission(): void {
    // This fake only exercises run lifecycle routes.
  }

  getEventStream(
    runId: string,
    lastEventId: number
  ): { events: RunEvent[]; terminal: boolean } | null {
    const record = this.records.get(runId);
    if (!record) {
      return null;
    }
    return {
      events: record.events.filter((event) => event.id > lastEventId),
      terminal: isTerminal(record.run.status),
    };
  }

  getRun(runId: string): RunSnapshot | null {
    return this.records.get(runId)?.run ?? null;
  }

  snapshot(): AgentDefinition {
    return agentDefinition;
  }

  start(input: unknown): { created: boolean; run: RunSnapshot } {
    const request = startRunInputSchema.parse(input);
    const existing = [...this.records.values()].find(
      (candidate) => candidate.run.operationId === request.operationId
    );
    if (existing) {
      if (existing.run.task !== request.task) {
        throw new OperationConflictError();
      }
      return { created: false, run: existing.run };
    }
    if (
      [...this.records.values()].some(
        (candidate) =>
          candidate.run.status === "queued" ||
          candidate.run.status === "running"
      )
    ) {
      throw new AlreadyRunningError();
    }
    const record: FakeRecord = {
      ...createQueuedRun(
        agentDefinition.id,
        request.operationId,
        request.task,
        randomUUID(),
        "2026-08-20T20:01:00.000Z"
      ),
      operationHash: request.task,
    };
    this.records.set(record.run.id, record);
    return { created: true, run: record.run };
  }

  stop(runId: string): RunSnapshot | null {
    const record = this.records.get(runId);
    if (!record) {
      return null;
    }
    this.stopCalls += 1;
    const completedAt = "2026-08-20T20:03:00.000Z";
    record.run = {
      ...record.run,
      completedAt,
      output: "Run cancelled by operator request.",
      status: "cancelled",
    };
    record.events.push({
      at: completedAt,
      id: (record.events.at(-1)?.id ?? 0) + 1,
      status: "cancelled",
      type: "status",
    });
    return record.run;
  }

  complete(runId: string): void {
    const record = this.records.get(runId);
    if (!record) {
      throw new Error("Run was not found.");
    }
    const completedAt = "2026-08-20T20:02:00.000Z";
    record.run = {
      ...record.run,
      completedAt,
      output: "Cloud mission completed.",
      status: "completed",
    };
    record.events.push({
      at: completedAt,
      id: (record.events.at(-1)?.id ?? 0) + 1,
      status: "completed",
      type: "status",
    });
  }
}

test("cloud lifecycle routes asynchronously start, replay, stream, get, and cancel runs", async () => {
  const directory = new FakeDirectory();
  const agent = new FakeYoloAgent();
  const nextPoll = deferred();
  const handler = createCloudRunner({
    createEventStream: (options) =>
      createRunEventStream({
        ...options,
        sleep: async () => nextPoll.promise,
      }),
    getDirectory: async () => directory,
    getYoloAgent: async () => agent,
  });
  const env = {
    AGENT_CONTROL_TOKEN: "test-cloud-token",
    ALLOWED_ORIGIN: "https://app.example",
  };
  const invoke = (request: Request) => handler.fetch(request, env);
  const operationId = "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d";
  const body = JSON.stringify({
    operationId,
    task: "Inspect the sandbox.",
  });
  const startRequest = () =>
    invoke(
      new Request(
        `https://runner.example/api/agents/${agentDefinition.id}/runs`,
        {
          body,
          headers: {
            authorization: "Bearer test-cloud-token",
            "content-type": "application/json",
          },
          method: "POST",
        }
      )
    );

  const started = await startRequest();
  const startedPayload = (await started.json()) as { run: RunSnapshot };
  assert.equal(started.status, 202);
  assert.equal(startedPayload.run.status, "queued");
  assert.equal(
    directory.runIndex.get(startedPayload.run.id),
    agentDefinition.id
  );

  const replayed = await startRequest();
  const replayedPayload = (await replayed.json()) as { run: RunSnapshot };
  assert.equal(replayed.status, 202);
  assert.equal(replayedPayload.run.id, startedPayload.run.id);

  const alreadyRunning = await invoke(
    new Request(
      `https://runner.example/api/agents/${agentDefinition.id}/runs`,
      {
        body: JSON.stringify({
          operationId: "8380f207-fb4f-424d-8e17-d2671b222a49",
          task: "Run another mission.",
        }),
        headers: {
          authorization: `Bearer ${env.AGENT_CONTROL_TOKEN}`,
          "content-type": "application/json",
        },
        method: "POST",
      }
    )
  );
  const alreadyRunningPayload = (await alreadyRunning.json()) as {
    apiVersion: string;
    error: { code: string };
  };
  assert.equal(alreadyRunning.status, 409);
  assert.equal(alreadyRunningPayload.apiVersion, AGENT_RUNNER_API_VERSION);
  assert.equal(alreadyRunningPayload.error.code, "already_running");

  const conflicted = await invoke(
    new Request(
      `https://runner.example/api/agents/${agentDefinition.id}/runs`,
      {
        body: JSON.stringify({
          operationId,
          task: "Run another mission.",
        }),
        headers: {
          authorization: "Bearer test-cloud-token",
          "content-type": "application/json",
        },
        method: "POST",
      }
    )
  );
  assert.equal(conflicted.status, 409);

  const fetched = await invoke(
    new Request(`https://runner.example/api/runs/${startedPayload.run.id}`, {
      headers: { authorization: "Bearer test-cloud-token" },
    })
  );
  const fetchedPayload = (await fetched.json()) as {
    apiVersion: string;
    run: RunSnapshot;
  };
  assert.equal(fetchedPayload.apiVersion, AGENT_RUNNER_API_VERSION);
  assert.equal(fetchedPayload.run.id, startedPayload.run.id);

  const eventResponse = await invoke(
    new Request(
      `https://runner.example/api/runs/${startedPayload.run.id}/events`,
      {
        headers: { authorization: "Bearer test-cloud-token" },
      }
    )
  );
  assert.match(
    eventResponse.headers.get("content-type") ?? "",
    /^text\/event-stream/
  );
  assert.equal(eventResponse.headers.get("cache-control"), "no-cache");
  assert.equal(eventResponse.headers.get("connection"), "keep-alive");
  assert.equal(eventResponse.headers.get("x-accel-buffering"), "no");
  const reader = eventResponse.body?.getReader();
  assert.ok(reader);
  const initial = await reader.read();
  assert.match(
    new TextDecoder().decode(initial.value),
    /id: 1\nevent: accepted/
  );
  agent.complete(startedPayload.run.id);
  nextPoll.resolve();
  const future = await reader.read();
  assert.match(new TextDecoder().decode(future.value), /id: 2\nevent: status/);
  assert.deepEqual(await reader.read(), { done: true, value: undefined });

  const stoppableOperationId = "8380f207-fb4f-424d-8e17-d2671b222a49";
  const stoppable = await invoke(
    new Request(
      `https://runner.example/api/agents/${agentDefinition.id}/runs`,
      {
        body: JSON.stringify({
          operationId: stoppableOperationId,
          task: "Wait for cancellation.",
        }),
        headers: {
          authorization: "Bearer test-cloud-token",
          "content-type": "application/json",
        },
        method: "POST",
      }
    )
  );
  const stoppablePayload = (await stoppable.json()) as { run: RunSnapshot };
  const stopped = await invoke(
    new Request(
      `https://runner.example/api/runs/${stoppablePayload.run.id}/stop`,
      {
        headers: {
          authorization: "Bearer test-cloud-token",
          "content-type": "application/json",
        },
        method: "POST",
      }
    )
  );
  const stoppedPayload = (await stopped.json()) as { run: RunSnapshot };

  assert.equal(stopped.status, 200);
  assert.equal(stoppedPayload.run.status, "cancelled");
  assert.equal(agent.stopCalls, 1);
});
