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
  createdAt: number;
  id: string;
  metadata?: Record<string, unknown> | null;
  name: string;
  recoveryReason: "interrupted";
  snapshot: unknown | null;
  status?:
    | "pending"
    | "running"
    | "completed"
    | "aborted"
    | "interrupted"
    | "error";
};

export type FiberRecoveryResult = {
  error?: unknown;
  reason?: string;
  snapshot?: unknown;
  status: "completed" | "error" | "aborted" | "interrupted";
};

export type StartedFiber = {
  key: string;
  name: string;
};

export type FiberContext = {
  id: string;
  signal: AbortSignal;
  snapshot: unknown | null;
  stash: (data: unknown) => void;
};

/** Recorded across all instances so a test can assert on dispatch. */
export const fiberLog: {
  cancelled: { key: string; reason?: string }[];
  started: StartedFiber[];
} = { cancelled: [], started: [] };

export function resetFiberLog(): void {
  fiberLog.cancelled = [];
  fiberLog.started = [];
  activeFibers.clear();
}

/** When false, `startFiber` records the dispatch without running the work. */
export const fiberControl = { runFibers: true };
const activeFibers = new Map<
  string,
  { controller: AbortController; fiberId: string }
>();

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
    activeFibers.get(idempotencyKey)?.controller.abort(reason);
    return Promise.resolve(true);
  }

  onFiberRecovered(
    _context: FiberRecoveryContext
  ): Promise<undefined | FiberRecoveryResult> {
    return Promise.resolve(undefined);
  }

  setState(state: State): void {
    this.#state = state;
  }

  async startFiber(
    name: string,
    fn: (context: FiberContext) => Promise<void>,
    options?: {
      fiberId?: string;
      idempotencyKey?: string;
      metadata?: Record<string, unknown>;
      waitForCompletion?: boolean;
    }
  ): Promise<{
    accepted: boolean;
    status: "pending" | "running" | "completed" | "error";
  }> {
    const key = options?.idempotencyKey ?? "";
    if (activeFibers.has(key)) {
      return { accepted: false, status: "running" };
    }
    fiberLog.started.push({ key, name });
    const controller = new AbortController();
    const fiberId = `fiber:${key}`;
    activeFibers.set(key, { controller, fiberId });
    if (fiberControl.runFibers) {
      try {
        await fn({
          id: fiberId,
          signal: controller.signal,
          snapshot: null,
          stash: () => undefined,
        });
      } catch {
        activeFibers.delete(key);
        return { accepted: true, status: "error" };
      }
      activeFibers.delete(key);
      return { accepted: true, status: "completed" };
    }
    return { accepted: true, status: "running" };
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
