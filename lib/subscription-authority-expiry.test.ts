import assert from "node:assert/strict";
import test from "node:test";
import {
  INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE,
  MAX_AUTHORITY_TIMEOUT_MS,
  reduceSubscriptionAuthorityExpiry,
  scheduleSubscriptionAuthorityExpiry,
  subscriptionAuthorityBoundaryPending,
  subscriptionAuthorityBoundaryRefreshRequired,
  subscriptionAuthorityBoundaryRevision,
} from "./subscription-authority-expiry";

const USER_A = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const USER_B = "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa";

class FakeClock {
  readonly delays: number[] = [];
  nowMs: number;
  private nextTimer = 0;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >();

  constructor(now: number) {
    this.nowMs = now;
  }

  readonly clearTimeout = (timer: unknown) => {
    this.timers.delete(timer as number);
  };

  readonly now = () => this.nowMs;

  readonly setTimeout = (callback: () => void, delay: number) => {
    this.nextTimer += 1;
    this.delays.push(delay);
    this.timers.set(this.nextTimer, {
      at: this.nowMs + delay,
      callback,
    });
    return this.nextTimer;
  };

  advance(milliseconds: number): void {
    const target = this.nowMs + milliseconds;
    while (true) {
      const [next] = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort(([, leftTimer], [, rightTimer]) => leftTimer.at - rightTimer.at);
      if (!next) {
        break;
      }
      const [id, scheduled] = next;
      this.timers.delete(id);
      this.nowMs = scheduled.at;
      scheduled.callback();
    }
    this.nowMs = target;
  }
}

test("expires exactly at the authority boundary", () => {
  const clock = new FakeClock(1000);
  let expired = false;
  scheduleSubscriptionAuthorityExpiry(
    1500,
    () => {
      expired = true;
    },
    clock
  );

  clock.advance(499);
  assert.equal(expired, false);
  clock.advance(1);
  assert.equal(expired, true);
});

test("expires an already elapsed authority immediately", () => {
  const clock = new FakeClock(1500);
  let expirations = 0;
  scheduleSubscriptionAuthorityExpiry(
    1500,
    () => {
      expirations += 1;
    },
    clock
  );

  assert.equal(expirations, 1);
  assert.deepEqual(clock.delays, []);
});

test("rescheduling an extended authority cancels the old boundary", () => {
  const clock = new FakeClock(1000);
  const expirations: string[] = [];
  const cancelInitial = scheduleSubscriptionAuthorityExpiry(
    1500,
    () => expirations.push("initial"),
    clock
  );

  clock.advance(250);
  cancelInitial();
  scheduleSubscriptionAuthorityExpiry(
    2000,
    () => expirations.push("extended"),
    clock
  );
  clock.advance(250);
  assert.deepEqual(expirations, []);
  clock.advance(500);
  assert.deepEqual(expirations, ["extended"]);
});

test("cancelling an old user's timer prevents it affecting a new owner", () => {
  const clock = new FakeClock(1000);
  const expirations: string[] = [];
  const cancelFirstUser = scheduleSubscriptionAuthorityExpiry(
    1500,
    () => expirations.push("first"),
    clock
  );

  cancelFirstUser();
  scheduleSubscriptionAuthorityExpiry(
    2500,
    () => expirations.push("second"),
    clock
  );
  clock.advance(500);
  assert.deepEqual(expirations, []);
  clock.advance(1000);
  assert.deepEqual(expirations, ["second"]);
});

test("distant boundaries are scheduled in bounded timeout chunks", () => {
  const clock = new FakeClock(1000);
  let expired = false;
  scheduleSubscriptionAuthorityExpiry(
    1000 + MAX_AUTHORITY_TIMEOUT_MS + 5000,
    () => {
      expired = true;
    },
    clock
  );

  assert.deepEqual(clock.delays, [MAX_AUTHORITY_TIMEOUT_MS]);
  clock.advance(MAX_AUTHORITY_TIMEOUT_MS);
  assert.equal(expired, false);
  assert.deepEqual(clock.delays, [MAX_AUTHORITY_TIMEOUT_MS, 5000]);
  clock.advance(5000);
  assert.equal(expired, true);
});

function authority(
  checkedAt: string,
  subscribedUntil: string,
  userId = USER_A
) {
  return {
    checkedAt,
    isSubscriber: true,
    subscribedUntil,
    userId,
  } as const;
}

function reconcile(
  state: typeof INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE,
  revision: NonNullable<
    ReturnType<typeof subscriptionAuthorityBoundaryRevision>
  >,
  nowMs: number
) {
  return reduceSubscriptionAuthorityExpiry(state, {
    nowMs,
    revision,
    type: "reconcile",
  });
}

test("raw boundary revisions retain an elapsed timestamp for refresh without granting authority", () => {
  const checkedAt = "2026-08-31T18:00:00.000Z";
  const expiredAt = "2026-08-31T18:05:00.000Z";
  const revision = subscriptionAuthorityBoundaryRevision(
    authority(checkedAt, expiredAt),
    USER_A
  );

  assert.deepEqual(revision, {
    boundaryMs: Date.parse(expiredAt),
    checkedAt,
    checkedAtMs: Date.parse(checkedAt),
    contextKey: USER_A,
    key: `${USER_A}:${checkedAt}:${expiredAt}`,
    subscribedUntil: expiredAt,
  });
  assert.equal(
    subscriptionAuthorityBoundaryRevision(
      authority(checkedAt, expiredAt),
      USER_B
    ),
    null
  );
  assert.equal(
    subscriptionAuthorityBoundaryRevision(
      authority("not-a-date", expiredAt),
      USER_A
    ),
    null
  );
  assert.equal(
    subscriptionAuthorityBoundaryRevision(
      authority(checkedAt, "not-a-date"),
      USER_A
    ),
    null
  );
});

test("an elapsed boundary refresh can reopen on a newer database extension", () => {
  const oldRevision = subscriptionAuthorityBoundaryRevision(
    authority("2026-08-31T18:00:00.000Z", "2026-08-31T18:05:00.000Z"),
    USER_A
  );
  const extendedRevision = subscriptionAuthorityBoundaryRevision(
    authority("2026-08-31T18:05:00.100Z", "2026-09-30T18:05:00.000Z"),
    USER_A
  );
  assert.ok(oldRevision);
  assert.ok(extendedRevision);

  let state = reconcile(
    INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE,
    oldRevision,
    Date.parse("2026-08-31T18:04:59.999Z")
  );
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision: oldRevision,
    type: "boundary",
  });
  assert.equal(subscriptionAuthorityBoundaryPending(state, oldRevision), true);
  assert.equal(
    subscriptionAuthorityBoundaryRefreshRequired(state, oldRevision),
    true
  );
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision: oldRevision,
    type: "refresh_requested",
  });

  state = reconcile(
    state,
    extendedRevision,
    Date.parse("2026-08-31T18:05:00.200Z")
  );

  assert.equal(
    subscriptionAuthorityBoundaryPending(state, extendedRevision),
    false
  );
  assert.equal(
    subscriptionAuthorityBoundaryRefreshRequired(state, extendedRevision),
    false
  );
});

test("a newer checked revision that remains expired closes without a refresh loop", () => {
  const oldRevision = subscriptionAuthorityBoundaryRevision(
    authority("2026-08-31T18:00:00.000Z", "2026-08-31T18:05:00.000Z"),
    USER_A
  );
  const stillExpired = subscriptionAuthorityBoundaryRevision(
    authority("2026-08-31T18:05:00.100Z", "2026-08-31T18:05:00.000Z"),
    USER_A
  );
  assert.ok(oldRevision);
  assert.ok(stillExpired);

  let state = reconcile(
    INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE,
    oldRevision,
    Date.parse("2026-08-31T18:05:00.000Z")
  );
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision: oldRevision,
    type: "boundary",
  });
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision: oldRevision,
    type: "refresh_requested",
  });
  state = reconcile(
    state,
    stillExpired,
    Date.parse("2026-08-31T18:05:00.200Z")
  );
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision: stillExpired,
    type: "boundary",
  });

  assert.equal(
    subscriptionAuthorityBoundaryPending(state, stillExpired),
    false
  );
  assert.equal(
    subscriptionAuthorityBoundaryRefreshRequired(state, stillExpired),
    false
  );
});

test("an already-expired identical revision requests refresh only once", () => {
  const revision = subscriptionAuthorityBoundaryRevision(
    authority("2026-08-31T18:00:00.000Z", "2026-08-31T18:05:00.000Z"),
    USER_A
  );
  assert.ok(revision);

  let state = reconcile(
    INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE,
    revision,
    Date.parse("2026-08-31T18:05:00.001Z")
  );
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision,
    type: "boundary",
  });
  assert.equal(
    subscriptionAuthorityBoundaryRefreshRequired(state, revision),
    true
  );
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision,
    type: "refresh_requested",
  });
  state = reconcile(state, revision, Date.parse("2026-08-31T18:05:01.000Z"));
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision,
    type: "boundary",
  });

  assert.equal(subscriptionAuthorityBoundaryPending(state, revision), true);
  assert.equal(
    subscriptionAuthorityBoundaryRefreshRequired(state, revision),
    false
  );
});

test("changing users clears the old timer revision and pending boundary", () => {
  const firstRevision = subscriptionAuthorityBoundaryRevision(
    authority("2026-08-31T18:00:00.000Z", "2026-08-31T18:05:00.000Z", USER_A),
    USER_A
  );
  const secondRevision = subscriptionAuthorityBoundaryRevision(
    authority("2026-08-31T18:06:00.000Z", "2026-09-30T18:05:00.000Z", USER_B),
    USER_B
  );
  assert.ok(firstRevision);
  assert.ok(secondRevision);

  let state = reconcile(
    INITIAL_SUBSCRIPTION_AUTHORITY_EXPIRY_STATE,
    firstRevision,
    Date.parse("2026-08-31T18:05:00.000Z")
  );
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision: firstRevision,
    type: "boundary",
  });
  state = reconcile(
    state,
    secondRevision,
    Date.parse("2026-08-31T18:06:00.000Z")
  );
  state = reduceSubscriptionAuthorityExpiry(state, {
    revision: firstRevision,
    type: "boundary",
  });

  assert.equal(
    subscriptionAuthorityBoundaryPending(state, firstRevision),
    false
  );
  assert.equal(
    subscriptionAuthorityBoundaryPending(state, secondRevision),
    false
  );
});
