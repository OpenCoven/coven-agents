import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubscriptionAuthorityInvalidationFence,
  subscriptionAuthorityRevision,
} from "./subscription-authority-refresh";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function revision(checkedAt: string, authVersion = 7) {
  return subscriptionAuthorityRevision(
    {
      checkedAt,
      isSubscriber: true,
      subscribedUntil: "2099-01-15T12:00:00.000Z",
      userId: USER_ID,
    },
    USER_ID,
    authVersion
  );
}

test("one authority revision can trigger only one invalidating refresh", () => {
  const fence = createSubscriptionAuthorityInvalidationFence();
  const current = revision("2026-08-31T18:00:00.000Z");
  assert.ok(current);

  assert.equal(fence.invalidate(current), true);
  assert.equal(fence.invalidate(current), false);
  assert.equal(fence.isPending(current, current.contextKey), true);
});

test("an older or identical response cannot clear manual invalidation", () => {
  const fence = createSubscriptionAuthorityInvalidationFence();
  const current = revision("2026-08-31T18:00:00.000Z");
  const older = revision("2026-08-31T17:59:59.999Z");
  assert.ok(current);
  assert.ok(older);
  fence.invalidate(current);

  assert.equal(fence.isPending(older, current.contextKey), true);
  assert.equal(fence.reconcile(older, current.contextKey), false);
  assert.equal(fence.isPending(current, current.contextKey), true);
});

test("a newer server resolution clears invalidation even when authority values match", () => {
  const fence = createSubscriptionAuthorityInvalidationFence();
  const current = revision("2026-08-31T18:00:00.000Z");
  const refreshed = revision("2026-08-31T18:00:00.001Z");
  assert.ok(current);
  assert.ok(refreshed);
  fence.invalidate(current);

  assert.equal(fence.isPending(refreshed, refreshed.contextKey), false);
  assert.equal(fence.reconcile(refreshed, refreshed.contextKey), true);
  assert.equal(fence.invalidate(refreshed), true);
});

test("invalid, cross-user, or changed-auth revisions cannot reopen an invalidated context", () => {
  const fence = createSubscriptionAuthorityInvalidationFence();
  const current = revision("2026-08-31T18:00:00.000Z");
  assert.ok(current);
  fence.invalidate(current);

  assert.equal(
    subscriptionAuthorityRevision(
      {
        checkedAt: "not-a-date",
        isSubscriber: true,
        subscribedUntil: "2099-01-15T12:00:00.000Z",
        userId: USER_ID,
      },
      USER_ID,
      7
    ),
    null
  );
  assert.equal(
    subscriptionAuthorityRevision(
      {
        checkedAt: "2026-08-31T18:00:00.001Z",
        isSubscriber: true,
        subscribedUntil: "2099-01-15T12:00:00.000Z",
        userId: USER_ID,
      },
      "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
      7
    ),
    null
  );
  assert.equal(fence.isPending(null, current.contextKey), true);
  assert.equal(fence.isPending(null, `${USER_ID}:8`), false);
  assert.equal(fence.reconcile(null, `${USER_ID}:8`), true);
});
