import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { tenantCredential } from "@/lib/db/schema";
import { credentialWhere } from "./scope";

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

test("credential storage writes the current version and reads the row version", () => {
  const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8");

  assert.match(source, /ring\.currentVersion/);
  assert.match(source, /kekVersion: sealed\.kekVersion/);
  assert.match(source, /ring\.keyFor\(row\.kekVersion\)/);
});

test("credential envelope writes fence stale writers with a fresh revision", () => {
  const source = readFileSync(new URL("./store.ts", import.meta.url), "utf8");

  assert.match(source, /envelopeRevision:\s*crypto\.randomUUID\(\)/g);
  assert.match(source, /envelopeRevision:\s*crypto\.randomUUID\(\)/g);
});

test("the credential revision migration installs an idempotent write fence", () => {
  const migration = readFileSync(
    new URL(
      "../db/migrations/0010_credential_envelope_revisions.sql",
      import.meta.url
    ),
    "utf8"
  );
  const snapshot = readFileSync(
    new URL("../db/migrations/meta/0010_snapshot.json", import.meta.url),
    "utf8"
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "envelopeRevision" uuid/i);
  assert.match(migration, /"kekVersion" SET DEFAULT 'v1'/i);
  assert.match(migration, /gen_random_uuid\(\)/i);
  assert.match(migration, /SET "envelopeRevision" = gen_random_uuid\(\)/i);
  assert.match(migration, /SET NOT NULL/i);
  assert.match(migration, /CREATE OR REPLACE FUNCTION/i);
  assert.match(
    migration,
    /NEW\."ciphertext" IS DISTINCT FROM OLD\."ciphertext"/i
  );
  assert.match(migration, /NEW\."iv" IS DISTINCT FROM OLD\."iv"/i);
  assert.match(
    migration,
    /NEW\."wrappedKey" IS DISTINCT FROM OLD\."wrappedKey"/i
  );
  assert.match(migration, /IS DISTINCT FROM/i);
  assert.match(migration, /IS NOT DISTINCT FROM/i);
  assert.match(migration, /RAISE EXCEPTION/i);
  assert.match(migration, /DROP TRIGGER IF EXISTS/i);
  assert.match(migration, /CREATE TRIGGER/i);
  assert.match(migration, /DROP FUNCTION IF EXISTS/i);
  assert.match(
    snapshot,
    /"envelopeRevision"[\s\S]*"default": "gen_random_uuid\(\)"/i
  );
  assert.match(snapshot, /"kekVersion"[\s\S]*"default": "'v1'"/i);
});
