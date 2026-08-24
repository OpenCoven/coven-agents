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
