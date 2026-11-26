import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DaytonaNotFoundError } from "@daytona/sdk";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { drizzleRunnerCredentialDependencies } from "@/lib/credentials/runner-credential";
import {
  admissionLimitsFromEnvironment,
  dispatchRunnerClaim,
} from "./admission";
import { configuredDaytonaRunnerExecutor } from "./daytona/executor";
import { hermeticRunnerDispatchDependencies } from "./hermetic/composition";
import {
  HERMETIC_EXECUTION_PROVENANCE,
  hermeticSandboxId,
} from "./hermetic/executor";
import { createRunnerService } from "./service";
import { createRunnerStore, drizzleRunnerStoreDatabase } from "./store";
import type { RunnerDispatchAuthority, RunnerOperator } from "./types";

const databaseUrl = process.env.RUN_SANDBOX_BINDING_POSTGRES_TEST_URL;
if (process.env.RUN_SANDBOX_BINDING_POSTGRES_TEST_REQUIRED === "1") {
  assert.ok(
    databaseUrl,
    "A disposable PostgreSQL URL is required for binding tests."
  );
}

test("PostgreSQL rejects partial or invalid run bindings and preserves valid bound and unbound rows", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const agentId = randomUUID();
  const tenant = "binding_postgres_fixture";
  const insert = (sandboxId: string | null, generation: number | null) => sql`
    INSERT INTO "RunnerRun" (
      "id", "agentId", "tenant", "agentInstructions", "agentModel",
      "agentRuntime", "operationId", "requestHash", "task",
      "boundSandboxId", "boundSandboxGeneration"
    ) VALUES (
      ${randomUUID()}, ${agentId}, ${tenant}, 'Binding fixture', 'auto',
      'copilot', ${randomUUID()}, ${"a".repeat(64)}, 'Verify binding',
      ${sandboxId}, ${generation}
    ) RETURNING "boundSandboxId", "boundSandboxGeneration"`;
  try {
    await sql`INSERT INTO "RunnerAgent" (
      "id", "tenant", "instructions", "model", "name", "runtime"
    ) VALUES (${agentId}, ${tenant}, 'Binding fixture', 'auto', 'Binding fixture', 'copilot')`;
    await assert.rejects(() => insert("sandbox-fixture", null), {
      code: "23514",
      constraint_name: "RunnerRun_sandboxBinding_valid",
    });
    await assert.rejects(() => insert(null, 3), {
      code: "23514",
      constraint_name: "RunnerRun_sandboxBinding_valid",
    });
    await assert.rejects(() => insert("", 3), {
      code: "23514",
      constraint_name: "RunnerRun_sandboxBinding_valid",
    });
    await assert.rejects(() => insert("sandbox-fixture", -1), {
      code: "23514",
      constraint_name: "RunnerRun_sandboxBinding_valid",
    });
    const [bound] = await insert("sandbox-fixture", 0);
    const [unbound] = await insert(null, null);
    assert.deepEqual(bound, {
      boundSandboxGeneration: 0,
      boundSandboxId: "sandbox-fixture",
    });
    assert.deepEqual(unbound, {
      boundSandboxGeneration: null,
      boundSandboxId: null,
    });
    await assert.rejects(
      () =>
        sql`UPDATE "RunnerRun" SET "boundSandboxGeneration" = NULL WHERE "agentId" = ${agentId} AND "boundSandboxId" IS NOT NULL`,
      { code: "23514", constraint_name: "RunnerRun_sandboxBinding_valid" }
    );
    await assert.rejects(
      () =>
        sql`UPDATE "RunnerRun" SET "boundSandboxId" = NULL WHERE "agentId" = ${agentId} AND "boundSandboxId" IS NOT NULL`,
      { code: "23514", constraint_name: "RunnerRun_sandboxBinding_valid" }
    );
  } finally {
    await sql`DELETE FROM "RunnerRun" WHERE "agentId" = ${agentId}`;
    await sql`DELETE FROM "RunnerAgent" WHERE "id" = ${agentId}`;
    await sql.end();
  }
});

test("a cross-tenant bound start inserts no run and a provider refusal issues no credential lease", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const store = createRunnerStore(drizzleRunnerStoreDatabase(drizzle(sql)));
  const operator: RunnerOperator = { kind: "runner-operator" };
  const tenant = "binding_dispatch_fixture";
  const agentId = randomUUID();
  const runId = randomUUID();
  const operationId = randomUUID();
  const sandboxId = "sandbox-dispatch-fixture";
  const leaseToken = randomUUID();
  const binding = { expectedGeneration: 3, expectedSandboxId: sandboxId };
  const authority = {
    expectedVersion: 0,
    leaseToken,
    runId,
  } as RunnerDispatchAuthority;
  const calls: string[] = [];
  try {
    await sql`INSERT INTO "RunnerAgent" (
      "id", "tenant", "instructions", "model", "name", "runtime",
      "daytonaSandboxId", "sandboxGeneration", "sandboxLifecycle"
    ) VALUES (${agentId}, ${tenant}, 'Binding fixture', 'auto', 'Binding fixture',
      'copilot', ${sandboxId}, 3, 'ready')`;
    assert.deepEqual(
      await store.startRun(
        {
          kind: "subscriber",
          tenant: "different_binding_tenant",
          userId: randomUUID(),
        },
        {
          agentId,
          authVersion: 1,
          id: runId,
          operationId,
          requestHash: "a".repeat(64),
          sandboxBinding: binding,
          task: "Verify binding",
        }
      ),
      { kind: "not_found" }
    );
    assert.deepEqual(
      [...(await sql`SELECT id FROM "RunnerRun" WHERE "agentId" = ${agentId}`)],
      []
    );

    await sql`INSERT INTO "RunnerRun" (
      "id", "agentId", "tenant", "agentInstructions", "agentModel",
      "agentRuntime", "operationId", "requestHash", "task",
      "boundSandboxId", "boundSandboxGeneration", "dispatchState",
      "dispatchLeaseToken", "dispatchLeaseExpiresAt"
    ) VALUES (
      ${runId}, ${agentId}, ${tenant}, 'Binding fixture', 'auto',
      'copilot', ${operationId}, ${"a".repeat(64)}, 'Verify binding',
      ${sandboxId}, 3, 'dispatching', ${leaseToken}, now() + interval '5 minutes'
    )`;
    const claim = await store.getDispatchAgent(operator, authority);
    assert.equal(claim.kind, "found");
    const executor = configuredDaytonaRunnerExecutor({
      operator,
      sandboxConfiguration: {
        autoArchiveInterval: 10_080,
        autoDeleteInterval: -1,
        autoStopInterval: 15,
        resources: { cpu: 2, disk: 10, memory: 4 },
        snapshotName: "coven-agents-copilot-2",
        target: "us",
        ttlMinutes: 0,
      },
      sandboxDependencies: {
        daytona: {
          create: () => {
            throw new Error("Unexpected sandbox creation");
          },
          get: (id) => {
            calls.push(id);
            return Promise.reject(
              new DaytonaNotFoundError("fixture sandbox absent")
            );
          },
        },
      },
      store,
    });
    const result = await dispatchRunnerClaim(
      { authority, run: claim.run },
      {
        acquireCredential: () => {
          throw new Error("Unexpected credential acquisition");
        },
        credentialInput: () => {
          throw new Error("Unexpected credential input");
        },
        executor,
        limits: admissionLimitsFromEnvironment({}),
        operator,
        store,
      }
    );
    assert.deepEqual(result, {
      kind: "refused",
      reason: "sandbox_binding",
      runId,
    });
    assert.deepEqual(calls, [sandboxId]);
    const [run] = await sql`SELECT "status", "error", "daytonaAttemptId"
      FROM "RunnerRun" WHERE "id" = ${runId}`;
    assert.equal(run?.status, "failed");
    assert.equal(run?.error?.code, "sandbox_binding_refused");
    assert.equal(run?.error?.details, "provider_not_found");
    assert.equal(run?.error?.retryable, false);
    assert.equal(run?.daytonaAttemptId, null);
    assert.deepEqual(
      [
        ...(await sql`SELECT "runId" FROM "CredentialLease" WHERE "runId" = ${runId}`),
      ],
      []
    );
  } finally {
    try {
      await sql`DELETE FROM "CredentialLease" WHERE "runId" = ${runId}`;
      await sql`DELETE FROM "RunnerRun" WHERE "id" = ${runId}`;
      await sql`DELETE FROM "RunnerAgent" WHERE "id" = ${agentId}`;
    } finally {
      await sql.end();
    }
  }
});

test("distinct concurrent bound starts admit one run and preserve operation replay", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const clients = [
    postgres(databaseUrl, { max: 1 }),
    postgres(databaseUrl, { max: 1 }),
  ];
  const [sql] = clients;
  const agentId = randomUUID();
  const principal = {
    kind: "subscriber" as const,
    tenant: `exclusive_${agentId.slice(0, 8)}`,
    userId: randomUUID(),
  };
  const services = clients.map((client) =>
    createRunnerService({
      store: createRunnerStore(drizzleRunnerStoreDatabase(drizzle(client))),
    })
  );
  const sandboxId = hermeticSandboxId(principal.tenant, agentId);
  const operations = [randomUUID(), randomUUID()];
  const payload = (operationId: string) => ({
    operationId,
    sandboxBinding: { expectedGeneration: 1, expectedSandboxId: sandboxId },
    task: "Inspect fixture",
  });
  try {
    await sql`INSERT INTO "RunnerAgent" ("id","tenant","instructions","model","name","runtime","daytonaSandboxId","sandboxGeneration","sandboxLifecycle") VALUES (${agentId},${principal.tenant},'Inspect','auto','fixture','copilot',${sandboxId},1,'ready')`;
    const pids = await Promise.all(
      clients.map((client) => client`SELECT pg_backend_pid() AS pid`)
    );
    assert.notEqual(pids[0][0].pid, pids[1][0].pid);
    const starts = await Promise.all(
      services.map((service, i) =>
        service.startRun(principal, 1, agentId, payload(operations[i]))
      )
    );
    const [count] =
      await sql`SELECT count(*)::int AS n FROM "RunnerRun" WHERE "agentId"=${agentId}`;
    assert.deepEqual(
      { persisted: count.n, states: starts.map((s) => s.kind).sort() },
      { persisted: 1, states: ["accepted", "refused"] }
    );
    const winnerIndex = starts.findIndex((r) => r.kind === "accepted");
    const winner = starts[winnerIndex];
    assert.equal(winner.kind, "accepted");
    assert.equal(winner.run.status, "queued");
    assert.equal(Object.hasOwn(winner.run, "attemptRef"), false);
    assert.deepEqual(starts[1 - winnerIndex], {
      code: "sandbox_binding_refused",
      kind: "refused",
      reason: "fence_outstanding",
      retryable: false,
    });
    const replay = await services[0].startRun(
      principal,
      1,
      agentId,
      payload(operations[winnerIndex])
    );
    assert.equal(replay.kind, "accepted");
    assert.equal(replay.admission, "duplicate");
    assert.deepEqual(replay.run, winner.run);
    const database = drizzle(sql);
    const store = createRunnerStore(drizzleRunnerStoreDatabase(database));
    const operator = { kind: "runner-operator" as const };
    const claim = await store.claimNextDispatch(operator, {
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: randomUUID(),
    });
    assert.ok(claim);
    assert.equal(claim.run.id, winner.run.id);
    const deps = hermeticRunnerDispatchDependencies({
      credentialDependencies: {
        ...drizzleRunnerCredentialDependencies(database),
        prepareCredential: async () => true,
        readCredential: async () => "offline-fixture",
      },
      credentialInput: (run) => ({
        globalDailyCap: 500,
        harnessId: run.agentRuntime,
        keySecret: "fixture-only",
        operationId: run.operationId,
        periodStart: new Date(
          `${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`
        ),
        runId: run.id,
        tenant: run.tenant,
      }),
      limits: admissionLimitsFromEnvironment({}),
      operator,
      store,
    });
    const startsAtExecutor: string[] = [];
    const result = await dispatchRunnerClaim(claim, {
      ...deps,
      executor: {
        ...deps.executor,
        start: (input) => {
          startsAtExecutor.push(input.runId);
          return deps.executor.start(input);
        },
      },
    });
    assert.equal(result.kind, "started", JSON.stringify(result));
    assert.deepEqual(startsAtExecutor, [winner.run.id]);
    const leases =
      await sql`SELECT "runId" FROM "CredentialLease" WHERE "tenantHash"=(SELECT "tenantHash" FROM "CredentialLease" WHERE "runId"=${winner.run.id})`;
    assert.deepEqual(
      leases.map((row) => row.runId),
      [winner.run.id]
    );
    assert.deepEqual(
      await services[0].startRun(principal, 1, agentId, payload(randomUUID())),
      starts[1 - winnerIndex]
    );
  } finally {
    await sql`DELETE FROM "RunnerRun" WHERE "agentId"=${agentId}`;
    await sql`DELETE FROM "RunnerAgent" WHERE "id"=${agentId}`;
    await Promise.all(clients.map((client) => client.end()));
  }
});

test("the authorized read retains the current attempt across replay and cleanup", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const sql = postgres(databaseUrl, { max: 1 });
  const store = createRunnerStore(drizzleRunnerStoreDatabase(drizzle(sql)));
  const service = createRunnerService({ store });
  const principal = {
    kind: "subscriber" as const,
    tenant: "attempt_read_fixture",
    userId: randomUUID(),
  };
  const operator = { kind: "runner-operator" as const };
  const agentId = randomUUID();
  const payload = {
    operationId: randomUUID(),
    sandboxBinding: {
      expectedGeneration: 1,
      expectedSandboxId: "sandbox-fixture",
    },
    task: "Inspect",
  };
  try {
    await sql`INSERT INTO "RunnerAgent" ("id","tenant","instructions","model","name","runtime","daytonaSandboxId","sandboxGeneration","sandboxLifecycle") VALUES (${agentId},${principal.tenant},'Inspect','auto','fixture','copilot','sandbox-fixture',1,'ready')`;
    const accepted = await service.startRun(principal, 1, agentId, payload);
    assert.equal(accepted.kind, "accepted");
    const { id } = accepted.run;
    const read = async () => {
      const result = await service.getRun(principal, id);
      assert.equal(result.kind, "found");
      return result.run;
    };
    assert.equal((await read()).attemptRef, undefined);
    const claim = await store.claimNextDispatch(operator, {
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leaseToken: randomUUID(),
    });
    assert.ok(claim);
    const prepare = { executionProvenance: HERMETIC_EXECUTION_PROVENANCE };
    const first = await store.authorizeDaytonaPreparation(
      operator,
      claim.authority,
      prepare
    );
    assert.equal(first.kind, "authorized");
    const current = (await read()).attemptRef;
    assert.equal(
      typeof current,
      "string",
      "a server-authorized attempt needs an opaque reference"
    );
    assert.notEqual(current, first.attemptId);
    const released = await store.releaseDaytonaPreparation(
      operator,
      first.authority,
      { attemptId: first.attemptId }
    );
    assert.equal(released.kind, "released");
    const next = await store.authorizeDaytonaPreparation(
      operator,
      released.authority,
      prepare
    );
    assert.equal(next.kind, "authorized");
    const ref = (await read()).attemptRef;
    assert.notEqual(ref, current);
    assert.notEqual(ref, next.attemptId);
    const duplicate = await service.startRun(principal, 1, agentId, payload);
    assert.equal(duplicate.kind, "accepted");
    assert.equal(duplicate.admission, "duplicate");
    assert.equal(duplicate.run.id, id);
    assert.equal(duplicate.run.attemptRef, ref);
    assert.equal(
      (await service.getRun({ ...principal, tenant: "other_tenant" }, id)).kind,
      "not_found"
    );
    // Stage the terminal state while retaining its lease for the real cleanup transition.
    await sql`UPDATE "RunnerRun" SET "status"='completed',"dispatchState"='terminal',"completedAt"=now() WHERE id=${id}`;
    const nextStart = () =>
      service.startRun(principal, 1, agentId, {
        ...payload,
        operationId: randomUUID(),
      });
    assert.equal((await nextStart()).kind, "refused");
    const terminal = await store.releaseTerminalDaytonaAttempt(
      operator,
      next.authority,
      { attemptId: next.attemptId }
    );
    assert.equal(terminal.kind, "released");
    assert.equal((await read()).attemptRef, ref);
    assert.equal((await nextStart()).kind, "accepted");
  } finally {
    await sql`DELETE FROM "RunnerRun" WHERE "agentId"=${agentId}`;
    await sql`DELETE FROM "RunnerAgent" WHERE "id"=${agentId}`;
    await sql.end();
  }
});

test("separate agents admit bound runs concurrently and unbound operations can queue", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const sql = postgres(databaseUrl, { max: 2 });
  const agentIds = [randomUUID(), randomUUID(), randomUUID()];
  const principal = {
    kind: "subscriber" as const,
    tenant: "independent_fixture",
    userId: randomUUID(),
  };
  const service = createRunnerService({
    store: createRunnerStore(drizzleRunnerStoreDatabase(drizzle(sql))),
  });
  try {
    await Promise.all(
      agentIds.map(
        (id) =>
          sql`INSERT INTO "RunnerAgent" ("id","tenant","instructions","model","name","runtime","daytonaSandboxId","sandboxGeneration","sandboxLifecycle") VALUES (${id},${principal.tenant},'Inspect','auto','fixture','copilot','sandbox-fixture',1,'ready')`
      )
    );
    const start = (id: string, bound: boolean) =>
      service.startRun(principal, 1, id, {
        operationId: randomUUID(),
        task: "Inspect",
        ...(bound
          ? {
              sandboxBinding: {
                expectedGeneration: 1,
                expectedSandboxId: "sandbox-fixture",
              },
            }
          : {}),
      });
    const results = await Promise.all([
      start(agentIds[0], true),
      start(agentIds[1], true),
      start(agentIds[2], false),
      start(agentIds[2], false),
    ]);
    assert.deepEqual(
      results.map((result) => result.kind),
      new Array(4).fill("accepted")
    );
  } finally {
    await sql`DELETE FROM "RunnerRun" WHERE "agentId" IN ${sql(agentIds)}`;
    await sql`DELETE FROM "RunnerAgent" WHERE id IN ${sql(agentIds)}`;
    await sql.end();
  }
});

test("pilot admission counts distinct accepted starts across tenants under contention and survives deletion", {
  skip: !databaseUrl,
}, async () => {
  assert.ok(databaseUrl);
  const sql = postgres(databaseUrl, { max: 8, onnotice: () => undefined });
  const store = createRunnerStore(drizzleRunnerStoreDatabase(drizzle(sql)));
  const endsAt = new Date(Date.now() + 3_600_000).toISOString();
  const oldMode = process.env.BETA_CAMPAIGN_ENABLED;
  const oldDeadline = process.env.BETA_CAMPAIGN_ENDS_AT;
  process.env.BETA_CAMPAIGN_ENABLED = "invite-only";
  process.env.BETA_CAMPAIGN_ENDS_AT = endsAt;
  const ids = [randomUUID(), randomUUID()];
  const start = (index: number, operationId: string) =>
    store.startRun(
      {
        kind: "subscriber",
        tenant: `pilot_${index}`,
        userId: ids[index],
      },
      {
        agentId: ids[index],
        authVersion: 1,
        id: randomUUID(),
        operationId,
        requestHash: "a".repeat(64),
        task: "Inspect",
      }
    );
  try {
    await Promise.all(
      ids.map(
        (id, index) =>
          sql`INSERT INTO "RunnerAgent" ("id","tenant","instructions","model","name","runtime") VALUES (${id},${`pilot_${index}`},'Inspect','auto','pilot','copilot')`
      )
    );
    const replayId = randomUUID();
    const initial = await start(0, replayId);
    assert.equal(initial.kind, "created");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => start(i % 2, randomUUID()))
    );
    assert.equal(results.filter((r) => r.kind === "created").length, 3);
    assert.equal(results.filter((r) => r.kind === "refused").length, 5);
    assert.equal((await start(0, replayId)).kind, "duplicate");
    await sql`DELETE FROM "RunnerRun" WHERE "id"=${initial.run.id}`;
    assert.equal((await start(0, randomUUID())).kind, "refused");
    const [row] =
      await sql`SELECT admitted FROM "PilotAdmissionWindow" WHERE "endsAt"=${endsAt}`;
    assert.equal(row.admitted, 4);
  } finally {
    if (oldMode === undefined) {
      delete process.env.BETA_CAMPAIGN_ENABLED;
    } else {
      process.env.BETA_CAMPAIGN_ENABLED = oldMode;
    }
    if (oldDeadline === undefined) {
      delete process.env.BETA_CAMPAIGN_ENDS_AT;
    } else {
      process.env.BETA_CAMPAIGN_ENDS_AT = oldDeadline;
    }
    await sql`DELETE FROM "RunnerRun" WHERE "agentId" IN ${sql(ids)}`;
    await sql`DELETE FROM "RunnerAgent" WHERE "id" IN ${sql(ids)}`;
    await sql`DELETE FROM "PilotAdmissionWindow" WHERE "endsAt"=${endsAt}`;
    await sql.end();
  }
});
