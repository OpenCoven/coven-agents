import assert from "node:assert/strict";
import test from "node:test";
import {
  createSubscriptionAuthorityInvalidationFence,
  subscriptionAuthorityRevision,
} from "./subscription-authority-refresh";

const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

function revision(
  checkedAt: string,
  authVersion = 7,
  subscribedUntil = "2099-01-15T12:00:00.000Z"
) {
  return subscriptionAuthorityRevision(
    {
      authVersion,
      checkedAt,
      isSubscriber: true,
      subscribedUntil,
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

test("a newer server resolution permits one retry when authority values match", () => {
  const fence = createSubscriptionAuthorityInvalidationFence();
  const current = revision("2026-08-31T18:00:00.000Z");
  const refreshed = revision("2026-08-31T18:00:00.001Z");
  assert.ok(current);
  assert.ok(refreshed);
  fence.invalidate(current);

  assert.equal(fence.isPending(refreshed, refreshed.contextKey), false);
  assert.equal(fence.reconcile(refreshed, refreshed.contextKey), true);
  assert.equal(fence.invalidate(refreshed), false);
  assert.equal(fence.isPending(refreshed, refreshed.contextKey), true);
});

test("one unchanged authority incident gets only one automatic recovery refresh", () => {
  const fence = createSubscriptionAuthorityInvalidationFence();
  const initial = revision("2026-08-31T18:00:00.000Z");
  const retried = revision("2026-08-31T18:00:00.001Z");
  const later = revision("2026-08-31T18:00:00.002Z");
  assert.ok(initial);
  assert.ok(retried);
  assert.ok(later);

  assert.equal(fence.invalidate(initial), true);
  assert.equal(fence.reconcile(retried, retried.contextKey), true);
  assert.equal(fence.invalidate(retried), false);
  assert.equal(fence.isPending(retried, retried.contextKey), true);
  assert.equal(fence.reconcile(later, later.contextKey), false);
  assert.equal(fence.isPending(later, later.contextKey), true);
});

test("a materially changed authority clears a bounded refusal incident", () => {
  const fence = createSubscriptionAuthorityInvalidationFence();
  const initial = revision("2026-08-31T18:00:00.000Z");
  const retried = revision("2026-08-31T18:00:00.001Z");
  const extended = revision(
    "2026-08-31T18:00:00.002Z",
    7,
    "2099-02-15T12:00:00.000Z"
  );
  assert.ok(initial);
  assert.ok(retried);
  assert.ok(extended);
  fence.invalidate(initial);
  fence.reconcile(retried, retried.contextKey);
  fence.invalidate(retried);

  assert.equal(fence.reconcile(extended, extended.contextKey), true);
  assert.equal(fence.isPending(extended, extended.contextKey), false);
  assert.equal(fence.invalidate(extended), true);
});

test("invalid, cross-user, or changed-auth revisions cannot reopen an invalidated context", () => {
  const fence = createSubscriptionAuthorityInvalidationFence();
  const current = revision("2026-08-31T18:00:00.000Z");
  assert.ok(current);
  fence.invalidate(current);

  assert.equal(
    subscriptionAuthorityRevision(
      {
        authVersion: 7,
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
        authVersion: 7,
        checkedAt: "2026-08-31T18:00:00.001Z",
        isSubscriber: true,
        subscribedUntil: "2099-01-15T12:00:00.000Z",
        userId: USER_ID,
      },
      USER_ID,
      8
    ),
    null
  );
  assert.equal(
    subscriptionAuthorityRevision(
      {
        authVersion: 7,
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
