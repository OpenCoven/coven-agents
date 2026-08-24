import "server-only";

import { and, eq } from "drizzle-orm";
import { databaseFor } from "@/lib/db/access";
import { tenantCredential } from "@/lib/db/schema";
import type { SubscriberSession } from "@/lib/session";
import { decryptCredential, encryptCredential, importKek } from "./envelope";

/**
 * Scopes a credential lookup to exactly one tenant AND one harness.
 *
 * Extracted so the scoping can be asserted without a database. Dropping the
 * harness condition is invisible to an outcome-based test — the query still
 * returns a row, just the wrong one — and handing a tenant's Copilot token to
 * a Codex run is a credential leak inside the tenant rather than a crash.
 */
export function credentialWhere(tenant: string, harnessId: string) {
  return and(
    eq(tenantCredential.tenant, tenant),
    eq(tenantCredential.harnessId, harnessId)
  );
}

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

function kek(): Promise<CryptoKey> {
  const raw = process.env.CREDENTIAL_KEK;
  if (!raw) {
    throw new Error(
      "CREDENTIAL_KEK is not set. Refusing to proceed without an explicit " +
        "key-encryption key — there is no default to fall back to."
    );
  }
  return importKek(raw);
}

export async function putCredential(
  session: SubscriberSession,
  harnessId: string,
  plaintext: string
): Promise<void> {
  const db = databaseFor(session);
  const sealed = await encryptCredential(plaintext, await kek());

  await db
    .insert(tenantCredential)
    .values({
      ciphertext: sealed.ciphertext,
      harnessId,
      iv: sealed.iv,
      tenant: session.tenant,
      wrappedKey: sealed.wrappedKey,
    })
    .onConflictDoUpdate({
      set: {
        ciphertext: sealed.ciphertext,
        iv: sealed.iv,
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

  return decryptCredential(
    { ciphertext: row.ciphertext, iv: row.iv, wrappedKey: row.wrappedKey },
    await kek()
  );
}
