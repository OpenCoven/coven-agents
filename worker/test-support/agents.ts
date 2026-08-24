/**
 * Stand-in for the `agents` package. The real one imports `cloudflare:workers`,
 * which plain Node cannot resolve, so importing anything from `agents.ts` under
 * `tsx --test` fails before a single test runs.
 *
 * This is deliberately more than an empty shell: `startFiber` actually invokes
 * the work it is given, so the asynchronous run path is exercised rather than
 * merely type-checked. Tests that want to observe a queued-but-unfinished run
 * pass `runFibers: false`.
 */

export type FiberRecoveryContext = {
  metadata?: Record<string, unknown> | null;
  name: string;
  snapshot: unknown | null;
};

export type FiberRecoveryResult = {
  error?: string;
  snapshot?: unknown;
  status: "completed" | "error";
};

export type StartedFiber = {
  key: string;
  name: string;
};

/** Recorded across all instances so a test can assert on dispatch. */
export const fiberLog: {
  cancelled: { key: string; reason?: string }[];
  started: StartedFiber[];
} = { cancelled: [], started: [] };

export function resetFiberLog(): void {
  fiberLog.cancelled = [];
  fiberLog.started = [];
}

/** When false, `startFiber` records the dispatch without running the work. */
export const fiberControl = { runFibers: true };

export class Agent<Environment, State> {
  env: Environment;
  initialState!: State;
  #state: State | undefined;

  constructor(_state?: unknown, environment?: Environment) {
    this.env = environment as Environment;
  }

  /**
   * Falls back to `initialState` rather than being assigned in the
   * constructor: a subclass sets `initialState` as a field initializer, which
   * runs after `super()`, so reading it eagerly here would always see
   * undefined.
   */
  get state(): State {
    return this.#state ?? this.initialState;
  }

  set state(value: State) {
    this.#state = value;
  }

  cancelFiberByKey(idempotencyKey: string, reason?: string): Promise<boolean> {
    fiberLog.cancelled.push({ key: idempotencyKey, reason });
    return Promise.resolve(true);
  }

  setState(state: State): void {
    this.#state = state;
  }

  async startFiber(
    name: string,
    fn: () => Promise<void>,
    options?: { idempotencyKey?: string }
  ): Promise<{ accepted: boolean }> {
    fiberLog.started.push({ key: options?.idempotencyKey ?? "", name });
    if (fiberControl.runFibers) {
      await fn();
    }
    return { accepted: true };
  }
}

const directory = {
  syncRuns(): Promise<void> {
    return Promise.resolve();
  },
  upsert<T>(value: T): Promise<T> {
    return Promise.resolve(value);
  },
};

export function getAgentByName<T>(): Promise<T> {
  return Promise.resolve(directory as T);
}
