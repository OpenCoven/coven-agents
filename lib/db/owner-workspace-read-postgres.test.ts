import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { hashRunRequest } from "../runner/evidence";
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
