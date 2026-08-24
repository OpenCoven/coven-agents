import type { PlaybackStep } from "./player";

type PlaybackCallbacks = {
  onComplete: () => void;
  onReveal: (event: PlaybackStep["event"]) => void;
};

type PlaybackTimers = {
  clearTimeout: (timer: unknown) => void;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
};

const DEFAULT_TIMERS: PlaybackTimers = {
  clearTimeout: (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

export function schedulePlayback(
  steps: PlaybackStep[],
  callbacks: PlaybackCallbacks,
  timers: PlaybackTimers = DEFAULT_TIMERS
) {
  let cancelled = false;
  let pendingTimer: unknown;

  const scheduleStep = (index: number) => {
    if (cancelled) {
      return;
    }

    const step = steps[index];
    if (!step) {
      callbacks.onComplete();
      return;
    }

    pendingTimer = timers.setTimeout(() => {
      if (cancelled) {
        return;
      }
      callbacks.onReveal(step.event);
      scheduleStep(index + 1);
    }, step.delayMs);
  };

  scheduleStep(0);

  return () => {
    cancelled = true;
    if (pendingTimer !== undefined) {
      timers.clearTimeout(pendingTimer);
    }
  };
}
