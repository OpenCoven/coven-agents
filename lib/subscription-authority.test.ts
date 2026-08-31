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

test("same-user server authority activates a stale demo client", () => {
  assert.deepEqual(
    effectiveSubscriptionAuthority(
      {
        isSubscriber: true,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_A
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
        isSubscriber: false,
        subscribedUntil: null,
        userId: USER_A,
      },
      USER_A
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
        isSubscriber: true,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_B
    ),
    {
      isSubscriber: false,
      subscribedUntil: null,
    }
  );
});

test("a pending boundary refresh fails effective authority closed", () => {
  assert.deepEqual(
    effectiveSubscriptionAuthority(
      {
        isSubscriber: true,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_A,
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
          id: USER_A,
          subscriptionAuthorityExpiresAt: PAID_UNTIL,
          type: "subscriber",
        },
      },
      now
    ),
    {
      authorityExpiresAt: PAID_UNTIL,
      isSubscriber: true,
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
            id: USER_A,
            subscriptionAuthorityExpiresAt: subscribedUntil,
            type: "subscriber",
          },
        },
        now
      ),
      {
        authorityExpiresAt: null,
        isSubscriber: false,
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
        isSubscriber: true,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_A
    ),
    PAID_UNTIL
  );
  assert.equal(
    subscriptionAuthorityExpiryBoundary(
      {
        authorityExpiresAt: PAID_UNTIL,
        isSubscriber: true,
        subscribedUntil: null,
        userId: USER_A,
      },
      USER_A
    ),
    PAID_UNTIL
  );
  assert.equal(
    subscriptionAuthorityExpiryBoundary(
      {
        authorityExpiresAt: PAID_UNTIL,
        isSubscriber: true,
        subscribedUntil: null,
        userId: USER_A,
      },
      USER_B
    ),
    null
  );
});
