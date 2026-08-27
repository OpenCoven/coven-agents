import assert from "node:assert/strict";
import test from "node:test";
import { refreshTokenType } from "./session-claims";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const LATER = new Date("2026-09-24T12:00:00.000Z");

test("a subscriber whose subscription has lapsed loses the type", () => {
  // The shipped defect: `type` was written once at sign-in and never
  // recomputed, so an expired subscriber kept subscriber entitlements — and a
  // subscriber session is what may write to the owner's database — until
  // their token happened to expire.
  const token = { subscribedUntil: NOW.toISOString(), type: "subscriber" };

  assert.equal(refreshTokenType(token, LATER).type, "demo");
});

test("a live subscription keeps the type", () => {
  const token = { subscribedUntil: LATER.toISOString(), type: "subscriber" };

  assert.equal(refreshTokenType(token, NOW).type, "subscriber");
});

test("a token with no subscription is demo regardless of what it claims", () => {
  // A stale or tampered `type` must not survive: the date is the source of
  // truth, the claim is not.
  const token = { subscribedUntil: null, type: "subscriber" };

  assert.equal(refreshTokenType(token, NOW).type, "demo");
});

test("an unparseable date is demo, not subscriber", () => {
  for (const subscribedUntil of ["", "yesterday", "not-a-date"]) {
    assert.equal(
      refreshTokenType({ subscribedUntil, type: "subscriber" }, NOW).type,
      "demo",
      `${JSON.stringify(subscribedUntil)} must fail closed`
    );
  }
});

test("the rest of the token is preserved", () => {
  const token = {
    id: "user-1",
    subscribedUntil: LATER.toISOString(),
    type: "demo",
  };

  const refreshed = refreshTokenType(token, NOW);

  assert.equal(refreshed.id, "user-1");
  assert.equal(refreshed.subscribedUntil, LATER.toISOString());
});

test("refreshing callback claims preserves the authoritative auth version", () => {
  const refreshed = refreshTokenType(
    {
      authVersion: 7,
      id: "user-1",
      subscribedUntil: LATER.toISOString(),
      type: "subscriber",
    },
    NOW
  );

  assert.equal(refreshed.authVersion, 7);
  assert.equal(refreshed.type, "subscriber");
});

test("a client session update cannot change auth version or subscription date", () => {
  const refreshed = refreshTokenType(
    {
      authVersion: 7,
      id: "user-1",
      subscribedUntil: null,
      type: "demo",
    },
    NOW
  );

  assert.deepEqual(refreshed, {
    authVersion: 7,
    id: "user-1",
    subscribedUntil: null,
    type: "demo",
  });
});
