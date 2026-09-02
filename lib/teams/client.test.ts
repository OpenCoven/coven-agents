import assert from "node:assert/strict";
import test from "node:test";
import { TeamApiError, TeamClient } from "./client";

test("team client uses same-origin reads", async () => {
  const calls: Array<{ init: RequestInit; path: string }> = [];
  const client = new TeamClient((path, init = {}) => {
    calls.push({ init, path: String(path) });
    return Promise.resolve(
      Response.json(
        {
          error: {
            code: "not_found",
            message: "Not found.",
            retryable: false,
          },
          requestId: "request-1",
        },
        { status: 404 }
      )
    );
  });

  await assert.rejects(
    client.listTeams(),
    (error: unknown) =>
      error instanceof TeamApiError &&
      error.code === "not_found" &&
      error.status === 404
  );
  assert.equal(calls[0]?.path, "/api/teams");
  assert.equal(calls[0]?.init.method, "GET");
  assert.equal(calls[0]?.init.credentials, "same-origin");
  assert.equal(calls[0]?.init.redirect, "error");
});

test("team creation accepts a stable idempotency key and strict JSON body", async () => {
  const calls: Array<{ init: RequestInit; path: string }> = [];
  const client = new TeamClient((path, init = {}) => {
    calls.push({ init, path: String(path) });
    return Promise.resolve(
      Response.json(
        {
          error: {
            code: "invalid_request",
            message: "Invalid request.",
            retryable: false,
          },
          requestId: "request-2",
        },
        { status: 400 }
      )
    );
  });
  const input = {
    description: "A bounded sequence.",
    members: [
      {
        agentId: "11111111-1111-4111-8111-111111111111",
        required: true,
        responsibility: "Investigate.",
        skillIds: [],
      },
      {
        agentId: "22222222-2222-4222-8222-222222222222",
        required: true,
        responsibility: "Implement.",
        skillIds: [],
      },
    ],
    name: "Delivery team",
  };

  await assert.rejects(
    client.createTeam(input, {
      idempotencyKey: "stable-team-create-key",
    }),
    (error: unknown) =>
      error instanceof TeamApiError && error.code === "invalid_request"
  );
  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(calls[0]?.path, "/api/teams");
  assert.equal(calls[0]?.init.method, "POST");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("idempotency-key"), "stable-team-create-key");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), input);
});

test("team run listing preserves its opaque pagination cursor", async () => {
  const calls: Array<{ init: RequestInit; path: string }> = [];
  const client = new TeamClient((path, init = {}) => {
    calls.push({ init, path: String(path) });
    return Promise.resolve(Response.json({ nextCursor: null, teamRuns: [] }));
  });
  const teamId = "44444444-4444-4444-8444-444444444444";
  const cursor = "55555555-5555-4555-8555-555555555555";

  const page = await client.listTeamRuns(teamId, { cursor });

  assert.deepEqual(page, { nextCursor: null, teamRuns: [] });
  assert.equal(
    calls[0]?.path,
    `/api/teams/${teamId}/runs?cursor=${encodeURIComponent(cursor)}`
  );
});

test("team run creation preserves a caller-owned logical submission key", async () => {
  const calls: Array<{ init: RequestInit; path: string }> = [];
  const client = new TeamClient((path, init = {}) => {
    calls.push({ init, path: String(path) });
    return Promise.resolve(
      Response.json(
        {
          error: {
            code: "request_in_progress",
            message: "In progress.",
            retryable: true,
          },
          requestId: "request-4",
        },
        { status: 409 }
      )
    );
  });
  const teamId = "44444444-4444-4444-8444-444444444444";
  const input = {
    operationId: "55555555-5555-4555-8555-555555555555",
    task: "Deliver the approved issue.",
  };

  await assert.rejects(
    client.createTeamRun(teamId, input, {
      idempotencyKey: "stable-team-run-submission",
    }),
    (error: unknown) =>
      error instanceof TeamApiError && error.code === "request_in_progress"
  );

  const headers = new Headers(calls[0]?.init.headers);
  assert.equal(headers.get("idempotency-key"), "stable-team-run-submission");
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), input);
});

test("approval and stop requests preserve optimistic versions", async () => {
  const calls: Array<{ init: RequestInit; path: string }> = [];
  const client = new TeamClient((path, init = {}) => {
    calls.push({ init, path: String(path) });
    return Promise.resolve(
      Response.json(
        {
          error: {
            code: "stale_version",
            message: "Stale version.",
            retryable: false,
          },
          requestId: "request-3",
        },
        { status: 409 }
      )
    );
  });
  const runId = "33333333-3333-4333-8333-333333333333";

  await assert.rejects(
    client.approveTeamRun(runId, {
      capabilities: ["github.issues.write"],
      decision: "approve",
      expectedVersion: 7,
    }),
    TeamApiError
  );
  await assert.rejects(client.stopTeamRun(runId, 8), TeamApiError);

  assert.equal(calls[0]?.path, `/api/team-runs/${runId}/approve`);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    capabilities: ["github.issues.write"],
    decision: "approve",
    expectedVersion: 7,
  });
  assert.equal(calls[1]?.path, `/api/team-runs/${runId}/stop`);
  assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), {
    expectedVersion: 8,
  });
});
