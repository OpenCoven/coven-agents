import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { DaytonaNotFoundError } from "@daytona/sdk";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  admissionLimitsFromEnvironment,
  dispatchRunnerClaim,
} from "./admission";
import { configuredDaytonaRunnerExecutor } from "./daytona/executor";
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
