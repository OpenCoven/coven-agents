import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { StripeReconciliationUser } from "@/lib/billing/stripe-reconciliation";
import { user } from "./schema";
import { stripeReconciliationSnapshotWhere } from "./stripe-reconciliation-store";

const snapshot: StripeReconciliationUser = {
  authVersion: 3,
  billingPeriodStart: null,
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  stripeCustomerId: "cus_store",
  stripeSubscriptionId: null,
  subscribedUntil: null,
  subscriptionOverrideAction: "revoke",
  subscriptionOverrideAt: new Date("2026-09-25T00:00:00.000Z"),
};

test("reconciliation write snapshots compare every entitlement authority field null-safely", () => {
  const query = new QueryBuilder()
    .select({ id: user.id })
    .from(user)
    .where(stripeReconciliationSnapshotWhere(snapshot))
    .toSQL();

  assert.match(query.sql, /"User"\."id" = \$1/u);
  assert.match(query.sql, /"User"\."authVersion" = \$2/u);
  assert.match(
    query.sql,
    /"User"\."billingPeriodStart" is not distinct from \$3/u
  );
  assert.match(
    query.sql,
    /"User"\."subscribedUntil" is not distinct from \$4/u
  );
  assert.match(
    query.sql,
    /"User"\."stripeCustomerId" is not distinct from \$5/u
  );
  assert.match(
    query.sql,
    /"User"\."stripeSubscriptionId" is not distinct from \$6/u
  );
  assert.match(
    query.sql,
    /"User"\."subscriptionOverrideAction" is not distinct from \$7/u
  );
  assert.match(
    query.sql,
    /"User"\."subscriptionOverrideAt" is not distinct from \$8/u
  );
  assert.deepEqual(query.params, [
    snapshot.id,
    snapshot.authVersion,
    null,
    null,
    snapshot.stripeCustomerId,
    null,
    snapshot.subscriptionOverrideAction,
    snapshot.subscriptionOverrideAt,
  ]);
});

test("the singleton lease migration stores coordination metadata only", () => {
  const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  const runSchema = schema.slice(
    schema.indexOf("export const stripeReconciliationRun"),
    schema.indexOf("export const subscriptionOverrideAudit")
  );
  const migration = readFileSync(
    new URL("./migrations/0027_brave_sentinel.sql", import.meta.url),
    "utf8"
  );

  for (const source of [runSchema, migration]) {
    assert.doesNotMatch(
      source,
      /\b(email|payload|metadata|amount|payment|invoice|customer|subscription)\b/iu
    );
  }
  assert.match(runSchema, /leaseOwner/);
  assert.match(runSchema, /leaseFence/);
  assert.match(runSchema, /leaseExpiresAt/);
  assert.match(runSchema, /cursor/);
  assert.match(migration, /StripeReconciliationRun_singleton/);
});

test("database reconciliation coordination uses database time and strict owner fences", () => {
  const store = readFileSync(
    new URL("./stripe-reconciliation-store.ts", import.meta.url),
    "utf8"
  );

  assert.match(store, /clock_timestamp\(\)/);
  assert.match(store, /leaseOwner, lease\.owner/);
  assert.match(store, /leaseFence, lease\.fence/);
  assert.match(store, /for\("update"\)/);
  assert.match(store, /stripeReconciliationSnapshotWhere\(input\.snapshot\)/);
  assert.match(store, /cursor: input\.nextCursor/);
  assert.doesNotMatch(store, /from ["']stripe["']/);
});
