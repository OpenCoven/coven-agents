import { and, eq } from "drizzle-orm";
import { tenantCredential } from "@/lib/db/schema";

/** Scopes a credential lookup to exactly one tenant and one harness. */
export function credentialWhere(tenant: string, harnessId: string) {
  return and(
    eq(tenantCredential.tenant, tenant),
    eq(tenantCredential.harnessId, harnessId)
  );
}
