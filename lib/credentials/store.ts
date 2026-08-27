import "server-only";

import { eq } from "drizzle-orm";
import { databaseFor } from "@/lib/db/access";
import { tenantCredential } from "@/lib/db/schema";
import type { SubscriberSession } from "@/lib/session";
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

export { credentialWhere } from "./scope";

/**
 * Tenant credential storage: the app is sole custodian of plaintext
 * credentials at rest. Every credential is sealed with `encryptCredential`
 * before it touches a row, and unsealed only for the duration of a single
 * read.
 *
 * Deliberately no bulk read in this module. Every read here is scoped to
 * exactly one tenant and one harness — there is no "all credentials for a
 * tenant" or "all credentials" query anywhere in this file, because the only
 * legitimate consumer (the worker, via the internal route) ever needs
 * exactly one credential for the duration of one run.
 */

export async function putCredential(
  session: SubscriberSession,
  harnessId: string,
  plaintext: string
): Promise<void> {
  const db = databaseFor(session);
  const ring = await credentialKekRingFromEnvironment();
  const sealed = await encryptCredential(
    plaintext,
    ring.current,
    ring.currentVersion
  );

  await db
    .insert(tenantCredential)
    .values({
      ciphertext: sealed.ciphertext,
      harnessId,
      iv: sealed.iv,
      kekVersion: sealed.kekVersion,
      tenant: session.tenant,
      wrappedKey: sealed.wrappedKey,
    })
    .onConflictDoUpdate({
      set: {
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
        kekVersion: sealed.kekVersion,
        updatedAt: new Date(),
        wrappedKey: sealed.wrappedKey,
      },
      target: [tenantCredential.tenant, tenantCredential.harnessId],
    });
}

export async function readCredentialForTenant(
  tenant: string,
  harnessId: string,
  db: ReturnType<typeof databaseFor>
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
      ciphertext: row.ciphertext,
      iv: row.iv,
      kekVersion: row.kekVersion,
      wrappedKey: row.wrappedKey,
    },
    ring.keyFor(row.kekVersion)
  );

  const stored = parseStoredCredential(raw);

  if (!stored) {
    return null;
  }

  if (!needsRefresh(stored, Date.now())) {
    return stored.kind === "pat" ? stored.token : stored.access;
  }

  // Refreshed here because this is the single point every run reads through,
  // so a run that starts always holds a live token. A device-flow token lives
  // eight hours; without this a subscriber's agents would work in the morning
  // and fail silently by evening.
  return await refreshStoredCredential(stored, tenant, harnessId, db);
}

async function refreshStoredCredential(
  stored: StoredCredential,
  tenant: string,
  harnessId: string,
  db: ReturnType<typeof databaseFor>
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
    await db.delete(tenantCredential).where(credentialWhere(tenant, harnessId));
    return null;
  }

  await persistCredential(tenant, harnessId, refreshed, db);

  return refreshed.kind === "pat" ? refreshed.token : refreshed.access;
}

async function persistCredential(
  tenant: string,
  harnessId: string,
  credential: StoredCredential,
  db: ReturnType<typeof databaseFor>
): Promise<void> {
  const ring = await credentialKekRingFromEnvironment();
  const sealed = await encryptCredential(
    serializeCredential(credential),
    ring.current,
    ring.currentVersion
  );

  await db
    .update(tenantCredential)
    .set({
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      kekVersion: sealed.kekVersion,
      updatedAt: new Date(),
      wrappedKey: sealed.wrappedKey,
    })
    .where(credentialWhere(tenant, harnessId));
}

/**
 * Removes a tenant's credential for one harness.
 *
 * Scoped through the same predicate as a read, so a delete cannot widen to
 * another harness — or, with the tenant condition dropped, to another tenant's
 * row. Revocation is a row deletion rather than a key rotation precisely
 * because each credential has its own data key.
 */
/**
 * Which harnesses this tenant has a credential stored for.
 *
 * Returns ids only. The credential itself is never read here and has no
 * business leaving the server for a UI that only needs to say "configured" --
 * a status endpoint that returned the secret would put it back on the wire for
 * no reason, which is the same rule `putCredential` follows on write.
 */
export async function listCredentialHarnesses(
  session: SubscriberSession
): Promise<string[]> {
  const db = databaseFor(session);

  const rows = await db
    .select({ harnessId: tenantCredential.harnessId })
    .from(tenantCredential)
    .where(eq(tenantCredential.tenant, session.tenant));

  return rows.map((row) => row.harnessId).sort();
}

export async function deleteCredential(
  session: SubscriberSession,
  harnessId: string
): Promise<void> {
  const db = databaseFor(session);

  await db
    .delete(tenantCredential)
    .where(credentialWhere(session.tenant, harnessId));
}
