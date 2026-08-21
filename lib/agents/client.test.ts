import assert from "node:assert/strict";
import test from "node:test";
import { RunnerApiError, RunnerClient } from "./client";

const agent = {
  backend: "cloud" as const,
  createdAt: "2026-08-20T12:00:00.000Z",
  description: "Code familiar",
  id: "53af1a29-4e98-43d6-ac5b-3b9dcba5e730",
  instructions: "Implement with evidence.",
  lastRunAt: null,
  model: "gpt-5.1",
  name: "Cody",
  owner: { kind: "standalone" },
  runtime: "cloud" as const,
  status: "idle" as const,
  updatedAt: "2026-08-20T12:00:00.000Z",
  workspace: "/workspace",
};

test("sends bearer authentication and normalizes the endpoint", async () => {
  let requestedUrl = "";
  let authorization = "";
  const request: typeof fetch = (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return Promise.resolve(Response.json({ agents: [agent] }));
  };
  const client = new RunnerClient(
    { endpoint: "https://runner.example.com/", token: "secret" },
    request
  );

  const agents = await client.listAgents();

  assert.equal(requestedUrl, "https://runner.example.com/api/agents");
  assert.equal(authorization, "Bearer secret");
  assert.equal(agents[0]?.name, "Cody");
});

test("surfaces structured runner errors", async () => {
  const request: typeof fetch = () =>
    Promise.resolve(
      Response.json(
        { code: "unauthorized", error: "Token rejected." },
        { status: 401 }
      )
    );
  const client = new RunnerClient(
    { endpoint: "https://runner.example.com", token: "wrong" },
    request
  );

  await assert.rejects(
    client.listAgents(),
    (error: unknown) =>
      error instanceof RunnerApiError &&
      error.code === "unauthorized" &&
      error.status === 401
  );
});
