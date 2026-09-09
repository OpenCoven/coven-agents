import { campaignGrantActiveAt } from "./billing/campaign";

/**
 * Whether a stored user row counts as a subscriber right now.
 *
 * A nullable timestamp rather than a boolean, because "subscribed until" is
 * the shape billing will need anyway: a cancelled subscription runs to the end
 * of its period, and a boolean cannot express that without a second field.
 * Stripe will set this column in spec 3; until then it is set by hand.
 *
 * A pure function rather than an inline check inside the auth callback,
 * because that callback is the decision that says who may reach the owner's
 * database, and logic inside a framework callback is unreachable by a unit
 * test. That is the same mistake as the hardcoded subscriber plan which passed
 * every test until it was extracted.
 */
export function isSubscribedAt(
  user: { subscribedUntil?: Date | null },
  now: Date
): boolean {
  const until = user.subscribedUntil;
  if (!until) {
    return false;
  }
  // Strictly greater: a subscription that expired this instant has expired.
  return until.getTime() > now.getTime();
}

/**
 * Whether a stored user row is entitled to run anything right now, by any
 * route: a live subscription, or live open-beta campaign minutes.
 *
 * Separate from `isSubscribedAt` because the two questions have different
 * answers and different audiences. "Is this person paying?" is what billing,
 * the account page and the admin directory ask, and a campaign participant
 * must answer no to all three. "May this person run an agent?" is what the
 * session type and the runner ask, and a campaign participant answers yes.
 *
 * Conflating them is how a free participant shows up in revenue.
 */
export function isEntitledAt(
  user: { campaignExpiresAt?: Date | null; campaignGrantedAt?: Date | null } & {
    subscribedUntil?: Date | null;
  },
  now: Date
): boolean {
  return isSubscribedAt(user, now) || campaignGrantActiveAt(user, now);
}

/**
 * The session type a stored user resolves to.
 *
 * Fail-closed by construction: anything that is neither a live subscription
 * nor a live campaign grant is `demo`, and `toSession` only grants a
 * subscriber session for the exact string `"subscriber"`.
 *
 * A campaign participant resolves to `subscriber` because that is the session
 * type that owns a tenant and may reach the database. Their entitlement is
 * narrower than a payer's -- 20 minutes rather than 300, in 5-minute runs --
 * but that difference belongs in the run admission caps, not in whether they
 * have an account at all. The alternative, a third session kind, would ripple
 * through every `databaseFor` and `isSubscriber` call site to express a
 * distinction that only the reservation caps actually act on.
 */
export function userTypeFor(
  user: {
    campaignExpiresAt?: Date | null;
    campaignGrantedAt?: Date | null;
    subscribedUntil?: Date | null;
  },
  now: Date
): "demo" | "subscriber" {
  return isEntitledAt(user, now) ? "subscriber" : "demo";
}
