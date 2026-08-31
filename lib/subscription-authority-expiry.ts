export const MAX_AUTHORITY_TIMEOUT_MS = 2_147_483_647;

type AuthorityExpiryClock = {
  clearTimeout: (timer: unknown) => void;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
};

const SYSTEM_CLOCK: AuthorityExpiryClock = {
  clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
};

export function scheduleSubscriptionAuthorityExpiry(
  boundary: number,
  onBoundary: () => void,
  clock: AuthorityExpiryClock = SYSTEM_CLOCK
): () => void {
  let cancelled = false;
  let timer: unknown = null;

  const schedule = () => {
    if (cancelled) {
      return;
    }
    const remaining = boundary - clock.now();
    if (remaining <= 0) {
      onBoundary();
      return;
    }
    timer = clock.setTimeout(
      schedule,
      Math.min(remaining, MAX_AUTHORITY_TIMEOUT_MS)
    );
  };

  schedule();
  return () => {
    cancelled = true;
    if (timer !== null) {
      clock.clearTimeout(timer);
    }
  };
}
