import { type AgentOwner, TENANT_ID_PATTERN } from "@opencoven/agent-contracts";

/**
 * Sandbox keys are a tenant boundary, not a naming convention. Two accounts
 * whose keys collide share a container, and therefore share a workspace and
 * every file in it, so the key must be derived in exactly one place.
 */

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
 * The Sandbox SDK rejects an id longer than 63 characters, and concatenating
 * the parts blew straight past it: `agent-` plus a 34-character tenant plus a
 * 36-character uuid is 77. Every run failed with "Sandbox ID must be 1-63
 * characters long" -- after authentication, after the credential was fetched,
 * with zero commands and zero file operations.
 *
 * Truncating would have fit and would have been a tenancy hole: two ids that
 * share a prefix would share a container, and therefore a workspace and every
 * file in it. A digest is the only way to hit a fixed width without giving up
 * the property the key exists for.
 */
const SANDBOX_ID_MAX_LENGTH = 63;
const DIGEST_BASE = 36;
/** 256 bits in base 36. Fixed so the id cannot vary in width. */
const DIGEST_LENGTH = 50;

/**
 * Base 36 keeps the id to `[0-9a-z]`.
 *
 * Base 64 would be shorter but introduces `-` and `_`, and these ids become
 * DNS labels: a leading or trailing `-` is refused outright, and the rest is
 * not worth the risk to save seven characters.
 */
function base36(bytes: Uint8Array): string {
  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  return value.toString(DIGEST_BASE).padStart(DIGEST_LENGTH, "0");
}

/**
 * The only supported way to name an agent's sandbox. Creation and destruction
 * both route through it, so `decommission` cannot destroy a different tenant's
 * container by reconstructing the key differently.
 *
 * Async because SHA-256 in Workers is. The alternative -- a synchronous
 * non-cryptographic hash -- would put collision resistance, and with it the
 * tenant boundary, on a function chosen for convenience.
 *
 * The tenant id no longer appears in the container name, which is a small
 * privacy gain: these ids surface as DNS labels.
 */
export async function sandboxKey(
  tenantId: string,
  agentId: string
): Promise<string> {
  // Still asserted. The digest would happily absorb an illegal tenant id, and
  // this is the one place that refuses an identifier nobody mapped.
  assertTenantId(tenantId);

  // Written as an escape, never as a raw control character: a literal NUL in
  // a source file is invisible in review and makes the file read as binary to
  // grep and everything that follows its lead.
  //
  // A separator at all because the fields must not run together: without one,
  // tenant `ab` + agent `c` and tenant `a` + agent `bc` hash the same input.
  // NUL cannot occur in a tenant id -- the pattern forbids it -- so no pair
  // can smuggle the separator into a field.
  const source = new TextEncoder().encode(`${tenantId}\u0000${agentId}`);
  const digest = await crypto.subtle.digest("SHA-256", source);
  const key = `agent-${base36(new Uint8Array(digest))}`;

  if (key.length > SANDBOX_ID_MAX_LENGTH) {
    throw new TenantKeyError(
      `Sandbox key ${key.length} characters exceeds the ${SANDBOX_ID_MAX_LENGTH}-character limit.`
    );
  }

  return key;
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
    case "standalone":
      return UNOWNED_TENANT;
    default:
      /**
       * Every kind is handled above, so `owner` narrows to `never` here and
       * adding one to the contract without deciding its tenant is a compile
       * error rather than a runtime surprise.
       *
       * Falling back to UNOWNED_TENANT would have been an authorization bug,
       * not a harmless default: `callerTenant` is currently UNOWNED_TENANT, so
       * an unhandled kind would have matched the ownership check and granted
       * every caller access. Throwing fails closed instead — the request
       * becomes a 500 rather than a silent cross-tenant read.
       */
      return assertUnreachableOwner(owner);
  }
}

function assertUnreachableOwner(owner: never): never {
  throw new TenantKeyError(
    `Owner kind ${JSON.stringify(owner)} has no tenant mapping. Add one before the kind ships.`
  );
}
