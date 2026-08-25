import assert from "node:assert/strict";
import test from "node:test";
import { checkoutDecision } from "./checkout";

test("a user with no active subscription may check out", () => {
  assert.equal(
    checkoutDecision({ hasActiveSubscription: false, userId: "user-1" }).kind,
    "allowed"
  );
});

test("a user who is already subscribed is refused", () => {
  // Not enforced by a unique constraint on the customer id: a
  // cancel-then-resubscribe reuses the same Customer, so a constraint there
  // would reject exactly the returning customer worth not breaking.
  assert.equal(
    checkoutDecision({ hasActiveSubscription: true, userId: "user-1" }).kind,
    "already_subscribed"
  );
});

test("an anonymous caller is refused", () => {
  assert.equal(
    checkoutDecision({ hasActiveSubscription: false, userId: null }).kind,
    "unauthorized"
  );
});

test("signed-out is checked before subscription state", () => {
  // An anonymous caller must never learn whether some account is subscribed.
  assert.equal(
    checkoutDecision({ hasActiveSubscription: true, userId: null }).kind,
    "unauthorized"
  );
});

test("an allowed decision carries the user it is for", () => {
  const decision = checkoutDecision({
    hasActiveSubscription: false,
    userId: "user-1",
  });

  assert.equal(decision.kind, "allowed");
  if (decision.kind === "allowed") {
    assert.equal(decision.userId, "user-1");
  }
});
