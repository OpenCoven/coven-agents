// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import {
  okEnvelopeSchema,
  type SkillResource,
  skillEnvelopeSchema,
  skillsEnvelopeSchema,
  type TeamResource,
  type TeamRun,
  teamEnvelopeSchema,
  teamRunEnvelopeSchema,
  teamRunsEnvelopeSchema,
  teamsEnvelopeSchema,
} from "@opencoven/agent-contracts";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompleteInput,
  IdempotencyReleaseInput,
  IdempotencyStore,
} from "@/lib/abuse/idempotency";
import { createRunnerAuth, type RunnerAuth } from "@/lib/runner/auth";
import { createTeamHttpHandlers, type TeamHttpHandlers } from "./http";
import type { TeamService } from "./service";

const fixtureMode = process.env.TEAM_ROUTES_FIXTURE;
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";
const TENANT = "u_9c8589018a57479181fe4c455b099bc9";
const SKILL_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER_A = "33333333-3333-4333-8333-333333333333";
const MEMBER_B = "44444444-4444-4444-8444-444444444444";
const AGENT_A = "55555555-5555-4555-8555-555555555555";
const AGENT_B = "66666666-6666-4666-8666-666666666666";
const REQUEST_ID = "77777777-7777-4777-8777-777777777777";
const TEAM_RUN_ID = "88888888-8888-4888-8888-888888888888";
const TEAM_STEP_ID = "99999999-9999-4999-8999-999999999999";
const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REPLAY_HEADER_VALUE = "team-http-test-key-0001";
const NativeRequest = globalThis.Request;

class Request extends NativeRequest {
  constructor(
    input: ConstructorParameters<typeof NativeRequest>[0],
    init: RequestInit = {}
  ) {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    if (method === "POST" || method === "PUT" || method === "DELETE") {
      if (!headers.has("origin")) {
        headers.set("origin", new URL(String(input)).origin);
      }
      if (init.body !== undefined && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      if (method === "POST" && !headers.has("idempotency-key")) {
        headers.set("idempotency-key", REPLAY_HEADER_VALUE);
      }
    }
    super(input, { ...init, headers });
  }
}

const subscriber = {
  authVersion: 4,
  kind: "allowed" as const,
  principal: {
    kind: "subscriber" as const,
    tenant: TENANT,
    userId: USER_ID,
  },
  session: { kind: "subscriber" as const, tenant: TENANT, userId: USER_ID },
  userId: USER_ID,
};

const skill: SkillResource = {
  createdAt: "2026-08-30T12:00:00.000Z",
  description: "Requires focused regression evidence.",
  id: SKILL_ID,
  instructions: "Run the smallest regression test that proves the change.",
  name: "Release evidence",
  requiredCapabilities: ["workspace.read"],
  updatedAt: "2026-08-30T12:00:00.000Z",
  version: 2,
};

const team: TeamResource = {
  createdAt: "2026-08-30T12:00:00.000Z",
  description: "Moves approved work through delivery.",
  id: TEAM_ID,
  members: [
    {
      agentId: AGENT_A,
      id: MEMBER_A,
      position: 0,
      required: true,
      responsibility: "Implement the approved change.",
      skillIds: [SKILL_ID],
    },
    {
      agentId: AGENT_B,
      id: MEMBER_B,
      position: 1,
      required: false,
      responsibility: "Review the resulting change.",
      skillIds: [],
    },
  ],
  name: "Delivery team",
  updatedAt: "2026-08-30T12:00:00.000Z",
  version: 3,
};

const teamRun: TeamRun = {
  completedAt: null,
  createdAt: "2026-08-30T12:00:00.000Z",
  currentPosition: 0,
  error: null,
  id: TEAM_RUN_ID,
  mission: "Deliver the approved issue.",
  operationId: OPERATION_ID,
  startedAt: null,
  status: "queued",
  steps: [
    {
      agentId: AGENT_A,
      approvalCapabilities: ["github.issues.write"],
      approvalStatus: "pending",
      completedAt: null,
      createdAt: "2026-08-30T12:00:00.000Z",
      error: null,
      handoff: null,
      id: TEAM_STEP_ID,
      position: 0,
      required: true,
      responsibility: "Implement the approved change.",
      runnerRunId: null,
      skillIds: [SKILL_ID],
      startedAt: null,
      status: "waiting_approval",
      updatedAt: "2026-08-30T12:00:00.000Z",
      version: 2,
    },
  ],
  teamId: TEAM_ID,
  updatedAt: "2026-08-30T12:00:00.000Z",
  version: 3,
};

function authorizedAuth(): RunnerAuth {
  return {
    authorizeDiagnostic: () => ({ kind: "unauthorized" }),
    authorizeReconcile: () => ({ kind: "unauthorized" }),
    authorizeSubscriber: async () => subscriber,
  };
}

function service(overrides: Partial<TeamService> = {}): TeamService {
  return {
    approveRun: async () => ({
      kind: "approved",
      teamRun: {
        ...teamRun,
        status: "queued",
        steps: teamRun.steps.map((step) => ({
          ...step,
          approvalStatus: "approved",
          version: step.version + 1,
        })),
      },
    }),
    createRun: async () => ({ kind: "created", teamRun }),
    createSkill: async () => ({ kind: "created", skill }),
    createTeam: async () => ({ kind: "created", team }),
    deleteSkill: async () => ({ kind: "deleted" }),
    deleteTeam: async () => ({ kind: "deleted" }),
    getRun: async () => ({ kind: "found", teamRun }),
    getSkill: async () => ({ kind: "found", skill }),
    getTeam: async () => ({ kind: "found", team }),
    listRuns: async () => ({
      kind: "found",
      nextCursor: null,
      teamRuns: [teamRun],
    }),
    listSkills: async () => [skill],
    listTeams: async () => [team],
    stopRun: async () => ({
      cancellation: "confirmed",
      kind: "stopped",
      scheduleReconciliation: true,
      teamRun: {
        ...teamRun,
        completedAt: "2026-08-30T12:01:00.000Z",
        status: "cancelled",
        version: teamRun.version + 1,
      },
    }),
    updateSkill: async () => ({
      kind: "updated",
      skill: { ...skill, name: "Updated", version: 3 },
    }),
    updateTeam: async () => ({
      kind: "updated",
      team: { ...team, name: "Updated", version: 4 },
    }),
    ...overrides,
  };
}

function handlers(
  options: {
    admission?: AbuseAdmission;
    appOrigin?: string | (() => string | null);
    auth?: RunnerAuth;
    draftMission?: (input: {
      description: string;
      hint: string;
      members: readonly Readonly<{
        required: boolean;
        responsibility: string;
      }>[];
      name: string;
    }) => Promise<string>;
    idempotencyStore?: IdempotencyStore;
    onAbuse?: (input: AbuseEnforcementInput) => void;
    onAfter?: (operation: () => Promise<void>) => void;
    service?: TeamService;
  } = {}
) {
  const admissions: AbuseEnforcementInput[] = [];
  const events: string[] = [];
  const idempotencyStore =
    options.idempotencyStore ?? new MemoryIdempotencyStore();
  let serviceRequests = 0;
  const teamService = options.service ?? service();
  const result = createTeamHttpHandlers({
    ...(Object.hasOwn(options, "appOrigin")
      ? { appOrigin: options.appOrigin }
      : {}),
    after: (operation) => {
      events.push("after");
      options.onAfter?.(operation);
    },
    auth: options.auth ?? authorizedAuth(),
    createRequestId: () => REQUEST_ID,
    ...(options.draftMission ? { draftMission: options.draftMission } : {}),
    createService: () => {
      events.push("service");
      serviceRequests += 1;
      return teamService;
    },
    enforceAbuse: (input) => {
      events.push("abuse");
      options.onAbuse?.(input);
      admissions.push(input);
      return Promise.resolve(options.admission ?? { kind: "allowed" });
    },
    idempotencyStore,
    ipAddress: () => "203.0.113.10",
    reconcile: async () => {
      events.push("reconcile");
    },
  });
  return {
    admissions,
    events,
    handlers: result,
    idempotencyStore,
    serviceRequests: () => serviceRequests,
  };
}

function skillBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    description: skill.description,
    instructions: skill.instructions,
    name: skill.name,
    requiredCapabilities: skill.requiredCapabilities,
    ...overrides,
  });
}

function teamBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    description: team.description,
    members: team.members.map(
      ({ id: _id, position: _position, ...member }) => member
    ),
    name: team.name,
    ...overrides,
  });
}

function teamRunBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    operationId: OPERATION_ID,
    task: "Deliver the approved issue.",
    ...overrides,
  });
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as {
    error: { code: string };
    requestId: string;
  };
  assert.equal(body.requestId, REQUEST_ID);
  return body.error.code;
}

type MemoryRecord = {
  claimExpiresAt: Date;
  expiresAt: Date;
  requestHash: string;
  response: IdempotencyCompleteInput["response"] | null;
  state: "completed" | "in_progress";
};

class MemoryIdempotencyStore implements IdempotencyStore {
  readonly claims: IdempotencyClaimInput[] = [];
  private readonly records = new Map<string, MemoryRecord>();

  cleanupExpired(input: { before: Date; limit: number }): Promise<void> {
    let deleted = 0;
    for (const [scope, record] of this.records) {
      if (
        deleted < input.limit &&
        record.expiresAt.getTime() <= input.before.getTime()
      ) {
        this.records.delete(scope);
        deleted += 1;
      }
    }
    return Promise.resolve();
  }

  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.claims.push(input);
    const scope = idempotencyScope(input);
    const existing = this.records.get(scope);
    if (!existing || existing.expiresAt.getTime() <= input.now.getTime()) {
      this.records.set(scope, {
        claimExpiresAt: input.claimExpiresAt,
        expiresAt: input.claimExpiresAt,
        requestHash: input.requestHash,
        response: null,
        state: "in_progress",
      });
      return Promise.resolve({
        claim: idempotencyClaim(input),
        kind: "claimed",
      });
    }
    if (existing.requestHash !== input.requestHash) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (existing.state === "in_progress") {
      return Promise.resolve({ kind: "in_progress" });
    }
    assert.ok(existing.response);
    return Promise.resolve({
      kind: "completed",
      response: existing.response,
    });
  }

  complete(input: IdempotencyCompleteInput): Promise<"completed" | "lost"> {
    const record = this.records.get(idempotencyScope(input.claim));
    assert.ok(record);
    record.expiresAt = input.expiresAt;
    record.response = input.response;
    record.state = "completed";
    return Promise.resolve("completed");
  }

  release(input: IdempotencyReleaseInput): Promise<"lost" | "released"> {
    this.records.delete(idempotencyScope(input.claim));
    return Promise.resolve("released");
  }
}

function idempotencyScope(input: {
  keyHash: string;
  operation: string;
  ownerId: string;
}): string {
  return `${input.ownerId}:${input.operation}:${input.keyHash}`;
}

function idempotencyClaim(input: IdempotencyClaimInput) {
  return {
    claimExpiresAt: input.claimExpiresAt,
    keyHash: input.keyHash,
    operation: input.operation,
    ownerId: input.ownerId,
    requestHash: input.requestHash,
  };
}

test("signed-out and stale authentication return 401 while subscription denial returns 403", async () => {
  const signedOut = handlers({
    auth: createRunnerAuth({
      authenticate: async () => null,
      authorizeSubscriberAccess: async () => ({
        authVersion: 1,
        kind: "allowed",
        session: subscriber.session,
        userId: USER_ID,
      }),
    }),
  });
  const stale = handlers({
    auth: createRunnerAuth({
      authenticate: async () => ({
        user: { authVersion: null, id: USER_ID, type: "subscriber" },
      }),
      authorizeSubscriberAccess: async () => ({ kind: "unauthorized" }),
    }),
  });
  const lapsed = handlers({
    auth: createRunnerAuth({
      authenticate: async () => ({
        user: { authVersion: 4, id: USER_ID, type: "subscriber" },
      }),
      authorizeSubscriberAccess: async () => ({
        kind: "subscription_required",
      }),
    }),
  });

  await Promise.all(
    [signedOut, stale].map(async (fixture) => {
      const response = await fixture.handlers.listSkills(
        new Request("https://app.test/api/skills")
      );
      assert.equal(response.status, 401);
      assert.equal(await errorCode(response), "unauthorized");
      assert.equal(fixture.admissions.length, 0);
      assert.equal(fixture.serviceRequests(), 0);
    })
  );
  const response = await lapsed.handlers.listTeams(
    new Request("https://app.test/api/teams")
  );
  assert.equal(response.status, 403);
  assert.equal(await errorCode(response), "subscription_required");
  assert.equal(lapsed.admissions.length, 0);
  assert.equal(lapsed.serviceRequests(), 0);
});

test("mutation origin and content type rejections happen before auth, abuse, body, or service", async () => {
  let authCalls = 0;
  const fixture = handlers({
    auth: {
      ...authorizedAuth(),
      authorizeSubscriber: () => {
        authCalls += 1;
        return Promise.resolve(subscriber);
      },
    },
  });
  const crossOrigin = new NativeRequest("https://app.test/api/skills", {
    body: skillBody(),
    headers: {
      "content-type": "application/json",
      origin: "https://sibling.app.test",
    },
    method: "POST",
  });
  const wrongType = new NativeRequest("https://app.test/api/teams", {
    body: teamBody(),
    headers: {
      "content-type": "text/plain",
      origin: "https://app.test",
    },
    method: "POST",
  });

  const originResponse = await fixture.handlers.createSkill(crossOrigin);
  const typeResponse = await fixture.handlers.createTeam(wrongType);

  assert.equal(originResponse.status, 403);
  assert.equal(await errorCode(originResponse), "origin_rejected");
  assert.equal(typeResponse.status, 400);
  assert.equal(await errorCode(typeResponse), "unsupported_media_type");
  assert.equal(crossOrigin.bodyUsed, false);
  assert.equal(wrongType.bodyUsed, false);
  assert.equal(authCalls, 0);
  assert.equal(fixture.admissions.length, 0);
  assert.equal(fixture.serviceRequests(), 0);
});

test("abuse denial and outage happen after auth but before body parsing and service construction", async () => {
  await Promise.all(
    (
      [
        [
          { kind: "denied", responseStatus: 429, retryAfterSeconds: 17 },
          429,
          "rate_limited",
        ],
        [
          { kind: "unavailable", responseStatus: 503 },
          503,
          "abuse_control_unavailable",
        ],
      ] as const
    ).map(async ([admission, status, code]) => {
      const fixture = handlers({ admission });
      const request = new Request("https://app.test/api/teams", {
        body: "not-json",
        method: "POST",
      });
      const response = await fixture.handlers.createTeam(request);

      assert.equal(response.status, status);
      assert.equal(await errorCode(response), code);
      assert.equal(request.bodyUsed, false);
      assert.equal(fixture.admissions.length, 1);
      assert.equal(fixture.serviceRequests(), 0);
      if (admission.kind === "denied") {
        assert.equal(response.headers.get("retry-after"), "17");
      }
    })
  );
});

test("strict invalid and oversized bodies return bounded errors without constructing a service", async () => {
  const fixture = handlers();
  const invalid = await fixture.handlers.createSkill(
    new Request("https://app.test/api/skills", {
      body: skillBody({ tenant: "caller-controlled" }),
      method: "POST",
    })
  );
  const oversized = await fixture.handlers.createSkill(
    new Request("https://app.test/api/skills", {
      body: skillBody({ instructions: "x".repeat(9000) }),
      method: "POST",
    })
  );

  assert.equal(invalid.status, 400);
  assert.equal(await errorCode(invalid), "invalid_request");
  assert.equal(oversized.status, 413);
  assert.equal(await errorCode(oversized), "body_too_large");
  assert.equal(fixture.serviceRequests(), 0);
});

test("skill and team creation require a valid idempotency key after body validation", async () => {
  const fixture = handlers();
  const missing = await fixture.handlers.createSkill(
    new NativeRequest("https://app.test/api/skills", {
      body: skillBody(),
      headers: {
        "content-type": "application/json",
        origin: "https://app.test",
      },
      method: "POST",
    })
  );
  const invalid = await fixture.handlers.createTeam(
    new Request("https://app.test/api/teams", {
      body: teamBody(),
      headers: { "idempotency-key": "short" },
      method: "POST",
    })
  );

  assert.equal(missing.status, 400);
  assert.equal(await errorCode(missing), "idempotency_key_required");
  assert.equal(invalid.status, 400);
  assert.equal(await errorCode(invalid), "invalid_idempotency_key");
  assert.equal(fixture.admissions.length, 2);
  assert.equal(fixture.serviceRequests(), 0);
});

test("same skill creation key replays the exact response without constructing the service twice", async () => {
  const fixture = handlers();
  const create = () =>
    fixture.handlers.createSkill(
      new Request("https://app.test/api/skills", {
        body: skillBody(),
        method: "POST",
      })
    );

  const first = await create();
  const firstBody = await first.text();
  const replay = await create();

  assert.equal(first.status, 201);
  assert.equal(first.headers.get("idempotency-replayed"), null);
  assert.equal(replay.status, 201);
  assert.equal(replay.headers.get("idempotency-replayed"), "true");
  assert.equal(await replay.text(), firstBody);
  assert.equal(fixture.serviceRequests(), 1);
});

test("same creation key with a different request returns a stable conflict", async () => {
  const fixture = handlers();
  await fixture.handlers.createTeam(
    new Request("https://app.test/api/teams", {
      body: teamBody(),
      method: "POST",
    })
  );

  const conflict = await fixture.handlers.createTeam(
    new Request("https://app.test/api/teams", {
      body: teamBody({ name: "Different team" }),
      method: "POST",
    })
  );

  assert.equal(conflict.status, 409);
  assert.equal(await errorCode(conflict), "idempotency_conflict");
  assert.equal(fixture.serviceRequests(), 1);
});

test("team run create distinguishes created, duplicate, and conflict while scheduling reconciliation", async () => {
  const scheduled: Array<() => Promise<void>> = [];
  const calls: unknown[][] = [];
  let mode: "conflict" | "created" | "duplicate" = "created";
  const fixture = handlers({
    onAfter: (operation) => scheduled.push(operation),
    service: service({
      createRun: async (...args) => {
        calls.push(args);
        return mode === "conflict"
          ? { kind: "conflict" }
          : { kind: mode, teamRun };
      },
    }),
  });

  const created = await fixture.handlers.createTeamRun(
    new Request(`https://app.test/api/teams/${TEAM_ID}/runs`, {
      body: teamRunBody(),
      method: "POST",
    }),
    TEAM_ID
  );
  mode = "duplicate";
  const duplicate = await fixture.handlers.createTeamRun(
    new Request(`https://app.test/api/teams/${TEAM_ID}/runs`, {
      body: teamRunBody(),
      headers: { "idempotency-key": "team-http-test-key-0002" },
      method: "POST",
    }),
    TEAM_ID
  );
  mode = "conflict";
  const conflict = await fixture.handlers.createTeamRun(
    new Request(`https://app.test/api/teams/${TEAM_ID}/runs`, {
      body: teamRunBody({ task: "Different immutable request." }),
      headers: { "idempotency-key": "team-http-test-key-0003" },
      method: "POST",
    }),
    TEAM_ID
  );

  assert.equal(created.status, 201);
  teamRunEnvelopeSchema.parse(await created.json());
  assert.equal(duplicate.status, 200);
  teamRunEnvelopeSchema.parse(await duplicate.json());
  assert.equal(conflict.status, 409);
  assert.equal(await errorCode(conflict), "resource_conflict");
  assert.deepEqual(calls[0], [
    subscriber.principal,
    subscriber.authVersion,
    TEAM_ID,
    {
      operationId: OPERATION_ID,
      task: "Deliver the approved issue.",
    },
  ]);
  assert.equal(scheduled.length, 2);
  await Promise.all(scheduled.map((operation) => operation()));
  assert.equal(
    fixture.events.filter((event) => event === "reconcile").length,
    2
  );
});

test("team run list and get return strict tenant-free contract envelopes", async () => {
  const fixture = handlers();

  const listed = await fixture.handlers.listTeamRuns(
    new Request(`https://app.test/api/teams/${TEAM_ID}/runs`),
    TEAM_ID
  );
  const found = await fixture.handlers.getTeamRun(
    new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}`),
    TEAM_RUN_ID
  );

  assert.equal(listed.status, 200);
  assert.equal(found.status, 200);
  teamRunsEnvelopeSchema.parse(await listed.json());
  const parsed = teamRunEnvelopeSchema.parse(await found.json());
  assert.equal(parsed.teamRun.version, 3);
  assert.equal(JSON.stringify(parsed).includes(TENANT), false);
  assert.equal(JSON.stringify(parsed).includes(USER_ID), false);
});

test("team run list forwards an opaque cursor and returns bounded-page metadata", async () => {
  const calls: unknown[][] = [];
  const fixture = handlers({
    service: service({
      listRuns: async (...args) => {
        calls.push(args);
        return {
          kind: "found",
          nextCursor: TEAM_RUN_ID,
          teamRuns: [teamRun],
        };
      },
    }),
  });

  const response = await fixture.handlers.listTeamRuns(
    new Request(
      `https://app.test/api/teams/${TEAM_ID}/runs?cursor=${TEAM_RUN_ID}`
    ),
    TEAM_ID
  );

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [[subscriber.principal, TEAM_ID, TEAM_RUN_ID]]);
  assert.deepEqual(await response.json(), {
    nextCursor: TEAM_RUN_ID,
    teamRuns: [teamRun],
  });
});

test("team run list returns not found for a missing tenant-fenced parent", async () => {
  const fixture = handlers({
    service: service({
      listRuns: async () => ({ kind: "not_found" }),
    }),
  });

  const response = await fixture.handlers.listTeamRuns(
    new Request(`https://app.test/api/teams/${TEAM_ID}/runs`),
    TEAM_ID
  );

  assert.equal(response.status, 404);
  assert.equal(await errorCode(response), "not_found");
});

test("team run stop and approval require strict JSON versions and schedule durable reconciliation", async () => {
  const scheduled: Array<() => Promise<void>> = [];
  const calls: unknown[][] = [];
  const fixture = handlers({
    onAfter: (operation) => scheduled.push(operation),
    service: service({
      approveRun: async (...args) => {
        calls.push(["approve", ...args]);
        return {
          kind:
            (args[2] as { decision?: string }).decision === "reject"
              ? "rejected"
              : "approved",
          teamRun,
        };
      },
      stopRun: async (...args) => {
        calls.push(["stop", ...args]);
        return {
          cancellation: "confirmed",
          kind: "stopped",
          scheduleReconciliation: true,
          teamRun,
        };
      },
    }),
  });

  const stopped = await fixture.handlers.stopTeamRun(
    new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}/stop`, {
      body: JSON.stringify({ expectedVersion: 3 }),
      method: "POST",
    }),
    TEAM_RUN_ID
  );
  const approved = await fixture.handlers.approveTeamRun(
    new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}/approve`, {
      body: JSON.stringify({
        capabilities: ["github.pull_requests.write"],
        decision: "approve",
        expectedVersion: 2,
      }),
      method: "POST",
    }),
    TEAM_RUN_ID
  );
  const rejected = await fixture.handlers.approveTeamRun(
    new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}/approve`, {
      body: JSON.stringify({
        decision: "reject",
        expectedVersion: 2,
      }),
      method: "POST",
    }),
    TEAM_RUN_ID
  );

  assert.equal(stopped.status, 200);
  assert.equal(approved.status, 200);
  assert.equal(rejected.status, 200);
  teamRunEnvelopeSchema.parse(await stopped.json());
  teamRunEnvelopeSchema.parse(await approved.json());
  teamRunEnvelopeSchema.parse(await rejected.json());
  assert.deepEqual(calls, [
    ["stop", subscriber.principal, TEAM_RUN_ID, 3],
    [
      "approve",
      subscriber.principal,
      TEAM_RUN_ID,
      {
        capabilities: ["github.pull_requests.write"],
        decision: "approve",
        expectedVersion: 2,
      },
    ],
    [
      "approve",
      subscriber.principal,
      TEAM_RUN_ID,
      {
        capabilities: [],
        decision: "reject",
        expectedVersion: 2,
      },
    ],
  ]);
  assert.equal(scheduled.length, 3);

  const invalidResponses = await Promise.all(
    [
      {
        capabilities: ["github.pull_requests.write"],
        expectedVersion: 2,
      },
      {
        capabilities: ["github.pull_requests.write"],
        decision: "reject",
        expectedVersion: 2,
      },
      {
        capabilities: [],
        decision: "approve",
        expectedVersion: 2,
      },
      {
        capabilities: ["github.pull_requests.write"],
        decision: "maybe",
        expectedVersion: 2,
      },
      {
        capabilities: ["github.projects.write"],
        decision: "approve",
        expectedVersion: 2,
        userId: USER_ID,
      },
    ].map((body) =>
      fixture.handlers.approveTeamRun(
        new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}/approve`, {
          body: JSON.stringify(body),
          method: "POST",
        }),
        TEAM_RUN_ID
      )
    )
  );
  assert.deepEqual(
    invalidResponses.map(({ status }) => status),
    [400, 400, 400, 400, 400]
  );
  assert.deepEqual(await Promise.all(invalidResponses.map(errorCode)), [
    "invalid_request",
    "invalid_request",
    "invalid_request",
    "invalid_request",
    "invalid_request",
  ]);
});

test("undeclared approval capability escalation has a stable safe error", async () => {
  const fixture = handlers({
    service: service({
      approveRun: async () => ({ kind: "invalid_capabilities" }),
    }),
  });

  const response = await fixture.handlers.approveTeamRun(
    new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}/approve`, {
      body: JSON.stringify({
        capabilities: ["github.projects.write"],
        decision: "approve",
        expectedVersion: 2,
      }),
      method: "POST",
    }),
    TEAM_RUN_ID
  );

  assert.equal(response.status, 400);
  assert.equal(await errorCode(response), "capability_escalation");
});

test("creation passes only the derived opaque key into deterministic ID generation", async () => {
  const creationKeys: string[] = [];
  const fixture = handlers({
    service: service({
      createSkill: (_principal, _input, creationKey) => {
        assert.ok(creationKey);
        creationKeys.push(creationKey);
        return Promise.resolve({ kind: "created", skill });
      },
      createTeam: (_principal, _input, creationKey) => {
        assert.ok(creationKey);
        creationKeys.push(creationKey);
        return Promise.resolve({ kind: "created", team });
      },
    }),
  });

  await fixture.handlers.createSkill(
    new Request("https://app.test/api/skills", {
      body: skillBody(),
      method: "POST",
    })
  );
  await fixture.handlers.createTeam(
    new Request("https://app.test/api/teams", {
      body: teamBody(),
      method: "POST",
    })
  );

  assert.equal(creationKeys.length, 2);
  assert.ok(creationKeys.every((key) => /^coven_[a-f0-9]{64}$/u.test(key)));
  assert.notEqual(creationKeys[0], REPLAY_HEADER_VALUE);
  assert.notEqual(creationKeys[1], REPLAY_HEADER_VALUE);
});

test("skill and team creation use separate tenant-scoped operation namespaces", async () => {
  const store = new MemoryIdempotencyStore();
  const fixture = handlers({ idempotencyStore: store });

  const skillResponse = await fixture.handlers.createSkill(
    new Request("https://app.test/api/skills", {
      body: skillBody(),
      method: "POST",
    })
  );
  const teamResponse = await fixture.handlers.createTeam(
    new Request("https://app.test/api/teams", {
      body: teamBody(),
      method: "POST",
    })
  );

  assert.equal(skillResponse.status, 201);
  assert.equal(teamResponse.status, 201);
  assert.equal(fixture.serviceRequests(), 2);
  assert.deepEqual(
    store.claims.map(({ ownerId }) => ownerId),
    [USER_ID, USER_ID]
  );
  assert.match(
    store.claims[0]?.operation ?? "",
    /^skill_create:[a-f0-9]{16}$/u
  );
  assert.match(store.claims[1]?.operation ?? "", /^team_create:[a-f0-9]{16}$/u);
  assert.notEqual(store.claims[0]?.operation, store.claims[1]?.operation);
  assert.equal(
    store.claims.every(({ operation }) => operation.length <= 64),
    true
  );
});

test("the same creation key does not collide across authenticated tenants", async () => {
  const store = new MemoryIdempotencyStore();
  const first = handlers({ idempotencyStore: store });
  const otherTenant = "u_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const second = handlers({
    auth: {
      ...authorizedAuth(),
      authorizeSubscriber: async () => ({
        ...subscriber,
        principal: {
          ...subscriber.principal,
          tenant: otherTenant,
        },
        session: {
          ...subscriber.session,
          tenant: otherTenant,
        },
      }),
    },
    idempotencyStore: store,
  });
  const create = (fixture: ReturnType<typeof handlers>) =>
    fixture.handlers.createSkill(
      new Request("https://app.test/api/skills", {
        body: skillBody(),
        method: "POST",
      })
    );

  assert.equal((await create(first)).status, 201);
  assert.equal((await create(second)).status, 201);
  assert.equal(first.serviceRequests(), 1);
  assert.equal(second.serviceRequests(), 1);
  assert.deepEqual(
    store.claims.map(({ ownerId }) => ownerId),
    [USER_ID, USER_ID]
  );
  assert.notEqual(store.claims[0]?.operation, store.claims[1]?.operation);
});

test("an in-progress creation claim returns a retryable stable conflict", async () => {
  let releaseCreate!: () => void;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const fixture = handlers({
    service: service({
      createSkill: async () => {
        signalStarted();
        await createGate;
        return { kind: "created", skill };
      },
    }),
  });
  const create = () =>
    fixture.handlers.createSkill(
      new Request("https://app.test/api/skills", {
        body: skillBody(),
        method: "POST",
      })
    );

  const first = create();
  await started;
  const concurrent = await create();
  const body = (await concurrent.json()) as {
    error: { code: string; retryable: boolean };
    requestId: string;
  };

  assert.equal(concurrent.status, 409);
  assert.equal(body.requestId, REQUEST_ID);
  assert.equal(body.error.code, "request_in_progress");
  assert.equal(body.error.retryable, true);
  assert.equal(fixture.serviceRequests(), 1);
  releaseCreate();
  assert.equal((await first).status, 201);
});

test("non-success creation responses release the claim for retry", async () => {
  let calls = 0;
  const fixture = handlers({
    service: service({
      createSkill: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1 ? { kind: "conflict" } : { kind: "created", skill }
        );
      },
    }),
  });
  const create = () =>
    fixture.handlers.createSkill(
      new Request("https://app.test/api/skills", {
        body: skillBody(),
        method: "POST",
      })
    );

  const failed = await create();
  const retried = await create();

  assert.equal(failed.status, 409);
  assert.equal(await errorCode(failed), "resource_conflict");
  assert.equal(retried.status, 201);
  assert.equal(fixture.serviceRequests(), 2);
  assert.equal(calls, 2);
});

test("corrupted replayed creation payloads fail instead of becoming success", async () => {
  const corruptStore: IdempotencyStore = {
    claim: (_input) =>
      Promise.resolve({
        kind: "completed",
        response: {
          envelope: {
            body: { skill: { id: "corrupt" } },
            kind: "plain_json",
          },
          status: 201,
        },
      }),
    cleanupExpired: () => Promise.resolve(),
    complete: () => Promise.reject(new Error("unexpected completion")),
    release: () => Promise.reject(new Error("unexpected release")),
  };
  const fixture = handlers({ idempotencyStore: corruptStore });

  await assert.rejects(
    fixture.handlers.createSkill(
      new Request("https://app.test/api/skills", {
        body: skillBody(),
        method: "POST",
      })
    )
  );
  assert.equal(fixture.serviceRequests(), 0);
});

test("DELETE accepts only its strict query version and an empty bounded body", async () => {
  const fixture = handlers();
  const request = new Request(
    `https://app.test/api/skills/${SKILL_ID}?expectedVersion=2`,
    {
      body: "{}",
      method: "DELETE",
    }
  );

  const response = await fixture.handlers.deleteSkill(request, SKILL_ID);

  assert.equal(response.status, 413);
  assert.equal(await errorCode(response), "body_too_large");
  assert.equal(fixture.serviceRequests(), 0);
});

test("skill and team handlers support list, get, create, update, and query-versioned delete", async () => {
  const fixture = handlers();

  const responses = {
    createSkill: await fixture.handlers.createSkill(
      new Request("https://app.test/api/skills", {
        body: skillBody(),
        method: "POST",
      })
    ),
    createTeam: await fixture.handlers.createTeam(
      new Request("https://app.test/api/teams", {
        body: teamBody(),
        method: "POST",
      })
    ),
    deleteSkill: await fixture.handlers.deleteSkill(
      new Request(`https://app.test/api/skills/${SKILL_ID}?expectedVersion=2`, {
        method: "DELETE",
      }),
      SKILL_ID
    ),
    deleteTeam: await fixture.handlers.deleteTeam(
      new Request(`https://app.test/api/teams/${TEAM_ID}?expectedVersion=3`, {
        method: "DELETE",
      }),
      TEAM_ID
    ),
    getSkill: await fixture.handlers.getSkill(
      new Request(`https://app.test/api/skills/${SKILL_ID}`),
      SKILL_ID
    ),
    getTeam: await fixture.handlers.getTeam(
      new Request(`https://app.test/api/teams/${TEAM_ID}`),
      TEAM_ID
    ),
    listSkills: await fixture.handlers.listSkills(
      new Request("https://app.test/api/skills")
    ),
    listTeams: await fixture.handlers.listTeams(
      new Request("https://app.test/api/teams")
    ),
    updateSkill: await fixture.handlers.updateSkill(
      new Request(`https://app.test/api/skills/${SKILL_ID}`, {
        body: skillBody({ expectedVersion: 2, name: "Updated" }),
        method: "PUT",
      }),
      SKILL_ID
    ),
    updateTeam: await fixture.handlers.updateTeam(
      new Request(`https://app.test/api/teams/${TEAM_ID}`, {
        body: teamBody({ expectedVersion: 3, name: "Updated" }),
        method: "PUT",
      }),
      TEAM_ID
    ),
  };

  assert.equal(responses.createSkill.status, 201);
  skillEnvelopeSchema.parse(await responses.createSkill.json());
  assert.equal(responses.createTeam.status, 201);
  teamEnvelopeSchema.parse(await responses.createTeam.json());
  assert.equal(responses.deleteSkill.status, 200);
  okEnvelopeSchema.parse(await responses.deleteSkill.json());
  assert.equal(responses.deleteTeam.status, 200);
  okEnvelopeSchema.parse(await responses.deleteTeam.json());
  skillEnvelopeSchema.parse(await responses.getSkill.json());
  teamEnvelopeSchema.parse(await responses.getTeam.json());
  skillsEnvelopeSchema.parse(await responses.listSkills.json());
  teamsEnvelopeSchema.parse(await responses.listTeams.json());
  assert.equal(
    skillEnvelopeSchema.parse(await responses.updateSkill.json()).skill.name,
    "Updated"
  );
  const updatedTeam = teamEnvelopeSchema.parse(
    await responses.updateTeam.json()
  ).team;
  assert.equal(updatedTeam.name, "Updated");
  assert.deepEqual(
    updatedTeam.members.map(({ agentId }) => agentId),
    [AGENT_A, AGENT_B]
  );
  for (const response of Object.values(responses)) {
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("conflicts, stale versions, missing references, invalid IDs, and tenant isolation map safely", async () => {
  const cases: Array<{
    code: string;
    invoke: (handlers: TeamHttpHandlers) => Promise<Response>;
    service: Partial<TeamService>;
    status: number;
  }> = [
    {
      code: "resource_conflict",
      invoke: (api) =>
        api.createSkill(
          new Request("https://app.test/api/skills", {
            body: skillBody(),
            method: "POST",
          })
        ),
      service: { createSkill: async () => ({ kind: "conflict" }) },
      status: 409,
    },
    {
      code: "stale_version",
      invoke: (api) =>
        api.updateSkill(
          new Request(`https://app.test/api/skills/${SKILL_ID}`, {
            body: skillBody({ expectedVersion: 2 }),
            method: "PUT",
          }),
          SKILL_ID
        ),
      service: { updateSkill: async () => ({ kind: "stale_version" }) },
      status: 409,
    },
    {
      code: "resource_in_use",
      invoke: (api) =>
        api.deleteSkill(
          new Request(
            `https://app.test/api/skills/${SKILL_ID}?expectedVersion=2`,
            { method: "DELETE" }
          ),
          SKILL_ID
        ),
      service: { deleteSkill: async () => ({ kind: "conflict" }) },
      status: 409,
    },
    {
      code: "not_found",
      invoke: (api) =>
        api.createTeam(
          new Request("https://app.test/api/teams", {
            body: teamBody(),
            method: "POST",
          })
        ),
      service: { createTeam: async () => ({ kind: "not_found" }) },
      status: 404,
    },
    {
      code: "not_found",
      invoke: (api) =>
        api.getTeam(
          new Request(`https://app.test/api/teams/${TEAM_ID}`),
          TEAM_ID
        ),
      service: { getTeam: async () => ({ kind: "not_found" }) },
      status: 404,
    },
  ];

  await Promise.all(
    cases.map(async (testCase) => {
      const response = await testCase.invoke(
        handlers({ service: service(testCase.service) }).handlers
      );
      assert.equal(response.status, testCase.status);
      assert.equal(await errorCode(response), testCase.code);
    })
  );

  const invalidFixture = handlers();
  const invalidId = await invalidFixture.handlers.getSkill(
    new Request("https://app.test/api/skills/not-an-id"),
    "not-an-id"
  );
  const invalidDelete = await invalidFixture.handlers.deleteTeam(
    new Request(`https://app.test/api/teams/${TEAM_ID}`, {
      method: "DELETE",
    }),
    TEAM_ID
  );
  assert.equal(invalidId.status, 400);
  assert.equal(await errorCode(invalidId), "invalid_request");
  assert.equal(invalidDelete.status, 400);
  assert.equal(await errorCode(invalidDelete), "invalid_request");
  assert.equal(invalidFixture.serviceRequests(), 0);
});

test("abuse requests use authenticated user or tenant scopes for each explicit route", async () => {
  const fixture = handlers();
  await fixture.handlers.listSkills(new Request("https://app.test/api/skills"));
  await fixture.handlers.createSkill(
    new Request("https://app.test/api/skills", {
      body: skillBody(),
      method: "POST",
    })
  );
  await fixture.handlers.deleteSkill(
    new Request(`https://app.test/api/skills/${SKILL_ID}?expectedVersion=2`, {
      method: "DELETE",
    }),
    SKILL_ID
  );
  await fixture.handlers.listTeams(new Request("https://app.test/api/teams"));
  await fixture.handlers.createTeam(
    new Request("https://app.test/api/teams", {
      body: teamBody(),
      method: "POST",
    })
  );
  await fixture.handlers.deleteTeam(
    new Request(`https://app.test/api/teams/${TEAM_ID}?expectedVersion=3`, {
      method: "DELETE",
    }),
    TEAM_ID
  );
  await fixture.handlers.listTeamRuns(
    new Request(`https://app.test/api/teams/${TEAM_ID}/runs`),
    TEAM_ID
  );
  await fixture.handlers.createTeamRun(
    new Request(`https://app.test/api/teams/${TEAM_ID}/runs`, {
      body: teamRunBody(),
      headers: { "idempotency-key": "team-http-test-key-0004" },
      method: "POST",
    }),
    TEAM_ID
  );
  await fixture.handlers.getTeamRun(
    new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}`),
    TEAM_RUN_ID
  );
  await fixture.handlers.stopTeamRun(
    new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}/stop`, {
      body: JSON.stringify({ expectedVersion: 3 }),
      method: "POST",
    }),
    TEAM_RUN_ID
  );
  await fixture.handlers.approveTeamRun(
    new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}/approve`, {
      body: JSON.stringify({
        capabilities: ["github.pull_requests.write"],
        decision: "approve",
        expectedVersion: 2,
      }),
      method: "POST",
    }),
    TEAM_RUN_ID
  );

  assert.deepEqual(
    fixture.admissions.map(({ route, tenant, userId }) => ({
      route,
      tenant,
      userId,
    })),
    [
      { route: "skill_read", tenant: TENANT, userId: USER_ID },
      { route: "skill_write", tenant: TENANT, userId: USER_ID },
      { route: "skill_delete", tenant: TENANT, userId: USER_ID },
      { route: "team_read", tenant: TENANT, userId: USER_ID },
      { route: "team_write", tenant: TENANT, userId: USER_ID },
      { route: "team_delete", tenant: TENANT, userId: USER_ID },
      { route: "team_run_read", tenant: TENANT, userId: USER_ID },
      { route: "team_run_start", tenant: TENANT, userId: USER_ID },
      { route: "team_run_read", tenant: TENANT, userId: USER_ID },
      { route: "team_run_stop", tenant: TENANT, userId: USER_ID },
      { route: "team_run_approve", tenant: TENANT, userId: USER_ID },
    ]
  );
});

test("unexpected service failures are not broadly caught or serialized", async () => {
  const fixture = handlers({
    service: service({
      listSkills: () =>
        Promise.reject(new Error("postgres://secret@private-host/internal")),
    }),
  });

  await assert.rejects(
    fixture.handlers.listSkills(new Request("https://app.test/api/skills")),
    /private-host/u
  );
});

const verbs = ["DELETE", "GET", "PATCH", "POST", "PUT"] as const;

function exportedVerbs(module: Record<string, unknown>): string[] {
  return verbs.filter((verb) => typeof module[verb] === "function");
}

test("production route dependencies keep authentication and database access lazy", () => {
  const source = readFileSync(
    new URL("./route-dependencies.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(source, /from\s+["']@\/lib\/db\/access["']/u);
  assert.doesNotMatch(source, /from\s+["']@\/lib\/db\/queries["']/u);
  assert.doesNotMatch(source, /from\s+["']@\/app\/\(auth\)\/auth["']/u);
  assert.match(source, /import\(["']@\/lib\/db\/access["']\)/u);
  assert.match(source, /import\(["']@\/lib\/db\/queries["']\)/u);
  assert.match(source, /import\(["']@\/app\/\(auth\)\/auth["']\)/u);
  assert.match(
    source,
    /appOrigin:\s*\(\)\s*=>\s*configuredApplicationOrigin\(process\.env\)/u
  );
});

async function executeRouteFixture(): Promise<void> {
  const api = handlers().handlers;
  await mock.module("@/lib/teams/route-dependencies", {
    namedExports: {
      productionTeamHttpHandlers: () => api,
    },
  });
  const [
    skills,
    skillRoute,
    teams,
    teamRoute,
    teamRuns,
    teamRunRoute,
    teamRunStop,
    teamRunApprove,
  ] = await Promise.all([
    import("../../app/api/skills/route"),
    import("../../app/api/skills/[id]/route"),
    import("../../app/api/teams/route"),
    import("../../app/api/teams/[id]/route"),
    import("../../app/api/teams/[id]/runs/route"),
    import("../../app/api/team-runs/[id]/route"),
    import("../../app/api/team-runs/[id]/stop/route"),
    import("../../app/api/team-runs/[id]/approve/route"),
  ]);

  for (const route of [
    skills,
    skillRoute,
    teams,
    teamRoute,
    teamRuns,
    teamRunRoute,
    teamRunStop,
    teamRunApprove,
  ]) {
    assert.equal("runtime" in route, false);
    assert.equal("dynamic" in route, false);
    assert.equal(route.maxDuration, 300);
  }
  assert.deepEqual(exportedVerbs(skills), ["GET", "POST"]);
  assert.deepEqual(exportedVerbs(skillRoute), ["DELETE", "GET", "PUT"]);
  assert.deepEqual(exportedVerbs(teams), ["GET", "POST"]);
  assert.deepEqual(exportedVerbs(teamRoute), ["DELETE", "GET", "PUT"]);
  assert.deepEqual(exportedVerbs(teamRuns), ["GET", "POST"]);
  assert.deepEqual(exportedVerbs(teamRunRoute), ["GET"]);
  assert.deepEqual(exportedVerbs(teamRunStop), ["POST"]);
  assert.deepEqual(exportedVerbs(teamRunApprove), ["POST"]);

  assert.equal(
    (await skills.GET(new Request("https://app.test/api/skills"))).status,
    200
  );
  assert.equal(
    (
      await skillRoute.GET(
        new Request(`https://app.test/api/skills/${SKILL_ID}`),
        { params: Promise.resolve({ id: SKILL_ID }) }
      )
    ).status,
    200
  );
  assert.equal(
    (
      await teamRuns.GET(
        new Request(`https://app.test/api/teams/${TEAM_ID}/runs`),
        { params: Promise.resolve({ id: TEAM_ID }) }
      )
    ).status,
    200
  );
  assert.equal(
    (
      await teamRunRoute.GET(
        new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}`),
        { params: Promise.resolve({ id: TEAM_RUN_ID }) }
      )
    ).status,
    200
  );
  assert.equal(
    (await teams.GET(new Request("https://app.test/api/teams"))).status,
    200
  );
  assert.equal(
    (
      await teamRoute.GET(
        new Request(`https://app.test/api/teams/${TEAM_ID}`),
        { params: Promise.resolve({ id: TEAM_ID }) }
      )
    ).status,
    200
  );
  process.stdout.write(JSON.stringify({ ok: true }));
}

if (fixtureMode) {
  executeRouteFixture().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exitCode = 1;
  });
} else {
  test("actual team route modules are thin dynamic Node handlers", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-test-module-mocks",
        "--conditions=react-server",
        "--import",
        "tsx",
        fileURLToPath(import.meta.url),
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, TEAM_ROUTES_FIXTURE: "1" },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.startsWith('{"ok":true}'), true, result.stdout);
  });
}

if (!fixtureMode) {
  function missionRequest(body: unknown = {}): Request {
    return new Request(`https://app.test/api/teams/${TEAM_ID}/mission`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  }

  test("a drafted mission is generated from the team's own roster", async () => {
    const seen: unknown[] = [];
    const fixture = handlers({
      draftMission: async (input) => {
        seen.push(input);
        return "  Ship the fix and return a passing check.  ";
      },
    });

    const response = await fixture.handlers.draftTeamMission(
      missionRequest({ hint: "  the flaky login test  " }),
      TEAM_ID
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mission: "Ship the fix and return a passing check.",
    });
    // The generator receives the roster, never the raw team record.
    assert.deepEqual(seen, [
      {
        description: team.description,
        hint: "the flaky login test",
        members: team.members.map((member) => ({
          required: member.required,
          responsibility: member.responsibility,
        })),
        name: team.name,
      },
    ]);
    assert.deepEqual(
      fixture.admissions.map((admission) => admission.route),
      ["team_mission_draft"]
    );
  });

  test("drafting reports unavailable when no generator is configured", async () => {
    const fixture = handlers();

    const response = await fixture.handlers.draftTeamMission(
      missionRequest(),
      TEAM_ID
    );

    assert.equal(response.status, 503);
    // A generator failure is reported the same way, so a provider outage never
    // reaches the console as a model or gateway error.
    const failing = handlers({
      draftMission: async () => {
        throw new Error("gateway exploded with a key in the message");
      },
    });
    const failed = await failing.handlers.draftTeamMission(
      missionRequest(),
      TEAM_ID
    );
    assert.equal(failed.status, 503);
    assert.doesNotMatch(await failed.text(), /gateway|key/i);
  });

  test("drafting refuses an unknown team and an unusable draft", async () => {
    const missing = handlers({
      draftMission: async () => "unused",
      service: service({ getTeam: async () => ({ kind: "not_found" }) }),
    });
    assert.equal(
      (await missing.handlers.draftTeamMission(missionRequest(), TEAM_ID))
        .status,
      404
    );

    const blank = handlers({ draftMission: async () => "   " });
    assert.equal(
      (await blank.handlers.draftTeamMission(missionRequest(), TEAM_ID)).status,
      503
    );
  });

  test("reading a live team run schedules the pass that advances it", async () => {
    const live = handlers();
    await live.handlers.getTeamRun(
      new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}`),
      TEAM_RUN_ID
    );
    assert.equal(live.events.includes("after"), true);

    // A finished run has nothing to advance, so reading it schedules nothing.
    const settled = handlers({
      service: service({
        getRun: async () => ({
          kind: "found",
          teamRun: { ...teamRun, status: "completed" },
        }),
      }),
    });
    await settled.handlers.getTeamRun(
      new Request(`https://app.test/api/team-runs/${TEAM_RUN_ID}`),
      TEAM_RUN_ID
    );
    assert.equal(settled.events.includes("after"), false);
  });
}
