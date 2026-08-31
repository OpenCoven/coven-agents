import assert from "node:assert/strict";
import test from "node:test";
import type Stripe from "stripe";
import {
  checkoutDecision,
  isBlockingSubscriptionStatus,
  stableIntegrationIdentifier,
} from "./checkout";
import { createStripeClient } from "./stripe-client";

const BLOCKING_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "unpaid",
  "paused",
  "incomplete",
] satisfies Stripe.Subscription.Status[];

test("every live subscription status blocks checkout", () => {
  for (const status of BLOCKING_STATUSES) {
    assert.equal(isBlockingSubscriptionStatus(status), true, status);
  }
});

test("terminal subscriptions allow a new checkout", () => {
  for (const status of [
    "canceled",
    "incomplete_expired",
  ] satisfies Stripe.Subscription.Status[]) {
    assert.equal(isBlockingSubscriptionStatus(status), false, status);
  }
});

test("an anonymous caller is refused before subscription state is disclosed", () => {
  assert.equal(
    checkoutDecision({
      hasBlockingSubscription: true,
      userId: null,
    }).kind,
    "unauthorized"
  );
});

test("an allowed decision carries the authenticated user", () => {
  const decision = checkoutDecision({
    hasBlockingSubscription: false,
    userId: "user-1",
  });

  assert.equal(decision.kind, "allowed");
  if (decision.kind === "allowed") {
    assert.equal(decision.userId, "user-1");
  }
});

test("integration identifiers are stable and end in eight lowercase letters", () => {
  const first = stableIntegrationIdentifier("provider-key-one");
  const retry = stableIntegrationIdentifier("provider-key-one");
  const other = stableIntegrationIdentifier("provider-key-two");

  assert.equal(first, retry);
  assert.notEqual(first, other);
  assert.match(first, /^opencoven_coven_agents_[a-z]{8}$/);
});

test("Stripe clients use the pinned Dahlia API version", () => {
  const client = createStripeClient("sk_test_checkout");

  assert.equal(client.getApiField("version"), "2026-07-29.dahlia");
});
