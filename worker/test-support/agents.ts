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

  async cancelFiberByKey(): Promise<boolean> {
    return true;
  }

  setState(state: State): void {
    this.state = state;
  }

  async startFiber(): Promise<{ accepted: boolean }> {
    return { accepted: true };
  }
}

const directory = {
  async syncRuns(): Promise<void> {},
  async upsert<T>(value: T): Promise<T> {
    return value;
  },
};

export async function getAgentByName<T>(): Promise<T> {
  return directory as T;
}
