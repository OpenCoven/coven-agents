import type { RunEvent } from "@opencoven/agent-contracts";

export type RunEventSnapshot = {
  events: RunEvent[];
  terminal: boolean;
};

export type RunEventWriter = {
  end: () => void;
  write: (chunk: string) => unknown;
};

type Subscription = {
  cursor: number;
  writer: RunEventWriter;
};

function serializeEvent(event: RunEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class RunEventBroker {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly subscribers = new Map<string, Set<Subscription>>();

  async subscribe(
    runId: string,
    lastEventId: number,
    read: () => Promise<RunEventSnapshot>,
    writer: RunEventWriter
  ): Promise<void> {
    await this.serialize(runId, async () => {
      const snapshot = await read();
      const subscription: Subscription = {
        cursor: lastEventId,
        writer,
      };
      this.deliver(subscription, snapshot.events);
      if (snapshot.terminal) {
        writer.end();
        return;
      }
      const listeners = this.subscribers.get(runId) ?? new Set<Subscription>();
      listeners.add(subscription);
      this.subscribers.set(runId, listeners);
    });
  }

  update<T>(
    runId: string,
    change: () => Promise<{
      events: RunEvent[];
      terminal: boolean;
      value: T;
    }>
  ): Promise<T> {
    return this.serialize(runId, async () => {
      const result = await change();
      const listeners = this.subscribers.get(runId);
      if (!listeners) {
        return result.value;
      }
      for (const subscription of listeners) {
        this.deliver(subscription, result.events);
        if (result.terminal) {
          subscription.writer.end();
          listeners.delete(subscription);
        }
      }
      if (listeners.size === 0) {
        this.subscribers.delete(runId);
      }
      return result.value;
    });
  }

  unsubscribe(runId: string, writer: RunEventWriter): void {
    const listeners = this.subscribers.get(runId);
    if (!listeners) {
      return;
    }
    for (const subscription of listeners) {
      if (subscription.writer === writer) {
        listeners.delete(subscription);
      }
    }
    if (listeners.size === 0) {
      this.subscribers.delete(runId);
    }
  }

  private deliver(subscription: Subscription, events: RunEvent[]): void {
    for (const event of events) {
      if (event.id <= subscription.cursor) {
        continue;
      }
      subscription.writer.write(serializeEvent(event));
      subscription.cursor = event.id;
    }
  }

  private serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(operation);
    const settled = queued.then(
      () => undefined,
      () => undefined
    );
    this.queues.set(runId, settled);
    return queued.finally(() => {
      if (this.queues.get(runId) === settled) {
        this.queues.delete(runId);
      }
    });
  }
}
