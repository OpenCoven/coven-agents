/**
 * A `Session` is a demo session or a subscriber session, modeled as a
 * discriminated union rather than a single type with an `isSubscriber`
 * boolean.
 *
 * Why: a later `databaseFor(session: SubscriberSession)` is the only way to
 * obtain a database handle. With a union, a demo code path that tries to
 * pass its session to `databaseFor` fails to compile — the violation is
 * unrepresentable rather than something a reviewer has to notice. A boolean
 * flag on one type can't do this; TypeScript can't narrow a database-access
 * function's parameter type on a runtime flag the way it can on a
 * discriminated union member.
 *
 * The same principle applies to runner principal unions: an unhandled
 * authority kind is a compile error rather than a runtime surprise. Push the
 * tenant/subscriber distinction into the type system so it cannot silently
 * decay.
 */
export type DemoSession = { kind: "demo"; tenant: string };
export type SubscriberSession = {
  kind: "subscriber";
  tenant: string;
  userId: string;
};
export type Session = DemoSession | SubscriberSession;

/**
 * A tenant id is a durable database and provider-name component, so it uses a
 * compact conservative alphabet. The previous `user:${uuid}` form included
 * punctuation that provider identifiers reject.
 *
 * Rewriting unsafe input is dangerous because `a-b` and `a_b` could collide.
 * Mapping an external identifier onto a safe internal one is therefore this
 * module's job, and the mapping has to be injective: two tenants that collide
 * could share durable state or a provider workspace.
 *
 * Both forms below are a fixed prefix plus exactly 32 hex characters. Fixed
 * width is what makes them unambiguous — with a variable-length body, `u_` +
 * `a` + `b` and `u_` + `ab` would be the same string. The prefixes then keep
 * demo visitors and subscribers in separate spaces even if a uuid repeated.
 */
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCanonicalUuid(value: string): boolean {
  return CANONICAL_UUID.test(value);
}

function packUuid(uuid: string): string {
  return uuid.replaceAll("-", "").toLowerCase();
}

/**
 * Throws rather than encoding an unexpected id. `User.id` is a uuid column, so
 * a non-uuid here is a programming error, and the safe responses to one are to
 * fail or to hash — not to invent an encoding whose collision behaviour nobody
 * has reasoned about. Failing is louder.
 */
export function tenantForUser(userId: string): string {
  if (!isCanonicalUuid(userId)) {
    throw new Error(
      `User id must be a uuid to derive a tenant; got ${JSON.stringify(userId)}.`
    );
  }
  return `u_${packUuid(userId)}`;
}

/**
 * Inverts `tenantForUser`. Only subscriber tenants map back to an account;
 * demo tenants and anything unexpected return null rather than a guess, so a
 * caller can never attribute purchases or charges to the wrong owner.
 */
export function userIdForTenant(
  tenant: string | null | undefined
): string | null {
  if (!tenant || !/^u_[0-9a-f]{32}$/u.test(tenant)) {
    return null;
  }
  const hex = tenant.slice(2);
  const userId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return isCanonicalUuid(userId) ? userId : null;
}

export const DEMO_COOKIE_NAME = "coven-demo";

/**
 * Builds the tenant for a demo visitor from their cookie.
 *
 * The cookie is the only thing that makes a demo tenant stable. Without an id
 * every call mints a fresh one, so the same visitor is a different tenant on
 * every request — every page still renders, and their own state silently does
 * not follow them. A random fallback is deliberate: a visitor with no cookie
 * yet is genuinely new, and sharing one fixed tenant between all of them would
 * put strangers in the same bucket.
 */
export function demoTenant(demoId?: string | null): string {
  const trimmed = demoId?.trim();
  // Anything that is not a uuid we minted is treated as no cookie at all. The
  // value arrives from a request header, so accepting it verbatim would let a
  // visitor choose their own tenant id; `proxy.ts` replaces a rejected cookie
  // so the next request is stable again.
  const id =
    trimmed && isCanonicalUuid(trimmed) ? trimmed : crypto.randomUUID();
  return `d_${packUuid(id)}`;
}

export function toSession(
  user: { id: string; type: string } | null,
  demoId?: string | null
): Session {
  // Fail closed: a subscriber session requires both a signed-in user AND
  // that user's type to be exactly "subscriber". Billing doesn't exist yet,
  // so today nobody gets a subscriber session — that is the correct, safe
  // default, not a bug to "fix" by loosening this check.
  if (user !== null && user.type === "subscriber") {
    return {
      kind: "subscriber",
      tenant: tenantForUser(user.id),
      userId: user.id,
    };
  }

  return { kind: "demo", tenant: demoTenant(demoId) };
}

export function isSubscriber(session: Session): session is SubscriberSession {
  return session.kind === "subscriber";
}
