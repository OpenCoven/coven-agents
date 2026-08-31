import "server-only";

import { eq } from "drizzle-orm";
import { databaseFor } from "@/lib/db/access";
import { tenantCredential } from "@/lib/db/schema";
import type { SubscriberSession } from "@/lib/session";
import { credentialAadContextForWrite } from "./aad-policy";
import { encryptCredential } from "./envelope";
import { credentialKekRingFromEnvironment } from "./key-ring";
import { credentialWhere } from "./scope";
import {
  type CredentialStoreDatabase,
  prepareCredentialForTenant as prepareCredentialForTenantCore,
  readCredentialForTenantWithoutRefresh as readCredentialForTenantWithoutRefreshCore,
} from "./store-core";

export { credentialWhere } from "./scope";

export type PreparedCredentialWrite = {
  aadVersion: number;
  ciphertext: string;
  credentialRevision: string;
  envelopeRevision: string;
  harnessId: string;
  iv: string;
  kekVersion: string;
  tenant: string;
  wrappedKey: string;
};

/**
 * Tenant credential storage: the app is sole custodian of plaintext
 * credentials at rest. Every credential is sealed with `encryptCredential`
 * before it touches a row, and unsealed only for the duration of a single
 * read.
 *
 * Deliberately no bulk read in this module. Every read here is scoped to
 * exactly one tenant and one harness — there is no "all credentials for a
 * tenant" or "all credentials" query anywhere in this file, because the only
 * legitimate consumer (the server-side runner) ever needs exactly one
 * credential for the duration of one run.
 */

export async function putCredential(
  session: SubscriberSession,
  harnessId: string,
  plaintext: string
): Promise<void> {
  const db = databaseFor(session);
  const prepared = await prepareCredentialWrite(session, harnessId, plaintext);

  await db
    .insert(tenantCredential)
    .values(prepared)
    .onConflictDoUpdate({
      set: {
        aadVersion: prepared.aadVersion,
        ciphertext: prepared.ciphertext,
        credentialRevision: prepared.credentialRevision,
        envelopeRevision: prepared.envelopeRevision,
        iv: prepared.iv,
        kekVersion: prepared.kekVersion,
        updatedAt: new Date(),
        wrappedKey: prepared.wrappedKey,
      },
      target: [tenantCredential.tenant, tenantCredential.harnessId],
    });
}

export async function prepareCredentialWrite(
  session: SubscriberSession,
  harnessId: string,
  plaintext: string
): Promise<PreparedCredentialWrite> {
  const ring = await credentialKekRingFromEnvironment();
  const sealed = await encryptCredential(
    plaintext,
    ring.current,
    ring.currentVersion,
    credentialAadContextForWrite(session.tenant, harnessId)
  );

  return {
    aadVersion: sealed.aadVersion,
    ciphertext: sealed.ciphertext,
    credentialRevision: crypto.randomUUID(),
    envelopeRevision: crypto.randomUUID(),
    harnessId,
    iv: sealed.iv,
    kekVersion: sealed.kekVersion,
    tenant: session.tenant,
    wrappedKey: sealed.wrappedKey,
  };
}

export function prepareCredentialForTenant(
  tenant: string,
  harnessId: string,
  db: CredentialStoreDatabase
): Promise<boolean> {
  return prepareCredentialForTenantCore(tenant, harnessId, db);
}

export function readCredentialForTenantWithoutRefresh(
  tenant: string,
  harnessId: string,
  db: CredentialStoreDatabase
): Promise<string | null> {
  return readCredentialForTenantWithoutRefreshCore(tenant, harnessId, db);
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
