import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveSubscriptionAuthority,
  storageUnavailableSubscriptionAuthority,
  subscriptionAuthorityExpiryBoundary,
} from "./subscription-authority";

const USER_A = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const USER_B = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";
const PAID_UNTIL = "2099-01-15T12:00:00.000Z";
const CHECKED_AT = "2099-01-15T11:00:00.000Z";
const AUTH_VERSION = 7;
const RESOLUTION_ID = "authority-resolution";

test("same-user server authority activates a stale demo client", () => {
  assert.deepEqual(
    effectiveSubscriptionAuthority(
      {
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: true,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_A,
      AUTH_VERSION
    ),
    {
      isSubscriber: true,
      subscribedUntil: PAID_UNTIL,
    }
  );
});

test("server downgrade overrides a stale subscriber client", () => {
  assert.deepEqual(
    effectiveSubscriptionAuthority(
      {
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: false,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: null,
        userId: USER_A,
      },
      USER_A,
      AUTH_VERSION
    ),
    {
      isSubscriber: false,
      subscribedUntil: null,
    }
  );
});

test("authority for another user is ignored", () => {
  assert.deepEqual(
    effectiveSubscriptionAuthority(
      {
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: true,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_B,
      AUTH_VERSION
    ),
    {
      isSubscriber: false,
      subscribedUntil: null,
    }
  );
});

test("authority from an older auth version is ignored", () => {
  const authority = {
    authVersion: AUTH_VERSION,
    checkedAt: CHECKED_AT,
    isSubscriber: true,
    resolutionId: RESOLUTION_ID,
    subscribedUntil: PAID_UNTIL,
    userId: USER_A,
  } as const;

  assert.deepEqual(
    effectiveSubscriptionAuthority(authority, USER_A, AUTH_VERSION + 1),
    {
      isSubscriber: false,
      subscribedUntil: null,
    }
  );
  assert.equal(
    subscriptionAuthorityExpiryBoundary(authority, USER_A, AUTH_VERSION + 1),
    null
  );
});

test("a pending boundary refresh fails effective authority closed", () => {
  assert.deepEqual(
    effectiveSubscriptionAuthority(
      {
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: true,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_A,
      AUTH_VERSION,
      true
    ),
    {
      isSubscriber: false,
      subscribedUntil: null,
    }
  );
});

test("storage fallback preserves only a bounded same-session paid authority", () => {
  const now = new Date("2099-01-15T11:00:00.000Z");
  assert.deepEqual(
    storageUnavailableSubscriptionAuthority(
      {
        user: {
          authVersion: AUTH_VERSION,
          id: USER_A,
          subscriptionAuthorityExpiresAt: PAID_UNTIL,
          type: "subscriber",
        },
      },
      now,
      RESOLUTION_ID
    ),
    {
      authorityExpiresAt: PAID_UNTIL,
      authVersion: AUTH_VERSION,
      checkedAt: CHECKED_AT,
      isSubscriber: true,
      resolutionId: RESOLUTION_ID,
      subscribedUntil: null,
      userId: USER_A,
    }
  );

  for (const subscribedUntil of [
    null,
    "not-a-date",
    "2099-01-15T11:00:00.000Z",
  ]) {
    assert.deepEqual(
      storageUnavailableSubscriptionAuthority(
        {
          user: {
            authVersion: AUTH_VERSION,
            id: USER_A,
            subscriptionAuthorityExpiresAt: subscribedUntil,
            type: "subscriber",
          },
        },
        now,
        RESOLUTION_ID
      ),
      {
        authorityExpiresAt: null,
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: false,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: null,
        userId: USER_A,
      }
    );
  }
});

test("same-user expiry scheduling uses database or bounded fallback dates", () => {
  assert.equal(
    subscriptionAuthorityExpiryBoundary(
      {
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: true,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_A,
      AUTH_VERSION
    ),
    PAID_UNTIL
  );
  assert.equal(
    subscriptionAuthorityExpiryBoundary(
      {
        authorityExpiresAt: PAID_UNTIL,
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: true,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: null,
        userId: USER_A,
      },
      USER_A,
      AUTH_VERSION
    ),
    PAID_UNTIL
  );
  assert.equal(
    subscriptionAuthorityExpiryBoundary(
      {
        authorityExpiresAt: PAID_UNTIL,
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: true,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: null,
        userId: USER_A,
      },
      USER_B,
      AUTH_VERSION
    ),
    null
  );
});
