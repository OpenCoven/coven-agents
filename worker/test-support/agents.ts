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

export class Agent<Environment, State> {
  env: Environment;
  initialState!: State;
  state: State;

  constructor(_state?: unknown, environment?: Environment) {
    this.env = environment as Environment;
    this.state = {} as State;
  }

  cancelFiberByKey(): Promise<boolean> {
    return Promise.resolve(true);
  }

  setState(state: State): void {
    this.state = state;
  }

  startFiber(): Promise<{ accepted: boolean }> {
    return Promise.resolve({ accepted: true });
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
