import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveSubscriptionAuthority,
  serializeSubscriptionAuthority,
} from "./subscription-authority";

const USER_A = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const USER_B = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";
const NOW = new Date("2026-08-31T18:00:00.000Z");
const CHECKED_AT = NOW.toISOString();
const PAID_UNTIL = "2099-01-15T12:00:00.000Z";
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
      AUTH_VERSION,
      false,
      NOW.getTime()
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
      AUTH_VERSION,
      false,
      NOW.getTime()
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
      AUTH_VERSION,
      false,
      NOW.getTime()
    ),
    {
      isSubscriber: false,
      subscribedUntil: null,
    }
  );
});

test("authority from an older auth version is ignored", () => {
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
      AUTH_VERSION + 1,
      false,
      NOW.getTime()
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
        authVersion: AUTH_VERSION,
        checkedAt: CHECKED_AT,
        isSubscriber: true,
        resolutionId: RESOLUTION_ID,
        subscribedUntil: PAID_UNTIL,
        userId: USER_A,
      },
      USER_A,
      AUTH_VERSION,
      true,
      NOW.getTime()
    ),
    {
      isSubscriber: false,
      subscribedUntil: null,
    }
  );
});

test("storage-unavailable signed authority is inactive without a finite future boundary", () => {
  for (const subscribedUntil of [null, "not-a-date", NOW.toISOString()]) {
    assert.deepEqual(
      serializeSubscriptionAuthority({
        authVersion: AUTH_VERSION,
        checkedAt: NOW,
        isSubscriber: true,
        resolutionId: RESOLUTION_ID,
        subscribedUntil,
        userId: USER_A,
      }),
      {
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

test("storage-unavailable signed authority is bounded to its exact future timestamp", () => {
  assert.deepEqual(
    serializeSubscriptionAuthority({
      authVersion: AUTH_VERSION,
      checkedAt: NOW,
      isSubscriber: true,
      resolutionId: RESOLUTION_ID,
      subscribedUntil: PAID_UNTIL,
      userId: USER_A,
    }),
    {
      authVersion: AUTH_VERSION,
      checkedAt: CHECKED_AT,
      isSubscriber: true,
      resolutionId: RESOLUTION_ID,
      subscribedUntil: PAID_UNTIL,
      userId: USER_A,
    }
  );
});

test("effective authority rejects null, malformed, and expired active shapes", () => {
  for (const subscribedUntil of [
    null,
    "not-a-date",
    "2026-08-31T17:59:59.999Z",
    CHECKED_AT,
  ]) {
    assert.deepEqual(
      effectiveSubscriptionAuthority(
        {
          authVersion: AUTH_VERSION,
          checkedAt: CHECKED_AT,
          isSubscriber: true,
          resolutionId: RESOLUTION_ID,
          subscribedUntil,
          userId: USER_A,
        },
        USER_A,
        AUTH_VERSION,
        false,
        NOW.getTime()
      ),
      {
        isSubscriber: false,
        subscribedUntil: null,
      }
    );
  }
});
