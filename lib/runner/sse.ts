import "server-only";

import type { RunEvent } from "@opencoven/agent-contracts";

export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 60_000;
export const DEFAULT_SSE_POLL_INTERVAL_MS = 1000;

export type RunEventStreamSnapshot = {
  events: readonly RunEvent[];
  terminal: boolean;
};

export type RunEventStreamOptions = {
  idleTimeoutMs?: number;
  lastEventId: number;
  now?: () => number;
  pollIntervalMs?: number;
  read: (afterEventId: number) => Promise<RunEventStreamSnapshot | null>;
  signal?: AbortSignal;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

function serializeEvent(event: RunEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function waitForPoll(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Streams persisted Agent Runner events in cursor order. The injected read,
 * sleep, and clock make the delivery policy deterministic in tests.
 */
export function createRunEventStream(
  options: RunEventStreamOptions
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SSE_POLL_INTERVAL_MS;
  const sleep = options.sleep ?? waitForPoll;
  const now = options.now ?? Date.now;
  let cancelled = false;
  let removeAbortListener: (() => void) | undefined;

  return new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      removeAbortListener?.();
    },
    start(controller) {
      let closed = false;
      const close = (): void => {
        if (!closed) {
          closed = true;
          removeAbortListener?.();
          controller.close();
        }
      };
      const fail = (error: unknown): void => {
        if (!closed) {
          closed = true;
          removeAbortListener?.();
          controller.error(error);
        }
      };
      const onAbort = (): void => {
        cancelled = true;
        close();
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        options.signal?.removeEventListener("abort", onAbort);

      const pump = async (): Promise<void> => {
        let cursor = options.lastEventId;
        let lastActivityAt = now();
        try {
          while (!cancelled && !options.signal?.aborted) {
            // biome-ignore lint/performance/noAwaitInLoops: Each poll advances one SSE cursor.
            const snapshot = await options.read(cursor);
            if (!snapshot || cancelled || options.signal?.aborted) {
              close();
              return;
            }
            const events = [...snapshot.events].sort(
              (left, right) => left.id - right.id
            );
            let delivered = false;
            for (const event of events) {
              if (event.id <= cursor) {
                continue;
              }
              controller.enqueue(encoder.encode(serializeEvent(event)));
              cursor = event.id;
              delivered = true;
            }
            if (delivered) {
              lastActivityAt = now();
            }
            if (snapshot.terminal) {
              close();
              return;
            }
            const remainingIdleMs = idleTimeoutMs - (now() - lastActivityAt);
            if (remainingIdleMs <= 0) {
              close();
              return;
            }
            await sleep(
              Math.min(pollIntervalMs, remainingIdleMs),
              options.signal
            );
          }
          close();
        } catch (error) {
          if (cancelled || options.signal?.aborted) {
            close();
          } else {
            fail(error);
          }
        }
      };

      queueMicrotask(pump);
    },
  });
}
