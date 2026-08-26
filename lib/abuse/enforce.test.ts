import assert from "node:assert/strict";
import test from "node:test";
import {
  abuseAdmissionResponse,
  createAbusePolicyEnforcer,
  createRedisStoreProvider,
  enforceAbusePolicy,
} from "./enforce";
import type { AbuseStore, RedisEvalExecutor } from "./store";

const FIXED_SECRET = "fixed-test-abuse-key-secret";

test("missing IPs share one unknown bucket", async () => {
  const store = new RecordingStore();

  assert.deepEqual(
    await enforceAbusePolicy({
      ip: null,
      route: "checkout",
      store,
      userId: "user-1",
    }),
    { kind: "allowed" }
  );

  assert.deepEqual(store.calls, [
    ["checkout:burst:ip:unknown", 2, 300],
    ["checkout:sustained:ip:unknown", 3, 3600],
    ["checkout:burst:user:user-1", 2, 300],
    ["checkout:sustained:user:user-1", 3, 3600],
  ]);
});

test("every required subject consumes burst and sustained budgets", async () => {
  const store = new RecordingStore();

  assert.deepEqual(
    await enforceAbusePolicy({
      ip: "203.0.113.4",
      route: "internal_credential",
      store,
      tenant: "tenant-1",
    }),
    { kind: "allowed" }
  );

  assert.deepEqual(store.calls, [
    ["internal_credential:burst:ip:203.0.113.4", 10, 60],
    ["internal_credential:sustained:ip:203.0.113.4", 60, 3600],
    ["internal_credential:burst:tenant:tenant-1", 10, 60],
    ["internal_credential:sustained:tenant:tenant-1", 60, 3600],
  ]);
});

test("denials stop after one subject and return its maximum retry", async () => {
  const store = new RecordingStore((key) => ({
    allowed: false,
    remaining: 0,
    retryAfterSeconds: key.includes(":sustained:") ? 300 : 45,
  }));

  assert.deepEqual(
    await enforceAbusePolicy({
      ip: "203.0.113.4",
      route: "checkout",
      store,
      userId: "user-1",
    }),
    {
      kind: "denied",
      responseStatus: 429,
      retryAfterSeconds: 300,
    }
  );
  assert.deepEqual(store.calls, [
    ["checkout:burst:ip:203.0.113.4", 2, 300],
    ["checkout:sustained:ip:203.0.113.4", 3, 3600],
  ]);
});

test("missing required identity is explicitly unavailable", async () => {
  const store = new RecordingStore();

  assert.deepEqual(
    await enforceAbusePolicy({
      ip: "203.0.113.4",
      route: "checkout",
      store,
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
  assert.equal(store.calls.length, 0);
});

test("production store configuration and consume outages fail closed", async () => {
  const configurationFailure = createAbusePolicyEnforcer({
    getStore: () => {
      throw new Error("secret configuration leaked");
    },
    isProduction: true,
  });
  const consumeFailure: AbuseStore = {
    consume: () => Promise.reject(new Error("redis details leaked")),
  };

  assert.deepEqual(
    await configurationFailure({
      ip: "203.0.113.4",
      route: "checkout",
      userId: "user-1",
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
  assert.deepEqual(
    await configurationFailure({
      ip: "203.0.113.4",
      route: "checkout",
      store: consumeFailure,
      userId: "user-1",
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
});

test("rejected Redis connects destroy cached state and retry with bounded client options", async () => {
  const firstClient = new FakeRedisClient({
    connect: () => Promise.reject(new Error("connect failed")),
  });
  const secondClient = new FakeRedisClient();
  const clients = [firstClient, secondClient];
  const clientOptions: unknown[] = [];
  const provider = createRedisStoreProvider({
    connectTimeoutMs: 25,
    createClient: (options) => {
      clientOptions.push(options);
      const client = clients.shift();
      assert.ok(client);
      return client;
    },
    getConfiguration: () => ({
      keySecret: FIXED_SECRET,
      redisUrl: "redis://localhost:6379",
    }),
  });
  const enforcer = createAbusePolicyEnforcer({
    getStore: provider,
    isProduction: true,
  });

  assert.deepEqual(
    await enforcer({
      ip: "203.0.113.4",
      route: "model_list",
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
  assert.equal(firstClient.destroyCalls, 1);

  assert.deepEqual(
    await enforcer({
      ip: "203.0.113.4",
      route: "model_list",
    }),
    { kind: "allowed" }
  );
  assert.equal(secondClient.connectCalls, 1);
  assert.equal(clientOptions.length, 2);
  assert.deepEqual(clientOptions[0], {
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 25,
      reconnectStrategy: false,
    },
    url: "redis://localhost:6379",
  });
});

test("never-resolving Redis connects return unavailable through an injected timeout", async () => {
  const timers = fakeTimers();
  const client = new FakeRedisClient({
    connect: () => new Promise(() => undefined),
  });
  const provider = createRedisStoreProvider({
    connectTimeoutMs: 25,
    createClient: () => client,
    getConfiguration: () => ({
      keySecret: FIXED_SECRET,
      redisUrl: "redis://localhost:6379",
    }),
    timers: timers.api,
  });
  const enforcer = createAbusePolicyEnforcer({
    getStore: provider,
    isProduction: true,
  });

  const admission = enforcer({
    ip: "203.0.113.4",
    route: "model_list",
  });

  assert.deepEqual(timers.pendingDelays(), [25]);
  timers.runNext();
  assert.deepEqual(await admission, {
    kind: "unavailable",
    responseStatus: 503,
  });
  assert.equal(client.destroyCalls, 1);
});

test("never-resolving consumes return unavailable through an injected timeout", async () => {
  const timers = fakeTimers();
  const client = new FakeRedisClient({
    eval: () => new Promise(() => undefined),
  });
  const provider = createRedisStoreProvider({
    commandTimeoutMs: 25,
    createClient: () => client,
    getConfiguration: () => ({
      keySecret: FIXED_SECRET,
      redisUrl: "redis://localhost:6379",
    }),
    timers: timers.api,
  });
  const enforcer = createAbusePolicyEnforcer({
    consumeTimeoutMs: 50,
    getStore: provider,
    isProduction: true,
    timers: timers.api,
  });

  const admission = enforcer({
    ip: "203.0.113.4",
    route: "model_list",
  });

  await flushMicrotasks();
  assert.deepEqual(timers.pendingDelays(), [25, 25, 50]);
  timers.runNext();
  assert.deepEqual(await admission, {
    kind: "unavailable",
    responseStatus: 503,
  });
  assert.equal(client.destroyCalls, 1);

  timers.runNext();
  await flushMicrotasks();
  assert.deepEqual(timers.pendingDelays(), []);
});

test("rejected Redis commands destroy cached state before reconnecting", async () => {
  const firstClient = new FakeRedisClient({
    eval: () => Promise.reject(new Error("eval failed")),
  });
  const secondClient = new FakeRedisClient();
  const clients = [firstClient, secondClient];
  const provider = createRedisStoreProvider({
    createClient: () => {
      const client = clients.shift();
      assert.ok(client);
      return client;
    },
    getConfiguration: () => ({
      keySecret: FIXED_SECRET,
      redisUrl: "redis://localhost:6379",
    }),
  });
  const enforcer = createAbusePolicyEnforcer({
    getStore: provider,
    isProduction: true,
  });

  assert.deepEqual(
    await enforcer({
      ip: "203.0.113.4",
      route: "model_list",
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
  assert.equal(firstClient.destroyCalls, 1);

  assert.deepEqual(
    await enforcer({
      ip: "203.0.113.4",
      route: "model_list",
    }),
    { kind: "allowed" }
  );
  assert.equal(secondClient.connectCalls, 1);
});

test("development without configured Redis explicitly allows requests", async () => {
  let storeRequests = 0;
  const developmentEnforcer = createAbusePolicyEnforcer({
    getStore: (): undefined => {
      storeRequests += 1;
    },
    isProduction: false,
  });

  assert.deepEqual(
    await developmentEnforcer({
      ip: "203.0.113.4",
      route: "checkout",
      userId: "user-1",
    }),
    { kind: "allowed" }
  );
  assert.equal(storeRequests, 1);
});

test("production without configured Redis fails closed", async () => {
  const productionEnforcer = createAbusePolicyEnforcer({
    getStore: () => undefined,
    isProduction: true,
  });

  assert.deepEqual(
    await productionEnforcer({
      ip: "203.0.113.4",
      route: "checkout",
      userId: "user-1",
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
});

test("rate-limit responses are generic and non-cacheable", async () => {
  const response = abuseAdmissionResponse({
    kind: "denied",
    responseStatus: 429,
    retryAfterSeconds: 300,
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "300");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "rate_limited",
    message: "Too many requests. Try again later.",
  });
});

test("unavailable responses hide limiter internals", async () => {
  const response = abuseAdmissionResponse({
    kind: "unavailable",
    responseStatus: 503,
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "abuse_control_unavailable",
    message: "Please try again later.",
  });
});

class RecordingStore implements AbuseStore {
  readonly calls: [string, number, number][] = [];
  private readonly result: (
    key: string
  ) => Awaited<ReturnType<AbuseStore["consume"]>>;

  constructor(
    result: (
      key: string
    ) => Awaited<ReturnType<AbuseStore["consume"]>> = () => ({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 60,
    })
  ) {
    this.result = result;
  }

  consume(
    key: string,
    limit: number,
    windowSeconds: number
  ): ReturnType<AbuseStore["consume"]> {
    this.calls.push([key, limit, windowSeconds]);
    return Promise.resolve(this.result(key));
  }
}

type Timer = {
  callback: () => void;
  cancelled: boolean;
  delayMs: number;
};

function fakeTimers() {
  const queue: Timer[] = [];

  return {
    api: {
      clearTimeout(timer: unknown) {
        (timer as Timer).cancelled = true;
      },
      setTimeout(callback: () => void, delayMs: number) {
        const timer = { callback, cancelled: false, delayMs };
        queue.push(timer);
        return timer;
      },
    },
    pendingDelays() {
      return queue
        .filter((timer) => !timer.cancelled)
        .map((timer) => timer.delayMs);
    },
    runNext() {
      const timer = queue.find((candidate) => !candidate.cancelled);
      assert.ok(timer, "expected a pending timer");
      timer.cancelled = true;
      timer.callback();
    },
  };
}

function flushMicrotasks(remaining = 8): Promise<void> {
  if (remaining === 0) {
    return Promise.resolve();
  }
  return Promise.resolve().then(() => flushMicrotasks(remaining - 1));
}

class FakeRedisClient implements RedisEvalExecutor {
  connectCalls = 0;
  destroyCalls = 0;
  isReady = false;
  private readonly connectResult: () => Promise<unknown>;
  private readonly evalResult: () => Promise<unknown>;

  constructor(
    options: {
      connect?: () => Promise<unknown>;
      eval?: () => Promise<unknown>;
    } = {}
  ) {
    this.connectResult =
      options.connect ??
      (() => {
        this.isReady = true;
        return Promise.resolve();
      });
    this.evalResult = options.eval ?? (() => Promise.resolve([1, 60_000]));
  }

  connect(): Promise<unknown> {
    this.connectCalls += 1;
    return this.connectResult().then((result) => {
      this.isReady = true;
      return result;
    });
  }

  destroy(): void {
    this.destroyCalls += 1;
    this.isReady = false;
  }

  eval(
    _script: string,
    _options: { arguments: string[]; keys: string[] }
  ): Promise<unknown> {
    return this.evalResult();
  }

  onError(_listener: (error: unknown) => void): void {
    // Tests intentionally swallow the same error event the production adapter does.
  }
}
