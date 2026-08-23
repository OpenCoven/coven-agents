import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition, RunSnapshot } from "@opencoven/agent-contracts";
import {
  destroyedSandboxes,
  recordSandboxLifecycle,
  resetDestroyedSandboxes,
  sandboxLifecycle,
} from "../test-support/cloudflare-sandbox.js";
import { YoloAgent } from "./agents.js";
import { cloudFiberKey, OperationConflictError } from "./run-state.js";

const definition: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-20T20:00:00.000Z",
  description: "Cloud lifecycle harness",
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

class YoloAgentHarness extends YoloAgent {
  readonly cancelledFiberKeys: string[] = [];
  readonly startedFiberKeys: string[] = [];
  readonly stateHistory: Array<{
    definition: AgentDefinition | null;
    runs: Array<{ run: RunSnapshot }>;
  }> = [];

  constructor() {
    super({} as ConstructorParameters<typeof YoloAgent>[0], {} as Env);
    this.setState({ definition: null, runs: [] });
  }

  override cancelFiberByKey(key: string): Promise<boolean> {
    this.cancelledFiberKeys.push(key);
    recordSandboxLifecycle(`cancel:${key}`);
    return Promise.resolve(true);
  }

  override setState(state: this["state"]): void {
    this.stateHistory.push(state);
    super.setState(state);
  }

  override startFiber(
    ...args: Parameters<YoloAgent["startFiber"]>
  ): Promise<Awaited<ReturnType<YoloAgent["startFiber"]>>> {
    const [name, _work, options] = args;
    if (options?.idempotencyKey) {
      this.startedFiberKeys.push(options.idempotencyKey);
    }
    return Promise.resolve({
      accepted: true,
      createdAt: 0,
      fiberId: options?.fiberId ?? "",
      name,
      status: "pending",
    });
  }
}

function createAgent(): YoloAgentHarness {
  resetDestroyedSandboxes();
  return new YoloAgentHarness();
}

test("YoloAgent replays duplicates but rejects a distinct active run", async () => {
  const agent = createAgent();
  agent.configure(definition);
  const operationId = "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d";
  const started = await agent.start({
    operationId,
    task: "Inspect the sandbox.",
  });
  const replayed = await agent.start({
    operationId,
    task: "Inspect the sandbox.",
  });

  assert.equal(started.created, true);
  assert.equal(replayed.created, false);
  assert.equal(replayed.run.id, started.run.id);
  assert.deepEqual(agent.startedFiberKeys, [cloudFiberKey(started.run.id)]);
  await assert.rejects(
    agent.start({
      operationId: "8380f207-fb4f-424d-8e17-d2671b222a49",
      task: "A distinct mission.",
    }),
    /active run/
  );
  await assert.rejects(
    agent.start({
      operationId,
      task: "A conflicting mission.",
    }),
    OperationConflictError
  );
});

test("YoloAgent recovers an interrupted fiber without changing another run", async () => {
  const agent = createAgent();
  agent.configure(definition);
  const operationId = "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d";
  const started = await agent.start({
    operationId,
    task: "Inspect the sandbox.",
  });

  const recovered = await agent.onFiberRecovered({
    createdAt: Date.now(),
    id: started.run.id,
    name: "agent-run",
    recoveryReason: "interrupted",
    snapshot: {
      agentId: definition.id,
      operationId,
      runId: started.run.id,
    },
  });

  assert.equal(recovered?.status, "error");
  assert.equal(agent.getRun(started.run.id)?.status, "failed");
  assert.equal(agent.getRun(started.run.id)?.error?.code, "interrupted");
  assert.equal(agent.snapshot()?.status, "error");
});

test("YoloAgent cancels its actual fiber and leaves a terminal snapshot", async () => {
  const agent = createAgent();
  agent.configure(definition);
  const started = await agent.start({
    operationId: "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    task: "Inspect the sandbox.",
  });

  const stopped = await agent.stop(started.run.id);

  assert.equal(stopped?.status, "cancelled");
  assert.deepEqual(agent.cancelledFiberKeys, [cloudFiberKey(started.run.id)]);
  assert.equal(agent.snapshot()?.status, "idle");
});

test("YoloAgent cancels active fibers before destroying its sandbox on decommission", async () => {
  const agent = createAgent();
  agent.configure(definition);
  const started = await agent.start({
    operationId: "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    task: "Inspect the sandbox.",
  });

  await agent.decommission();

  assert.deepEqual(agent.cancelledFiberKeys, [cloudFiberKey(started.run.id)]);
  assert.deepEqual(destroyedSandboxes(), [`agent-${definition.id}`]);
  assert.deepEqual(sandboxLifecycle(), [
    `cancel:${cloudFiberKey(started.run.id)}`,
    `destroy:agent-${definition.id}`,
  ]);
  assert.ok(
    agent.stateHistory.some((state) =>
      state.runs.some(
        (record) =>
          record.run.id === started.run.id &&
          record.run.status === "cancelled" &&
          record.run.output.includes("decommissioned")
      )
    )
  );
  assert.equal(agent.snapshot(), null);
});

test("YoloAgent ignores terminal status updates from a superseded run", async () => {
  const agent = createAgent();
  agent.configure(definition);
  const first = await agent.start({
    operationId: "0f6f31ae-7b6c-49c9-bc82-0f2cbf56cc4d",
    task: "First mission.",
  });
  const cancelled = await agent.stop(first.run.id);
  assert.ok(cancelled);
  const second = await agent.start({
    operationId: "8380f207-fb4f-424d-8e17-d2671b222a49",
    task: "Second mission.",
  });
  const lifecycle = agent as unknown as {
    finishDefinition: (run: RunSnapshot) => Promise<void>;
  };

  await lifecycle.finishDefinition(cancelled);

  assert.equal(agent.getRun(second.run.id)?.status, "queued");
  assert.equal(agent.snapshot()?.status, "running");
});
