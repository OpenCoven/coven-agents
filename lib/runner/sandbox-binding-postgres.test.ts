import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";

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
