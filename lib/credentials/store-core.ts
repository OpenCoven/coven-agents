import { and, eq } from "drizzle-orm";
import type { databaseFor } from "@/lib/db/access";
import { tenantCredential } from "@/lib/db/schema";
import { credentialAadContextForWrite } from "./aad-policy";
import { decryptCredential, encryptCredential } from "./envelope";
import { refreshCredential } from "./github-device";
import { credentialKekRingFromEnvironment } from "./key-ring";
import { credentialWhere } from "./scope";
import {
  needsRefresh,
  parseStoredCredential,
  type StoredCredential,
  serializeCredential,
} from "./shape";

export type CredentialStoreDatabase = Pick<
  ReturnType<typeof databaseFor>,
  "delete" | "select" | "update"
>;

export async function prepareCredentialForTenant(
  tenant: string,
  harnessId: string,
  db: CredentialStoreDatabase
): Promise<boolean> {
  const rows = await db
    .select()
    .from(tenantCredential)
    .where(credentialWhere(tenant, harnessId))
    .for("update")
    .limit(1);
  const [row] = rows;
  if (!row) {
    return false;
  }

  const ring = await credentialKekRingFromEnvironment();
  const stored = parseStoredCredential(
    await decryptCredential(
      {
        aadVersion: row.aadVersion,
        ciphertext: row.ciphertext,
        iv: row.iv,
        kekVersion: row.kekVersion,
        wrappedKey: row.wrappedKey,
      },
      ring.keyFor(row.kekVersion),
      { harnessId, kind: "credential", tenant }
    )
  );
  if (!stored) {
    return false;
  }
  if (!needsRefresh(stored, Date.now())) {
    return true;
  }
  return (
    (await refreshStoredCredential(
      stored,
      tenant,
      harnessId,
      row.id,
      row.credentialRevision,
      db
    )) !== null
  );
}

export async function readCredentialForTenantWithoutRefresh(
  tenant: string,
  harnessId: string,
  db: CredentialStoreDatabase
): Promise<string | null> {
  const rows = await db
    .select()
    .from(tenantCredential)
    .where(credentialWhere(tenant, harnessId))
    .limit(1);
  const [row] = rows;
  if (!row) {
    return null;
  }
  const ring = await credentialKekRingFromEnvironment();
  const stored = parseStoredCredential(
    await decryptCredential(
      {
        aadVersion: row.aadVersion,
        ciphertext: row.ciphertext,
        iv: row.iv,
        kekVersion: row.kekVersion,
        wrappedKey: row.wrappedKey,
      },
      ring.keyFor(row.kekVersion),
      { harnessId, kind: "credential", tenant }
    )
  );
  if (!stored) {
    return null;
  }
  return stored.kind === "pat" ? stored.token : stored.access;
}

async function refreshStoredCredential(
  stored: StoredCredential,
  tenant: string,
  harnessId: string,
  expectedCredentialId: string,
  expectedCredentialRevision: string,
  db: CredentialStoreDatabase
): Promise<string | null> {
  if (stored.kind !== "oauth") {
    return stored.token;
  }

  const clientId = process.env.AUTH_GITHUB_ID;
  const clientSecret = process.env.AUTH_GITHUB_SECRET;

  if (!(clientId && clientSecret)) {
    // Nothing can be refreshed without them. Returning the stale token beats
    // returning null: it may still have minutes left, and a run that fails on
    // an expired token is clearer than one that reports no credential at all.
    return stored.access;
  }

  const refreshed = await refreshCredential(
    { clientId, clientSecret, refresh: stored.refresh },
    Date.now()
  );

  if (!refreshed) {
    // A revoked authorization or an expired refresh token. No amount of
    // retrying fixes either, so the row is removed and the tenant is asked to
    // reconnect rather than left with a credential that silently never works.
    const deleted = await db
      .delete(tenantCredential)
      .where(
        and(
          credentialWhere(tenant, harnessId),
          eq(tenantCredential.id, expectedCredentialId),
          eq(tenantCredential.credentialRevision, expectedCredentialRevision)
        )
      )
      .returning({ id: tenantCredential.id });
    if (deleted.length === 0) {
      return await readAuthoritativeCredential(tenant, harnessId, db);
    }
    return null;
  }

  const persisted = await persistCredential(
    tenant,
    harnessId,
    expectedCredentialId,
    expectedCredentialRevision,
    refreshed,
    db
  );
  if (!persisted) {
    return await readAuthoritativeCredential(tenant, harnessId, db);
  }

  return refreshed.kind === "pat" ? refreshed.token : refreshed.access;
}

async function persistCredential(
  tenant: string,
  harnessId: string,
  expectedCredentialId: string,
  expectedCredentialRevision: string,
  credential: StoredCredential,
  db: CredentialStoreDatabase
): Promise<boolean> {
  const ring = await credentialKekRingFromEnvironment();
  const sealed = await encryptCredential(
    serializeCredential(credential),
    ring.current,
    ring.currentVersion,
    credentialAadContextForWrite(tenant, harnessId)
  );

  const updated = await db
    .update(tenantCredential)
    .set({
      aadVersion: sealed.aadVersion,
      ciphertext: sealed.ciphertext,
      credentialRevision: crypto.randomUUID(),
      envelopeRevision: crypto.randomUUID(),
      iv: sealed.iv,
      kekVersion: sealed.kekVersion,
      updatedAt: new Date(),
      wrappedKey: sealed.wrappedKey,
    })
    .where(
      and(
        credentialWhere(tenant, harnessId),
        eq(tenantCredential.id, expectedCredentialId),
        eq(tenantCredential.credentialRevision, expectedCredentialRevision)
      )
    )
    .returning({ id: tenantCredential.id });
  return updated.length === 1;
}

async function readAuthoritativeCredential(
  tenant: string,
  harnessId: string,
  db: CredentialStoreDatabase
): Promise<string | null> {
  const rows = await db
    .select()
    .from(tenantCredential)
    .where(credentialWhere(tenant, harnessId))
    .limit(1);
  const [row] = rows;
  if (!row) {
    return null;
  }
  const ring = await credentialKekRingFromEnvironment();
  const raw = await decryptCredential(
    {
      aadVersion: row.aadVersion,
      ciphertext: row.ciphertext,
      iv: row.iv,
      kekVersion: row.kekVersion,
      wrappedKey: row.wrappedKey,
    },
    ring.keyFor(row.kekVersion),
    { harnessId, kind: "credential", tenant }
  );
  const stored = parseStoredCredential(raw);
  if (!stored) {
    return null;
  }
  return stored.kind === "pat" ? stored.token : stored.access;
}
