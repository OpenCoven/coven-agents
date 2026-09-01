export const MAX_RETRY_AFTER_DELAY_MS = 24 * 60 * 60_000;
const HTTP_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u;

export type RetryAfterDeadline =
  | { kind: "excessive"; retryAt: number | null }
  | { kind: "invalid" }
  | { kind: "valid"; retryAt: number };

function excessiveRetryAt(now: number, delay: bigint): RetryAfterDeadline {
  const retryAt = BigInt(now) + delay;
  return {
    kind: "excessive",
    retryAt:
      retryAt <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(retryAt) : null,
  };
}

export function parseRetryAfter(
  value: string | null,
  now: number = Date.now()
): RetryAfterDeadline {
  if (!value) {
    return { kind: "invalid" };
  }
  const candidate = value.trim();
  if (/^\d+$/u.test(candidate)) {
    const delay = BigInt(candidate) * 1000n;
    if (delay > BigInt(MAX_RETRY_AFTER_DELAY_MS)) {
      return excessiveRetryAt(now, delay);
    }
    return { kind: "valid", retryAt: now + Number(delay) };
  }

  if (!HTTP_DATE.test(candidate)) {
    return { kind: "invalid" };
  }
  const retryAt = Date.parse(candidate);
  if (!Number.isFinite(retryAt)) {
    return { kind: "invalid" };
  }
  const boundedRetryAt = Math.max(now, retryAt);
  if (boundedRetryAt - now > MAX_RETRY_AFTER_DELAY_MS) {
    return { kind: "excessive", retryAt: boundedRetryAt };
  }
  return { kind: "valid", retryAt: boundedRetryAt };
}
