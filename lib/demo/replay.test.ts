import assert from "node:assert/strict";
import test from "node:test";
import type { PlaybackStep } from "./player";
import { schedulePlayback } from "./replay";

type Timer = {
  callback: () => void;
  cancelled: boolean;
  delayMs: number;
};

function fakeTimers() {
  const queue: Timer[] = [];

  return {
    api: {
      clearTimeout(timer: unknown) {
        (timer as Timer).cancelled = true;
      },
      setTimeout(callback: () => void, delayMs: number) {
        const timer = { callback, cancelled: false, delayMs };
        queue.push(timer);
        return timer;
      },
    },
    pendingDelays() {
      return queue
        .filter((timer) => !timer.cancelled)
        .map((timer) => timer.delayMs);
    },
    runNext() {
      const timer = queue.shift();
      if (timer && !timer.cancelled) {
        timer.callback();
      }
    },
    runRemaining() {
      while (queue.length > 0) {
        this.runNext();
      }
    },
  };
}

function steps(): PlaybackStep[] {
  return [
    {
      delayMs: 0,
      event: { id: 1, status: "queued", type: "status" },
    },
    {
      delayMs: 125,
      event: { id: 2, output: "Inspecting files", type: "output" },
    },
    {
      delayMs: 300,
      event: { id: 3, status: "completed", type: "status" },
    },
  ];
}

test("events are revealed in order using each planned delay", () => {
  const timers = fakeTimers();
  const revealed: number[] = [];
  let completed = false;

  schedulePlayback(
    steps(),
    {
      onComplete: () => {
        completed = true;
      },
      onReveal: (event) => revealed.push(event.id),
    },
    timers.api
  );

  assert.deepEqual(timers.pendingDelays(), [0]);
  timers.runNext();
  assert.deepEqual(revealed, [1]);
  assert.deepEqual(timers.pendingDelays(), [125]);
  timers.runNext();
  assert.deepEqual(revealed, [1, 2]);
  assert.deepEqual(timers.pendingDelays(), [300]);
  timers.runNext();
  assert.deepEqual(revealed, [1, 2, 3]);
  assert.equal(completed, true);
});

test("cleanup stops pending reveals and a restart begins from the first event", () => {
  const timers = fakeTimers();
  const firstPass: number[] = [];
  const secondPass: number[] = [];

  const cancel = schedulePlayback(
    steps(),
    {
      onComplete: () => undefined,
      onReveal: (event) => firstPass.push(event.id),
    },
    timers.api
  );
  timers.runNext();
  cancel();
  timers.runRemaining();

  schedulePlayback(
    steps(),
    {
      onComplete: () => undefined,
      onReveal: (event) => secondPass.push(event.id),
    },
    timers.api
  );
  timers.runRemaining();

  assert.deepEqual(firstPass, [1]);
  assert.deepEqual(secondPass, [1, 2, 3]);
});
