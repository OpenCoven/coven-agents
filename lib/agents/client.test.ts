import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNNER_API_VERSION,
  AGENT_RUNNER_CAPABILITIES,
  type AgentDefinition,
  type RunSnapshot,
} from "@opencoven/agent-contracts";
import type { RunnerTransport } from "./browser-transport";
import { RunnerApiError, RunnerClient } from "./client";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";

const agent: AgentDefinition = {
  backend: "cloud",
  createdAt: "2026-08-29T00:00:00.000Z",
  description: "Client fixture",
  id: AGENT_ID,
  instructions: "Delegate protocol work.",
  lastRunAt: null,
  model: "auto",
  name: "Client",
  owner: { kind: "standalone" },
  runtime: "copilot",
  status: "idle",
  updatedAt: "2026-08-29T00:00:00.000Z",
  warm: {
    status: "ready",
    updatedAt: "2026-08-29T00:00:00.000Z",
  },
  workspace: "/workspace",
};

function snapshot(status: RunSnapshot["status"]): RunSnapshot {
  return {
    agentId: AGENT_ID,
    apiVersion: AGENT_RUNNER_API_VERSION,
    commandEvidence: [
      { command: "pnpm test", exitCode: 0, stderr: "", stdout: "ok" },
    ],
    completedAt:
      status === "queued" || status === "running"
        ? null
        : "2026-08-29T00:01:00.000Z",
    createdAt: "2026-08-29T00:00:00.000Z",
    fileEvidence: [],
    id: RUN_ID,
    operationId: "33333333-3333-4333-8333-333333333333",
    output: status === "completed" ? "done" : "",
    startedAt: "2026-08-29T00:00:01.000Z",
    status,
    task: "Delegate protocol work.",
  };
}

function fakeTransport(
  overrides: Partial<RunnerTransport> = {}
): RunnerTransport {
  return {
    createAgent: async () => agent,
    deleteAgent: async () => undefined,
    getAgent: async () => agent,
    getRun: async () => snapshot("completed"),
    health: async () => ({
      apiVersion: AGENT_RUNNER_API_VERSION,
      capabilities: [...AGENT_RUNNER_CAPABILITIES],
      minimumClientVersion: "1.0.0",
      mode: "cloud",
    }),
    listAgents: async () => [agent],
    listHarnesses: async () => [],
    listRuns: async () => [],
    prewarmTenant: async () => undefined,
    startRun: async () => snapshot("queued"),
    stopRun: async () => snapshot("cancelled"),
    streamRunEvents: async () => snapshot("completed"),
    updateAgent: async () => agent,
    ...overrides,
  };
}

test("delegates browser operations to the injected transport", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const transport = fakeTransport({
    createAgent: (createInput, signal) => {
      calls.push(
        `create:${createInput.name}:${String(signal === controller.signal)}`
      );
      return Promise.resolve(agent);
    },
    deleteAgent: (id, signal) => {
      calls.push(`delete:${id}:${String(signal === controller.signal)}`);
      return Promise.resolve();
    },
    getAgent: (id, signal) => {
      calls.push(`agent:${id}:${String(signal === controller.signal)}`);
      return Promise.resolve(agent);
    },
    health: (signal) => {
      calls.push(`health:${String(signal === controller.signal)}`);
      return Promise.resolve({
        apiVersion: AGENT_RUNNER_API_VERSION,
        capabilities: [...AGENT_RUNNER_CAPABILITIES],
        minimumClientVersion: "1.0.0",
        mode: "cloud",
      });
    },
    listAgents: (signal) => {
      calls.push(`agents:${String(signal === controller.signal)}`);
      return Promise.resolve([agent]);
    },
    listHarnesses: (signal) => {
      calls.push(`harnesses:${String(signal === controller.signal)}`);
      return Promise.resolve([]);
    },
    listRuns: (id, signal) => {
      calls.push(`runs:${id}:${String(signal === controller.signal)}`);
      return Promise.resolve([]);
    },
    prewarmTenant: (signal) => {
      calls.push(`prewarm:${String(signal === controller.signal)}`);
      return Promise.resolve();
    },
    stopRun: (id, signal) => {
      calls.push(`stop:${id}:${String(signal === controller.signal)}`);
      return Promise.resolve(snapshot("cancelled"));
    },
    streamRunEvents: (id, options) => {
      calls.push(
        `events:${id}:${options.lastEventId}:${String(options.signal === controller.signal)}`
      );
      return Promise.resolve(snapshot("completed"));
    },
    updateAgent: (id, updateInput, signal) => {
      calls.push(
        `update:${id}:${updateInput.name}:${String(signal === controller.signal)}`
      );
      return Promise.resolve(agent);
    },
  });
  const client = new RunnerClient(transport);
  const input = {
    backend: agent.backend,
    description: agent.description,
    instructions: agent.instructions,
    model: agent.model,
    name: agent.name,
    runtime: agent.runtime,
    workspace: agent.workspace,
  };

  await client.health(controller.signal);
  await client.listHarnesses(controller.signal);
  await client.listAgents(controller.signal);
  await client.getAgent(AGENT_ID, controller.signal);
  await client.createAgent(input, controller.signal);
  await client.updateAgent(AGENT_ID, input, controller.signal);
  await client.deleteAgent(AGENT_ID, controller.signal);
  await client.prewarmTenant(controller.signal);
  await client.listRuns(AGENT_ID, controller.signal);
  await client.streamRunEvents(RUN_ID, {
    lastEventId: 7,
    onEvent: () => undefined,
    signal: controller.signal,
  });
  await client.stopRun(RUN_ID, controller.signal);

  assert.deepEqual(calls, [
    "health:true",
    "harnesses:true",
    "agents:true",
    `agent:${AGENT_ID}:true`,
    `create:${agent.name}:true`,
    `update:${AGENT_ID}:${agent.name}:true`,
    `delete:${AGENT_ID}:true`,
    "prewarm:true",
    `runs:${AGENT_ID}:true`,
    `events:${RUN_ID}:7:true`,
    `stop:${RUN_ID}:true`,
  ]);
});

test("startRun delegates one v1 start with a generated operation id", async () => {
  let sent:
    | {
        agentId: string;
        operationId: string;
        signal?: AbortSignal;
        task: string;
      }
    | undefined;
  const controller = new AbortController();
  const client = new RunnerClient(
    fakeTransport({
      startRun: (agentId, startInput, signal) => {
        sent = { agentId, signal, ...startInput };
        return Promise.resolve({
          ...snapshot("queued"),
          operationId: startInput.operationId,
        });
      },
    })
  );

  await client.startRun(AGENT_ID, "Do the work.", {
    harnessId: "copilot",
    signal: controller.signal,
  });

  assert.equal(sent?.agentId, AGENT_ID);
  assert.equal(sent?.task, "Do the work.");
  assert.equal(sent?.signal, controller.signal);
  assert.match(
    sent?.operationId ?? "",
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});

test("runAgent follows an accepted v1 snapshot to completion", async () => {
  let reads = 0;
  const client = new RunnerClient(
    fakeTransport({
      getRun: () => {
        reads += 1;
        return Promise.resolve(snapshot(reads === 1 ? "running" : "completed"));
      },
      startRun: () => Promise.resolve(snapshot("queued")),
    }),
    { pollIntervalMs: 0 }
  );

  const result = await client.runAgent(AGENT_ID, "Do the work.");

  assert.equal(reads, 2);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "done");
  assert.equal(result.commandResults.length, 1);
});

test("run polling aborts promptly", async () => {
  const controller = new AbortController();
  const client = new RunnerClient(
    fakeTransport({
      startRun: () => Promise.resolve(snapshot("running")),
    }),
    { pollIntervalMs: 30_000 }
  );

  const pending = client.runAgent(AGENT_ID, "Do the work.", {
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(
    pending,
    (error: unknown) =>
      error instanceof RunnerApiError && error.code === "aborted"
  );
});

test("operation ids still use secure random bytes when randomUUID is unavailable", async () => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: original.getRandomValues.bind(original) },
  });
  try {
    let generated = "";
    const client = new RunnerClient(
      fakeTransport({
        startRun: (_agentId, startInput) => {
          generated = startInput.operationId;
          return Promise.resolve({
            ...snapshot("queued"),
            operationId: startInput.operationId,
          });
        },
      })
    );

    await client.startRun(AGENT_ID, "Do the work.");

    assert.match(
      generated,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  } finally {
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: original,
    });
  }
});
