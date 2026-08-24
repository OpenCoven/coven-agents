import assert from "node:assert/strict";
import test from "node:test";
import { isSubscriber, tenantForUser, toSession } from "./session";

test("a demo session carries a synthetic tenant and no user id", () => {
  const session = toSession(null);

  assert.equal(session.kind, "demo");
  assert.ok(session.tenant.startsWith("demo:"));
  assert.equal(isSubscriber(session), false);
});

test("a subscriber session carries the real tenant", () => {
  const session = toSession({ id: "user-1", type: "subscriber" });

  assert.equal(session.kind, "subscriber");
  assert.equal(session.tenant, tenantForUser("user-1"));
  assert.equal(isSubscriber(session), true);
});

test("a signed-in non-subscriber is still a demo session", () => {
  // Being logged in is not the same as having paid. Only the subscriber plan
  // may reach the database.
  const session = toSession({ id: "user-2", type: "demo" });

  assert.equal(session.kind, "demo");
  assert.equal(isSubscriber(session), false);
});

test("every demo session gets a distinct tenant", () => {
  const tenants = new Set(
    Array.from({ length: 50 }, () => toSession(null).tenant)
  );

  assert.equal(tenants.size, 50, "demo tenants must not collide");
});

test("a demo visitor carrying the same cookie keeps the same tenant", () => {
  // The property the cookie exists for. Without threading the id through,
  // every call minted a fresh `demo:<uuid>`, so the same visitor was a
  // different tenant on each request — every page still rendered, and their
  // own state silently failed to follow them.
  const first = toSession(null, "visitor-abc");
  const second = toSession(null, "visitor-abc");

  assert.equal(first.tenant, second.tenant);
  assert.equal(first.tenant, "demo:visitor-abc");
});

test("different demo visitors never share a tenant", () => {
  const a = toSession(null, "visitor-a");
  const b = toSession(null, "visitor-b");

  assert.notEqual(a.tenant, b.tenant);
});

test("a demo visitor with no cookie yet gets a fresh tenant", () => {
  // Not a shared constant: strangers with no cookie must not land in one
  // bucket together.
  const tenants = new Set(
    Array.from({ length: 20 }, () => toSession(null).tenant)
  );

  assert.equal(tenants.size, 20);
  for (const blank of ["", "   "]) {
    assert.notEqual(toSession(null, blank).tenant, `demo:${blank}`);
  }
});
