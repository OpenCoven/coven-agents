import assert from "node:assert/strict";
import test from "node:test";
import { TENANT_ID_PATTERN } from "@opencoven/agent-contracts";
import {
  isCanonicalUuid,
  isSubscriber,
  tenantForUser,
  toSession,
} from "./session";

/**
 * Imported, never copied. Every tenant id this module mints becomes part of a
 * sandbox key, and the worker rejects anything that does not match -- which is
 * exactly what happened: `user:${uuid}` failed on both `:` and the uuid's `-`,
 * so every cloud run died before its sandbox started. A local copy of the
 * pattern would pass this suite forever after the worker tightened its own.
 */
const WORKER_TENANT_PATTERN = TENANT_ID_PATTERN;

const UUID_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const UUID_B = "9c858901-8a57-4791-81fe-4c455b099bc9";

test("a demo session carries a synthetic tenant and no user id", () => {
  const session = toSession(null);

  assert.equal(session.kind, "demo");
  assert.ok(session.tenant.startsWith("d_"));
  assert.equal(isSubscriber(session), false);
});

test("a subscriber session carries the real tenant", () => {
  const session = toSession({ id: UUID_A, type: "subscriber" });

  assert.equal(session.kind, "subscriber");
  assert.equal(session.tenant, tenantForUser(UUID_A));
  assert.equal(isSubscriber(session), true);
});

test("a signed-in non-subscriber is still a demo session", () => {
  // Being logged in is not the same as having paid. Only the subscriber plan
  // may reach the database.
  const session = toSession({ id: UUID_B, type: "demo" });

  assert.equal(session.kind, "demo");
  assert.equal(isSubscriber(session), false);
});

test("every tenant a session can mint is a legal sandbox key component", () => {
  const tenants = [
    tenantForUser(UUID_A),
    toSession({ id: UUID_B, type: "subscriber" }).tenant,
    toSession(null).tenant,
    toSession(null, UUID_A).tenant,
    toSession(null, "not-a-uuid").tenant,
    toSession(null, "").tenant,
  ];

  for (const tenant of tenants) {
    assert.match(tenant, WORKER_TENANT_PATTERN);
  }
});

test("subscriber and demo tenants cannot collide, even on the same uuid", () => {
  // The prefixes are the whole defence. Two tenants that produce one sandbox
  // key share a container, and therefore a workspace and every file in it.
  assert.notEqual(tenantForUser(UUID_A), toSession(null, UUID_A).tenant);
});

test("a tenant is a fixed-width body, so no two ids can run together", () => {
  // Variable width would make the encoding ambiguous: `u_` + `a` + `b` and
  // `u_` + `ab` would be one string.
  assert.equal(tenantForUser(UUID_A), `u_${UUID_A.replaceAll("-", "")}`);
  assert.equal(tenantForUser(UUID_A).length, 34);
  assert.equal(
    toSession(null, UUID_B).tenant,
    `d_${UUID_B.replaceAll("-", "")}`
  );
});

test("a non-uuid user id is refused rather than encoded", () => {
  // `User.id` is a uuid column, so this is a programming error. Inventing an
  // encoding whose collision behaviour nobody reasoned about is the dangerous
  // response; failing loudly is not.
  assert.throws(() => tenantForUser("user-1"), /must be a uuid/);
});

test("every demo session gets a distinct tenant", () => {
  const tenants = new Set(
    Array.from({ length: 50 }, () => toSession(null).tenant)
  );

  assert.equal(tenants.size, 50, "demo tenants must not collide");
});

test("a demo visitor carrying the same cookie keeps the same tenant", () => {
  // The property the cookie exists for. Without threading the id through,
  // every call minted a fresh tenant, so the same visitor was a different
  // tenant on each request — every page still rendered, and their own state
  // silently failed to follow them.
  const first = toSession(null, UUID_A);
  const second = toSession(null, UUID_A);

  assert.equal(first.tenant, second.tenant);
});

test("different demo visitors never share a tenant", () => {
  assert.notEqual(
    toSession(null, UUID_A).tenant,
    toSession(null, UUID_B).tenant
  );
});

test("a cookie the server did not mint is not honoured", () => {
  // The value arrives from a request header. Honouring it verbatim would let a
  // visitor name their own tenant and read another one's sandbox; `proxy.ts`
  // replaces the rejected cookie so the next request is stable again.
  const forged = toSession(null, "d_0000").tenant;

  assert.notEqual(forged, "d_0000");
  assert.match(forged, WORKER_TENANT_PATTERN);
  assert.notEqual(forged, toSession(null, "d_0000").tenant);
});

test("a demo visitor with no cookie yet gets a fresh tenant", () => {
  // Not a shared constant: strangers with no cookie must not land in one
  // bucket together.
  const tenants = new Set(
    Array.from({ length: 20 }, () => toSession(null).tenant)
  );

  assert.equal(tenants.size, 20);
  for (const blank of ["", "   "]) {
    assert.notEqual(toSession(null, blank).tenant, `d_${blank}`);
  }
});

test("only canonical uuids are accepted as ids", () => {
  assert.ok(isCanonicalUuid(UUID_A));
  assert.ok(isCanonicalUuid(UUID_A.toUpperCase()));
  for (const bad of ["", "user-1", `${UUID_A}x`, UUID_A.replaceAll("-", "")]) {
    assert.equal(isCanonicalUuid(bad), false, bad);
  }
});
