import assert from "node:assert/strict";
import test from "node:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { tenantCredential } from "@/lib/db/schema";
import { credentialWhere } from "./store";

function sqlFor(tenant: string, harnessId: string) {
  return new QueryBuilder()
    .select()
    .from(tenantCredential)
    .where(credentialWhere(tenant, harnessId))
    .toSQL();
}

test("a credential lookup is scoped to one tenant and one harness", () => {
  // Dropping either condition is invisible to an outcome-based test: the query
  // still returns a row, just the wrong one. Handing a tenant's Copilot token
  // to a Codex run leaks a credential across harnesses inside the tenant.
  const { params, sql } = sqlFor("acme", "copilot");

  assert.ok(sql.includes('"tenant"'), "must filter on tenant");
  assert.ok(sql.includes('"harnessId"'), "must filter on harnessId");
  assert.deepEqual(params, ["acme", "copilot"]);
});

test("both conditions are required, not either", () => {
  const { sql } = sqlFor("acme", "copilot");

  assert.ok(sql.includes(" and "), "conditions must be conjunctive");
  assert.ok(!sql.includes(" or "), "an OR would match another tenant's row");
});
