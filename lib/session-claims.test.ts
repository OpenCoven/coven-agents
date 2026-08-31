import assert from "node:assert/strict";
import test from "node:test";
import type { JWT } from "next-auth/jwt";
import {
  claimsFromStoredUser,
  refreshClaimsForSessionUpdate,
  refreshTokenType,
} from "./session-claims";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const LATER = new Date("2026-09-24T12:00:00.000Z");
const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

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

test("stored claims overwrite authority and avatar while preserving safe fields", () => {
  const refreshed = claimsFromStoredUser(
    {
      authVersion: 2,
      email: "person@example.com",
      id: USER_ID,
      name: "Person",
      picture: "https://attacker.test/avatar.png",
      subscribedUntil: null,
      type: "demo",
    },
    {
      authVersion: 7,
      image: "https://images.test/stored.png",
      subscribedUntil: LATER,
    },
    NOW
  );

  assert.equal(refreshed.authVersion, 7);
  assert.equal(refreshed.picture, "https://images.test/stored.png");
  assert.equal(refreshed.subscribedUntil, LATER.toISOString());
  assert.equal(refreshed.type, "subscriber");
  assert.equal(refreshed.email, "person@example.com");
  assert.equal(refreshed.name, "Person");
  assert.equal(refreshed.id, USER_ID);
});

test("expired or absent stored periods refresh to demo", () => {
  for (const subscribedUntil of [NOW, null]) {
    const refreshed = claimsFromStoredUser(
      sessionToken(),
      { authVersion: 4, image: null, subscribedUntil },
      NOW
    );

    assert.equal(refreshed.type, "demo");
    assert.equal(
      refreshed.subscribedUntil,
      subscribedUntil?.toISOString() ?? null
    );
  }
});

test("client update fields cannot change stored authority, image, or Stripe data", async () => {
  const refreshed = await refreshClaimsForSessionUpdate(
    sessionToken(),
    {
      authVersion: 999,
      image: "https://attacker.test/avatar.png",
      picture: "https://attacker.test/picture.png",
      stripeCustomerId: "cus_attacker",
      stripeSubscriptionId: "sub_attacker",
      subscribedUntil: LATER.toISOString(),
      type: "subscriber",
    },
    () =>
      Promise.resolve({
        authVersion: 4,
        image: "https://images.test/stored.png",
        subscribedUntil: null,
      }),
    NOW
  );

  assert.ok(refreshed);
  assert.equal(refreshed.authVersion, 4);
  assert.equal(refreshed.picture, "https://images.test/stored.png");
  assert.equal(refreshed.subscribedUntil, null);
  assert.equal(refreshed.type, "demo");
  assert.equal("stripeCustomerId" in refreshed, false);
  assert.equal("stripeSubscriptionId" in refreshed, false);
});

test("stored paid period promotes a current session update", async () => {
  let lookedUpUserId: string | null = null;
  const refreshed = await refreshClaimsForSessionUpdate(
    sessionToken(),
    {},
    (userId) => {
      lookedUpUserId = userId;
      return Promise.resolve({
        authVersion: 4,
        image: null,
        subscribedUntil: LATER,
      });
    },
    NOW
  );

  assert.equal(lookedUpUserId, USER_ID);
  assert.equal(refreshed?.type, "subscriber");
  assert.equal(refreshed?.subscribedUntil, LATER.toISOString());
});

test("invalid IDs and missing users clear the update without promotion", async () => {
  let lookupCalls = 0;
  const invalidUpdates = await Promise.all(
    [undefined, "", "not-a-uuid"].map((id) =>
      refreshClaimsForSessionUpdate(
        { ...sessionToken(), id } as JWT,
        {},
        () => {
          lookupCalls += 1;
          return Promise.resolve({
            authVersion: 4,
            image: null,
            subscribedUntil: LATER,
          });
        },
        NOW
      )
    )
  );
  for (const invalid of invalidUpdates) {
    assert.equal(invalid, null);
  }
  assert.equal(lookupCalls, 0);

  const missing = await refreshClaimsForSessionUpdate(
    sessionToken(),
    {},
    () => Promise.resolve(null),
    NOW
  );
  assert.equal(missing, null);
});

test("a changed auth version revokes rather than refreshing the stale token", async () => {
  const refreshed = await refreshClaimsForSessionUpdate(
    sessionToken(),
    {},
    () =>
      Promise.resolve({
        authVersion: 5,
        image: null,
        subscribedUntil: LATER,
      }),
    NOW
  );

  assert.equal(refreshed, null);
});

test("stored-user lookup failures propagate to Auth.js", async () => {
  await assert.rejects(
    refreshClaimsForSessionUpdate(
      sessionToken(),
      {},
      () => Promise.reject(new Error("database unavailable")),
      NOW
    ),
    /database unavailable/
  );
});

function sessionToken(): JWT {
  return {
    authVersion: 4,
    id: USER_ID,
    picture: null,
    subscribedUntil: null,
    type: "demo",
  };
}
