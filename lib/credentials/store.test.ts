import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { base64UrlEncode } from "@opencoven/agent-contracts";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { databaseFor } from "@/lib/db/access";
import { tenantCredential } from "@/lib/db/schema";
import { encryptCredential, generateKek } from "./envelope";
import { credentialWhere } from "./scope";
import { serializeCredential } from "./shape";
import { readCredentialForTenant } from "./store-core";

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
  const coreSource = readFileSync(
    new URL("./store-core.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /import ["']server-only["']/);
  assert.doesNotMatch(coreSource, /server-only/);
  assert.match(source, /ring\.currentVersion/);
  assert.match(source, /kekVersion: sealed\.kekVersion/);
  assert.match(source, /aadVersion: sealed\.aadVersion/);
  assert.match(source, /tenant, harnessId/);
  assert.match(coreSource, /ring\.keyFor\(row\.kekVersion\)/);
  assert.match(coreSource, /aadVersion: row\.aadVersion/);
  assert.match(coreSource, /tenant, harnessId/);
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

test("credential AAD migration and trigger fence legacy binding updates", () => {
  const migration = readFileSync(
    new URL(
      "../db/migrations/0009_credential_kek_versions.sql",
      import.meta.url
    ),
    "utf8"
  );
  const triggerMigration = readFileSync(
    new URL(
      "../db/migrations/0010_credential_envelope_revisions.sql",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(migration, /ADD COLUMN IF NOT EXISTS "aadVersion" integer/i);
  assert.match(migration, /SET "aadVersion" = 0/i);
  assert.match(migration, /"aadVersion"[^\r\n]*IN \(0, 1\)/i);
  assert.match(
    triggerMigration,
    /NEW\."aadVersion" IS DISTINCT FROM OLD\."aadVersion"/i
  );
  assert.match(
    triggerMigration,
    /UPDATE OF "ciphertext", "iv", "wrappedKey", "kekVersion", "aadVersion"/i
  );
});

test("OAuth refresh persists only when the row revision still matches", () => {
  const source = readFileSync(
    new URL("./store-core.ts", import.meta.url),
    "utf8"
  );

  assert.match(source, /row\.envelopeRevision/);
  assert.match(
    source,
    /eq\(tenantCredential\.envelopeRevision, expectedEnvelopeRevision\)/
  );
  assert.match(source, /returning\(\{ id: tenantCredential\.id \}\)/);
  assert.match(source, /authoritative|re-read|reread/i);
});

test("OAuth refresh returns the authoritative replacement after a CAS loss", async () => {
  const key = await generateKek();
  const rawKey = base64UrlEncode(
    new Uint8Array(await crypto.subtle.exportKey("raw", key))
  );
  const previousEnvironment = {
    AUTH_GITHUB_ID: process.env.AUTH_GITHUB_ID,
    AUTH_GITHUB_SECRET: process.env.AUTH_GITHUB_SECRET,
    CREDENTIAL_KEK_CURRENT_VERSION: process.env.CREDENTIAL_KEK_CURRENT_VERSION,
    CREDENTIAL_KEK_V1: process.env.CREDENTIAL_KEK_V1,
  };
  process.env.CREDENTIAL_KEK_CURRENT_VERSION = "v1";
  process.env.CREDENTIAL_KEK_V1 = rawKey;
  process.env.AUTH_GITHUB_ID = "client";
  process.env.AUTH_GITHUB_SECRET = "secret";

  const context = {
    harnessId: "copilot",
    kind: "credential" as const,
    tenant: "acme",
  };
  const staleEnvelope = await encryptCredential(
    serializeCredential({
      access: "stale-access",
      expiresAt: 0,
      kind: "oauth",
      refresh: "stale-refresh",
    }),
    key,
    "v1",
    context
  );
  const authoritativeEnvelope = await encryptCredential(
    serializeCredential({ kind: "pat", token: "authoritative-token" }),
    key,
    "v1",
    context
  );
  const staleRow = {
    aadVersion: staleEnvelope.aadVersion,
    ciphertext: staleEnvelope.ciphertext,
    envelopeRevision: "revision-stale",
    harnessId: "copilot",
    id: "credential-row",
    iv: staleEnvelope.iv,
    kekVersion: "v1",
    tenant: "acme",
    wrappedKey: staleEnvelope.wrappedKey,
  };
  const authoritativeRow = {
    ...staleRow,
    aadVersion: authoritativeEnvelope.aadVersion,
    ciphertext: authoritativeEnvelope.ciphertext,
    envelopeRevision: "revision-authoritative",
    iv: authoritativeEnvelope.iv,
    wrappedKey: authoritativeEnvelope.wrappedKey,
  };
  let selectCalls = 0;
  const db = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  selectCalls += 1;
                  return Promise.resolve([
                    selectCalls === 1 ? staleRow : authoritativeRow,
                  ]);
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set() {
          return {
            where() {
              return {
                returning() {
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as ReturnType<typeof databaseFor>;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        access_token: "fresh-access",
        expires_in: 3600,
        refresh_token: "fresh-refresh",
      }),
      { status: 200 }
    );

  try {
    assert.equal(
      await readCredentialForTenant("acme", "copilot", db),
      "authoritative-token"
    );
    assert.equal(selectCalls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
