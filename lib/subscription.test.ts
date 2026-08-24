import assert from "node:assert/strict";
import test from "node:test";
import { toSession } from "./session";
import { isSubscribedAt, userTypeFor } from "./subscription";

const NOW = new Date("2026-08-24T12:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(NOW.getTime() + offsetMs);
}

test("a user with no subscription is not a subscriber", () => {
  assert.equal(isSubscribedAt({}, NOW), false);
  assert.equal(isSubscribedAt({ subscribedUntil: null }, NOW), false);
  assert.equal(userTypeFor({}, NOW), "regular");
});

test("a live subscription makes a subscriber", () => {
  const user = { subscribedUntil: at(60_000) };

  assert.equal(isSubscribedAt(user, NOW), true);
  assert.equal(userTypeFor(user, NOW), "subscriber");
});

test("an expired subscription does not", () => {
  const user = { subscribedUntil: at(-60_000) };

  assert.equal(isSubscribedAt(user, NOW), false);
  assert.equal(userTypeFor(user, NOW), "regular");
});

test("a subscription expiring exactly now has expired", () => {
  // Strictly greater. The boundary has to fall one way, and the safe way is
  // the one that stops access rather than extending it.
  const user = { subscribedUntil: NOW };

  assert.equal(isSubscribedAt(user, NOW), false);
  assert.equal(userTypeFor(user, NOW), "regular");
});

test("only a live subscription reaches a subscriber session", () => {
  // The end-to-end property: this is what decides whether a caller may write
  // to the owner's database.
  const live = toSession({
    id: "user-1",
    type: userTypeFor({ subscribedUntil: at(60_000) }, NOW),
  });
  const lapsed = toSession({
    id: "user-1",
    type: userTypeFor({ subscribedUntil: at(-1) }, NOW),
  });

  assert.equal(live.kind, "subscriber");
  assert.equal(lapsed.kind, "demo");
});
