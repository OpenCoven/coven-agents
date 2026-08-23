import type { AgentOwner } from "@opencoven/agent-contracts";

/**
 * Sandbox keys are a tenant boundary, not a naming convention. Two accounts
 * whose keys collide share a container, and therefore share a workspace and
 * every file in it, so the key must be derived in exactly one place.
 */

const TENANT_ID_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Records created before ownership existed still have to resolve to some
 * tenant. They resolve to this one rather than to an empty string, so a missing
 * owner can never collapse two accounts onto the same key.
 */
export const UNOWNED_TENANT = "unowned";

export class TenantKeyError extends Error {
  readonly code = "invalid_tenant_id";
}

/**
 * `-` separates the parts, so a tenant id containing `-` could forge another
 * tenant's key: owner `a` + agent `b-c` and owner `a-b` + agent `c` would
 * otherwise produce the same string. Rejecting the separator outright is what
 * makes the encoding unambiguous, so callers must map an external identifier
 * (a GitHub login can contain `-`) onto a safe internal id rather than passing
 * it through. Rejecting is deliberate: silently rewriting `a-b` to `a_b` would
 * reintroduce the collision it was meant to prevent.
 */
export function assertTenantId(tenantId: string): string {
  if (!TENANT_ID_PATTERN.test(tenantId)) {
    throw new TenantKeyError(
      `Tenant id must match ${String(TENANT_ID_PATTERN)}. Map external identifiers onto a safe internal id before deriving a sandbox key.`
    );
  }
  return tenantId;
}

/**
 * The only supported way to name an agent's sandbox. Creation and destruction
 * both route through it, so `decommission` cannot destroy a different tenant's
 * container by reconstructing the key differently.
 */
export function sandboxKey(tenantId: string, agentId: string): string {
  return `agent-${assertTenantId(tenantId)}-${agentId}`;
}

/**
 * Resolves the tenant that owns a definition, tolerating pre-ownership records.
 *
 * A cave familiar is isolated by its cave instance, not by its familiar id: one
 * cave may run several familiars, and they belong to the same account, so the
 * instance is the account boundary. `caveInstanceId` is passed through
 * unmodified so `assertTenantId` can reject an unsafe one — per the note above,
 * silently rewriting it would reintroduce the collision the check prevents.
 *
 * A standalone agent carries no identifier at all, so it resolves to the shared
 * unowned tenant. That is safe here only because `sandboxKey` also includes the
 * agent id, which is a uuid: two standalone agents still get distinct keys.
 */
export function tenantOf(definition: { owner?: AgentOwner | null }): string {
  const { owner } = definition;
  if (!owner) {
    return UNOWNED_TENANT;
  }
  switch (owner.kind) {
    case "tenant":
      return owner.tenantId;
    case "cave-familiar":
      return owner.caveInstanceId;
    default:
      return UNOWNED_TENANT;
  }
}
