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
  let closed = false;
  let cursor = options.lastEventId;
  let lastActivityAt = now();
  let terminal = false;
  const pending: RunEvent[] = [];
  let removeAbortListener: (() => void) | undefined;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined;
  const abortController = new AbortController();

  const close = (): void => {
    if (!closed) {
      closed = true;
      removeAbortListener?.();
      controllerRef?.close();
    }
  };
  const fail = (error: unknown): void => {
    if (!closed) {
      closed = true;
      removeAbortListener?.();
      controllerRef?.error(error);
    }
  };
  const abort = (): void => {
    cancelled = true;
    abortController.abort();
    close();
  };
  const cancel = (): void => {
    if (!closed) {
      cancelled = true;
      closed = true;
      abortController.abort();
      removeAbortListener?.();
    }
  };

  return new ReadableStream<Uint8Array>({
    cancel() {
      cancel();
    },
    async pull(streamController) {
      controllerRef = streamController;
      try {
        while (!cancelled && !abortController.signal.aborted) {
          const queuedEvent = pending.shift();
          if (queuedEvent) {
            streamController.enqueue(
              encoder.encode(serializeEvent(queuedEvent))
            );
            cursor = queuedEvent.id;
            lastActivityAt = now();
            if (terminal && pending.length === 0) {
              close();
            }
            return;
          }
          if (terminal) {
            close();
            return;
          }

          // biome-ignore lint/performance/noAwaitInLoops: Each poll advances one SSE cursor.
          const snapshot = await options.read(cursor);
          if (!snapshot || cancelled || abortController.signal.aborted) {
            close();
            return;
          }
          const { events, terminal: isTerminal } = snapshot;
          let latestEventId = cursor;
          for (const snapshotEvent of [...events].sort(
            (left, right) => left.id - right.id
          )) {
            if (snapshotEvent.id > latestEventId) {
              pending.push(snapshotEvent);
              latestEventId = snapshotEvent.id;
            }
          }
          terminal = isTerminal;
          if (pending.length > 0 || terminal) {
            continue;
          }

          const remainingIdleMs = idleTimeoutMs - (now() - lastActivityAt);
          if (remainingIdleMs <= 0) {
            close();
            return;
          }
          await sleep(
            Math.min(pollIntervalMs, remainingIdleMs),
            abortController.signal
          );
        }
        close();
      } catch (error) {
        if (cancelled || abortController.signal.aborted) {
          close();
        } else {
          fail(error);
        }
      }
    },
    start(streamController) {
      controllerRef = streamController;
      const onAbort = (): void => abort();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () =>
        options.signal?.removeEventListener("abort", onAbort);
      if (options.signal?.aborted) {
        abort();
      }
    },
  });
}
