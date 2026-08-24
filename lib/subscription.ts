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
 * The session type a stored user resolves to.
 *
 * Fail-closed by construction: anything that is not a live subscription is
 * `regular`, and `toSession` only grants a subscriber session for the exact
 * string `"subscriber"`.
 */
export function userTypeFor(
  user: { subscribedUntil?: Date | null },
  now: Date
): "regular" | "subscriber" {
  return isSubscribedAt(user, now) ? "subscriber" : "regular";
}
