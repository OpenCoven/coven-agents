import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  admissionLimitsFromEnvironment,
  admitRunnerRun,
  dispatchRunnerClaim,
} from "../runner/admission";
import { hashRunRequest } from "../runner/evidence";
import { hermeticRunnerExecutor } from "../runner/hermetic/executor";
import { createRunnerService } from "../runner/service";
import { createRunnerStore, drizzleRunnerStoreDatabase } from "../runner/store";
import { tenantForUser } from "../session";

const url = process.env.RUN_SANDBOX_BINDING_POSTGRES_TEST_URL;

test("owner admission persists lock-selected read policy, replay conflict, and trust refusal in PostgreSQL", {
  skip: !url,
}, async () => {
  assert.ok(url);
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  const agentId = randomUUID();
  const userId = randomUUID();
  const principal = {
    kind: "subscriber",
    tenant: tenantForUser(userId),
    userId,
  } as const;
  const store = createRunnerStore(drizzleRunnerStoreDatabase(drizzle(sql)));
  let changePolicyOnLookup = true;
  const service = createRunnerService({
    createId: randomUUID,
    store: {
      ...store,
      getAgent: async (...args: Parameters<typeof store.getAgent>) => {
        const stale = await store.getAgent(...args);
        if (stale && changePolicyOnLookup) {
          changePolicyOnLookup = false;
          await sql`UPDATE "RunnerAgent" SET "ownerWorkspaceRead"=true WHERE id=${agentId}`;
        }
        return stale;
      },
    },
  });
  const operationId = randomUUID();
  try {
    await sql`INSERT INTO "RunnerAgent" (id,tenant,name,instructions,model,runtime,workspace,"ownerWorkspaceRead","sandboxTrust") VALUES (${agentId},${principal.tenant},'fixture','fixture','auto','copilot','/workspace',false,'restricted')`;
    const foreign = await service.startRun(
      { ...principal, tenant: "foreign_fixture" },
      1,
      agentId,
      { operationId, task: "Read only." }
    );
    assert.equal(foreign.kind, "not_found");
    const created = await service.startRun(principal, 1, agentId, {
      operationId,
      task: "Read only.",
    });
    assert.equal(created.kind, "accepted");
    if (created.kind !== "accepted") {
      return;
    }
    assert.equal(created.run.executionPermission, "workspace_read");
    assert.deepEqual(created.run.commandEvidence, []);
    const [persisted] =
      await sql`SELECT "executionPermission", "requestHash" FROM "RunnerRun" WHERE id=${created.run.id}`;
    assert.equal(persisted.executionPermission, "workspace_read");
    assert.equal(
      persisted.requestHash,
      hashRunRequest(agentId, "Read only.", "workspace_read", null)
    );
    await sql`UPDATE "RunnerAgent" SET "ownerWorkspaceRead"=false WHERE id=${agentId}`;
    const replay = await service.startRun(principal, 1, agentId, {
      operationId,
      task: "Read only.",
    });
    assert.deepEqual(replay, {
      code: "operation_conflict",
      kind: "refused",
      retryable: false,
    });
    await sql`DELETE FROM "RunnerRun" WHERE "agentId"=${agentId}`;
    await sql`UPDATE "RunnerAgent" SET "ownerWorkspaceRead"=true, "sandboxTrust"='unrestricted' WHERE id=${agentId}`;
    const trust = await service.startRun(principal, 1, agentId, {
      operationId: randomUUID(),
      task: "Read only.",
    });
    assert.deepEqual(trust, {
      code: "sandbox_trust_conflict",
      kind: "refused",
      retryable: false,
    });
    const [count] =
      await sql`SELECT count(*)::int AS count FROM "RunnerRun" WHERE "agentId"=${agentId}`;
    assert.equal(count.count, 0);
  } finally {
    await sql`DELETE FROM "RunnerRun" WHERE "agentId"=${agentId}`;
    await sql`DELETE FROM "RunnerAgent" WHERE id=${agentId}`;
    await sql.end();
  }
});

for (const runtime of ["codex", "claude"] as const) {
  test(`${runtime} owner-read admission persists policy and refuses dispatch before provider or credential effects`, {
    skip: !url,
  }, async () => {
    assert.ok(url);
    const sql = postgres(url, { max: 1, onnotice: () => undefined });
    const agentId = randomUUID();
    const userId = randomUUID();
    const principal = {
      kind: "subscriber",
      tenant: tenantForUser(userId),
      userId,
    } as const;
    const store = createRunnerStore(drizzleRunnerStoreDatabase(drizzle(sql)));
    const operator = { kind: "runner-operator" } as const;
    const limits = admissionLimitsFromEnvironment({
      RUN_ADMISSION_TENANT_QUEUE_MAX: "0",
    });
    const service = createRunnerService({
      admit: (input) => admitRunnerRun(input, { limits, store }),
      createId: randomUUID,
      store,
    });
    const effects: string[] = [];
    const forbidden = () => {
      effects.push("provider");
      assert.fail("unsupported read-only runtime reached provider");
    };
    try {
      await sql`INSERT INTO "RunnerAgent" (id,tenant,name,instructions,model,runtime,workspace,"ownerWorkspaceRead","sandboxTrust") VALUES (${agentId},${principal.tenant},'fixture','fixture','auto',${runtime},'/workspace',true,'restricted')`;
      const admitted = await service.startRun(principal, 1, agentId, {
        operationId: randomUUID(),
        task: "Inspect without mutations.",
      });
      assert.equal(admitted.kind, "accepted");
      if (admitted.kind !== "accepted" || admitted.admission !== "claimed") {
        assert.fail("fixture must claim its own admitted run atomically");
      }
      assert.equal(admitted.claimed.run.agentRuntime, runtime);
      assert.equal(admitted.claimed.run.executionPermission, "workspace_read");
      const result = await dispatchRunnerClaim(admitted.claimed, {
        acquireCredential: () => {
          effects.push("credential");
          assert.fail("must not acquire a credential");
        },
        credentialInput: () => assert.fail("must not build credential input"),
        executor: {
          ...hermeticRunnerExecutor({ operator, store }),
          ensureExecutionContext: forbidden,
          inspectNetworkSafety: forbidden,
          inspectWorkspaceSafety: forbidden,
          start: forbidden,
        },
        limits,
        operator,
        store,
      });
      assert.deepEqual(result, {
        kind: "refused",
        reason: "harness",
        runId: admitted.run.id,
      });
      assert.deepEqual(effects, []);
      const [row] =
        await sql`SELECT status, error, "executionPermission", "daytonaAttemptId", "attemptRef" FROM "RunnerRun" WHERE id=${admitted.run.id}`;
      assert.equal(row.status, "failed");
      assert.equal(row.error.code, "harness_unsupported");
      assert.equal(row.executionPermission, "workspace_read");
      assert.equal(row.daytonaAttemptId, null);
      assert.equal(row.attemptRef, null);
      const [leases] =
        await sql`SELECT count(*)::int AS count FROM "CredentialLease" WHERE "runId"=${admitted.run.id}`;
      assert.equal(leases.count, 0);
    } finally {
      await sql`DELETE FROM "RunnerRun" WHERE "agentId"=${agentId}`;
      await sql`DELETE FROM "RunnerAgent" WHERE id=${agentId}`;
      await sql.end();
    }
  });
}
