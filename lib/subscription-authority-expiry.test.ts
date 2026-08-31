import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUTHORITY_TIMEOUT_MS,
  scheduleSubscriptionAuthorityExpiry,
} from "./subscription-authority-expiry";

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
