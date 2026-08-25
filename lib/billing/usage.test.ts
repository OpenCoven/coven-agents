import assert from "node:assert/strict";
import test from "node:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { runUsage } from "@/lib/db/schema";
import { usageWhere } from "./usage";

const SINCE = new Date("2026-08-20T12:00:00.000Z");

function sqlFor(tenant: string, since: Date) {
  return new QueryBuilder()
    .select()
    .from(runUsage)
    .where(usageWhere(tenant, since))
    .toSQL();
}

test("usage is scoped to one tenant and one period", () => {
  // Dropping either condition is invisible to an outcome-based test: the query
  // still returns a count, just the wrong one. Counting across tenants would
  // charge a customer for someone else's runs; counting across periods would
  // never reset.
  const { params, sql } = sqlFor("acme", SINCE);

  assert.ok(sql.includes('"tenant"'), "must filter on tenant");
  assert.ok(sql.includes('"countedAt"'), "must filter on the period");
  // Drizzle serialises the Date to an ISO string before it reaches the
  // driver, so that is what the bound parameter actually is.
  assert.deepEqual(params, ["acme", SINCE.toISOString()]);
});

test("both conditions are required, not either", () => {
  const { sql } = sqlFor("acme", SINCE);

  assert.ok(sql.includes(" and "), "conditions must be conjunctive");
  assert.ok(!sql.includes(" or "), "an OR would count another tenant's runs");
});

test("the period bound is inclusive of its start", () => {
  // A run recorded at the exact instant the period begins belongs to it.
  // Exclusive would silently drop one run per period, always in the
  // customer's favour but wrong.
  const { sql } = sqlFor("acme", SINCE);

  assert.ok(sql.includes(">="), `expected an inclusive bound, got: ${sql}`);
});
