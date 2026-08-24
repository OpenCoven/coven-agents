import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDefinition } from "@opencoven/agent-contracts";
import {
  type CloudRunnerAgent,
  type CloudRunnerDirectory,
  createCloudRunner,
} from "./routes";
import { UNOWNED_TENANT } from "./tenant";

const TOKEN = "test-token";
const MINE = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const THEIRS = "9c1b7d2f-5a6b-4c90-8f1a-0f4e1f4d4a2e";
/** A run owned by another tenant. */
const RUN_ID = "11111111-2222-4333-8444-555555555555";
/** A run owned by the caller, so the negative tests have a control. */
const MY_RUN_ID = "22222222-3333-4444-8555-666666666666";

const environment = {
  AGENT_CONTROL_TOKEN: TOKEN,
  ALLOWED_ORIGIN: "*",
};

function definition(id: string, tenantId: string): AgentDefinition {
  return {
    backend: "cloud",
    createdAt: "2026-08-20T12:00:00.000Z",
    description: "",
    id,
    instructions: "Do the thing.",
    lastRunAt: null,
    model: "auto",
    name: id === MINE ? "Mine" : "Theirs",
    owner: { kind: "tenant", tenantId },
    runtime: "copilot",
    status: "idle",
    updatedAt: "2026-08-20T12:00:00.000Z",
  };
}

/**
 * `THEIRS` is owned by a tenant the caller is not. The caller always resolves
 * to UNOWNED_TENANT today, so `MINE` is reachable and `THEIRS` must not be.
 */
const agents = new Map<string, AgentDefinition>([
  [MINE, definition(MINE, UNOWNED_TENANT)],
  [THEIRS, definition(THEIRS, "someone_else")],
]);

let decommissioned: string[] = [];
let stopped: string[] = [];

function runner() {
  decommissioned = [];
  stopped = [];

  const directory: CloudRunnerDirectory = {
    list: (tenantId) =>
      [...agents.values()].filter(
        (agent) =>
          agent.owner?.kind === "tenant" && agent.owner.tenantId === tenantId
      ),
    // Resolves to a real owner rather than always the other tenant, so the
    // negative tests cannot pass just because every run route 404s.
    lookupRun: (runId) => (runId === MY_RUN_ID ? MINE : THEIRS),
    registerRun: () => undefined,
    remove: () => undefined,
    upsert: (value) => value,
  };

  const getYoloAgent = (_environment: unknown, agentId: string) =>
    ({
      configure: (value: AgentDefinition) => value,
      decommission: () => {
        decommissioned.push(agentId);
      },
      getEventStream: () => ({ events: [], terminal: false }),
      // Returns a real run rather than null. With null the route 404s because
      // the run is missing, so the test would pass whether or not ownership is
      // checked — it has to be reachable for the 404 to mean anything.
      getRun: () => ({
        agentId,
        apiVersion: "2026-08-01",
        commandEvidence: [],
        completedAt: "2026-08-20T12:00:05.000Z",
        createdAt: "2026-08-20T12:00:00.000Z",
        fileEvidence: [],
        id: agentId === MINE ? MY_RUN_ID : RUN_ID,
        operationId: MINE,
        output: "done",
        startedAt: "2026-08-20T12:00:01.000Z",
        status: "completed",
        task: "Fix the tests.",
      }),
      snapshot: () => agents.get(agentId) ?? null,
      start: () => {
        throw new Error("start must not be reached for another tenant");
      },
      stop: (runId: string) => {
        stopped.push(runId);
        return null;
      },
    }) as unknown as CloudRunnerAgent;

  return createCloudRunner({
    getDirectory: () => directory,
    getYoloAgent,
  });
}

function call(path: string, method = "GET"): Promise<Response> {
  return runner().fetch(
    new Request(`https://runner.test${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      method,
    }),
    environment as never
  );
}

test("a listing only contains the caller's own agents", async () => {
  const response = await call("/api/agents");
  const body = (await response.json()) as { agents: AgentDefinition[] };

  assert.deepEqual(
    body.agents.map((agent) => agent.id),
    [MINE]
  );
});

test("another tenant's agent reads as absent, not forbidden", async () => {
  // 404 rather than 403: a 403 would confirm the id exists for someone else.
  const response = await call(`/api/agents/${THEIRS}`);

  assert.equal(response.status, 404);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "not_found"
  );
});

test("the caller's own agent is still reachable", async () => {
  const response = await call(`/api/agents/${MINE}`);

  assert.equal(response.status, 200);
});

test("another tenant's agent cannot be deleted", async () => {
  const response = await call(`/api/agents/${THEIRS}`, "DELETE");

  assert.equal(response.status, 404);
  assert.deepEqual(decommissioned, [], "decommission must not be reached");
});

test("another tenant's agent cannot be run", async () => {
  const response = await call(`/api/agents/${THEIRS}/runs`, "POST");

  assert.equal(response.status, 404);
});

/**
 * The run routes resolve an agent from a run id. Without an ownership check
 * there, holding a run id was enough to read, stream or cancel another
 * tenant's run — the agent routes alone did not cover it.
 */
test("a run id belonging to another tenant is not readable", async () => {
  const response = await call(`/api/runs/${RUN_ID}`);

  assert.equal(response.status, 404);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "run_not_found"
  );
});

test("a run id belonging to another tenant cannot be streamed", async () => {
  const response = await call(`/api/runs/${RUN_ID}/events`);

  assert.equal(response.status, 404);
  assert.notEqual(
    response.headers.get("content-type"),
    "text/event-stream; charset=utf-8"
  );
});

test("a run id belonging to another tenant cannot be stopped", async () => {
  const response = await call(`/api/runs/${RUN_ID}/stop`, "POST");

  assert.equal(response.status, 404);
  assert.deepEqual(stopped, [], "stop must not be reached");
});

/**
 * A control for the negative run-route tests above. Without it, a regression
 * that made every run route 404 — for any reason, not just ownership — would
 * leave all of them passing.
 */
test("a run belonging to the caller is readable", async () => {
  const response = await call(`/api/runs/${MY_RUN_ID}`);

  assert.equal(response.status, 200);
  const body = (await response.json()) as { run: { id: string } };
  assert.equal(body.run.id, MY_RUN_ID);
});

test("a client-supplied owner is rejected at the route, not just the schema", async () => {
  // Guards the invariant end to end: ownership is stamped from the caller, and
  // createAgentInputSchema staying .strict() is what stops a submitted claim
  // from being silently accepted if the spread order ever changes.
  const response = await runner().fetch(
    new Request("https://runner.test/api/agents", {
      body: JSON.stringify({
        backend: "cloud",
        instructions: "Do the thing.",
        model: "auto",
        name: "Impostor",
        owner: { kind: "tenant", tenantId: "someone_else" },
        runtime: "copilot",
      }),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      method: "POST",
    }),
    environment as never
  );

  assert.equal(response.status, 400);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    "invalid_request"
  );
});
