import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { user } from "./schema";
import {
  subscriptionOverrideOwnerWhere,
  subscriptionOverrideWriteFenceWhere,
} from "./subscription-override";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function lockSql() {
  return new QueryBuilder()
    .select()
    .from(user)
    .where(subscriptionOverrideOwnerWhere(USER_ID))
    .for("update")
    .limit(1)
    .toSQL();
}

test("subscription overrides lock exactly the selected User and fence their write by full authority", () => {
  const locked = lockSql();
  assert.match(locked.sql, /where "User"\."id" = \$1 limit \$2 for update/u);
  assert.deepEqual(locked.params, [USER_ID, 1]);

  const fenced = new QueryBuilder()
    .select()
    .from(user)
    .where(
      subscriptionOverrideWriteFenceWhere({
        expectedAuthVersion: 4,
        expectedBillingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
        expectedSubscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
        expectedSubscriptionOverrideAction: null,
        expectedSubscriptionOverrideAt: null,
        userId: USER_ID,
      })
    )
    .toSQL();
  assert.match(
    fenced.sql,
    /where \("User"\."id" = \$1 and "User"\."authVersion" = \$2 and "User"\."billingPeriodStart" is not distinct from \$3 and "User"\."subscribedUntil" is not distinct from \$4 and "User"\."subscriptionOverrideAction" is not distinct from \$5 and "User"\."subscriptionOverrideAt" is not distinct from \$6\)/u
  );
  assert.deepEqual(fenced.params, [
    USER_ID,
    4,
    new Date("2026-08-01T00:00:00.000Z"),
    new Date("2026-09-01T00:00:00.000Z"),
    null,
    null,
  ]);
});

test("User persists a finite paired active override marker in generated migration 0028", () => {
  const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  const migrationName = readdirSync(
    new URL("./migrations/", import.meta.url)
  ).find((name) => /^0028_.+\.sql$/u.test(name));

  assert.ok(migrationName, "missing generated 0028 override migration");
  const migration = readFileSync(
    new URL(`./migrations/${migrationName}`, import.meta.url),
    "utf8"
  );
  const journal = readFileSync(
    new URL("./migrations/meta/_journal.json", import.meta.url),
    "utf8"
  );

  for (const source of [schema, migration]) {
    assert.match(source, /subscriptionOverrideAction/);
    assert.match(source, /subscriptionOverrideAt/);
    assert.match(source, /subscriptionOverride.*shape/i);
    assert.match(source, /isfinite/i);
  }
  const userSchema = schema.slice(
    schema.indexOf("export const user = pgTable("),
    schema.indexOf("export type User")
  );
  assert.doesNotMatch(userSchema, /referenceDigest|referenceText|digest/i);
  assert.match(journal, new RegExp(migrationName.replace(/\.sql$/u, "")));
});

test("subscription override audit schema and generated migration retain only bounded operational evidence", () => {
  const schema = readFileSync(new URL("./schema.ts", import.meta.url), "utf8");
  const migrationTag = "0025_cynical_scourge";
  const migration = readFileSync(
    new URL(`./migrations/${migrationTag}.sql`, import.meta.url),
    "utf8"
  );
  const journal = readFileSync(
    new URL("./migrations/meta/_journal.json", import.meta.url),
    "utf8"
  );

  assert.match(
    schema,
    /subscriptionOverrideAudit = pgTable\(\s*"SubscriptionOverrideAudit"/
  );
  assert.match(schema, /SubscriptionOverrideAudit_action_check/);
  assert.match(schema, /SubscriptionOverrideAudit_referenceDigest_check/);
  assert.match(schema, /SubscriptionOverrideAudit_authVersion_check/);
  assert.match(schema, /SubscriptionOverrideAudit_user_createdAt_idx/);
  assert.match(
    schema,
    /userId: uuid\("userId"\)[\s\S]*references\(\(\) => user\.id, \{ onDelete: "restrict" \}\)/
  );
  assert.doesNotMatch(
    schema,
    /SubscriptionOverrideAudit[\s\S]{0,1800}(email|reference:|note|stripe|customer|subscriptionId|payload|secret|payment)/i
  );

  assert.match(migration, /CREATE TABLE "SubscriptionOverrideAudit"/);
  assert.match(migration, /"referenceDigest" varchar\(64\) NOT NULL/);
  assert.match(
    migration,
    /FOREIGN KEY \("userId"\) REFERENCES "public"\."User"\("id"\) ON DELETE restrict/
  );
  assert.match(migration, /SubscriptionOverrideAudit_action_check/);
  assert.match(migration, /SubscriptionOverrideAudit_referenceDigest_check/);
  assert.match(migration, /SubscriptionOverrideAudit_authVersion_check/);
  assert.match(migration, /SubscriptionOverrideAudit_user_createdAt_idx/);
  assert.match(journal, new RegExp(migrationTag));
  assert.doesNotMatch(
    migration,
    /"(email|reference|note|stripe|customer|subscriptionId|payload|secret|payment)"/i
  );
});
