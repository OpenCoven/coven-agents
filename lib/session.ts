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
 * This mirrors `worker/src/tenant.ts`, which switches exhaustively over an
 * owner union so an unhandled case is a compile error rather than a runtime
 * surprise. Same idea here: push the tenant/subscriber distinction into the
 * type system so it can't silently decay.
 */
export type DemoSession = { kind: "demo"; tenant: string };
export type SubscriberSession = {
  kind: "subscriber";
  tenant: string;
  userId: string;
};
export type Session = DemoSession | SubscriberSession;

export function tenantForUser(userId: string): string {
  return `user:${userId}`;
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
  return `demo:${trimmed || crypto.randomUUID()}`;
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
