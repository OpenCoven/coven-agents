import { createClient, type RedisClientOptions } from "redis";
import { requireAbuseKeySecret } from "./config";
import { abusePolicyFor } from "./policy";
import { type AbuseStore, MemoryAbuseStore, RedisAbuseStore } from "./store";
import type { AbuseRoute, AbuseSubject } from "./types";

const DEFAULT_CONNECT_TIMEOUT_MS = 1000;
const DEFAULT_CONSUME_TIMEOUT_MS = 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 750;

export type AbuseAdmission =
  | { kind: "allowed" }
  | { kind: "denied"; responseStatus: 429; retryAfterSeconds: number }
  | { kind: "unavailable"; responseStatus: 503 };

export type AbuseEnforcementInput = {
  /**
   * Refuse with 503 on a store failure instead of degrading to the memory
   * fallback. The auth wrapper sets this for OAuth starts and callbacks:
   * those flows carry replay protection, and serving them under a limiter
   * outage would let an outage disable the very control the limiter exists
   * to provide. Product routes leave it unset — for them, a limiter blip
   * degrades the limiter, never the product.
   */
  failClosed?: boolean;
  ip: string | null;
  route: AbuseRoute;
  store?: AbuseStore;
  tenant?: string;
  userId?: string;
};

type StoreProvider = () =>
  | AbuseStore
  | undefined
  | Promise<AbuseStore | undefined>;

export type TimeoutTimers = {
  clearTimeout: (timer: unknown) => void;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
};

export type RedisAdmissionClient = {
  readonly isReady: boolean;
  connect: () => Promise<unknown>;
  destroy: () => void;
  eval: (
    script: string,
    options: { arguments: string[]; keys: string[] }
  ) => Promise<unknown>;
  onError: (listener: (error: unknown) => void) => void;
};

type RedisStoreProviderOptions = {
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  createClient?: (options: RedisClientOptions) => RedisAdmissionClient;
  getConfiguration?: () => {
    keySecret: string | undefined;
    redisUrl: string | undefined;
  };
  timers?: TimeoutTimers;
};

const SYSTEM_TIMERS: TimeoutTimers = {
  clearTimeout: (timer) =>
    globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
};

export function createRedisStoreProvider(
  options: RedisStoreProviderOptions = {}
): StoreProvider {
  const commandTimeoutMs = positiveTimeout(
    options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    "Redis command timeout"
  );
  const connectTimeoutMs = positiveTimeout(
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    "Redis connect timeout"
  );
  const createRedisClient =
    options.createClient ?? createDefaultRedisAdmissionClient;
  const getConfiguration =
    options.getConfiguration ??
    (() => ({
      keySecret: process.env.ABUSE_KEY_SECRET,
      redisUrl: process.env.REDIS_URL,
    }));
  const timers = options.timers ?? SYSTEM_TIMERS;

  let redisClient: RedisAdmissionClient | null = null;
  let redisConnection: Promise<unknown> | null = null;
  let redisStore: AbuseStore | null = null;

  function resetClient(client: RedisAdmissionClient): void {
    if (redisClient !== client) {
      return;
    }

    redisClient = null;
    redisConnection = null;
    redisStore = null;
    try {
      client.destroy();
    } catch {
      // The state is already reset, so a transport cleanup error is non-actionable.
    }
  }

  return async () => {
    const { keySecret: configuredKeySecret, redisUrl } = getConfiguration();
    const keySecret = requireAbuseKeySecret(redisUrl, configuredKeySecret);
    if (!(redisUrl && keySecret)) {
      return;
    }

    if (!redisClient) {
      const nextClient = createRedisClient({
        disableOfflineQueue: true,
        socket: {
          connectTimeout: connectTimeoutMs,
          reconnectStrategy: false,
        },
        url: redisUrl,
      });
      nextClient.onError(() => undefined);

      redisClient = nextClient;
      redisStore = new RedisAbuseStore(
        {
          eval: async (script, evalOptions) => {
            try {
              return await withTimeout(
                Promise.resolve().then(() =>
                  nextClient.eval(script, evalOptions)
                ),
                commandTimeoutMs,
                timers,
                "Redis abuse command timed out."
              );
            } catch (error) {
              resetClient(nextClient);
              throw error;
            }
          },
        },
        keySecret
      );

      const connection = withTimeout(
        Promise.resolve().then(() => nextClient.connect()),
        connectTimeoutMs,
        timers,
        "Redis abuse connection timed out."
      ).catch((error: unknown) => {
        resetClient(nextClient);
        throw error;
      });
      redisConnection = connection;
    }

    const connection = redisConnection;
    const client = redisClient;
    await connection;

    if (!(client?.isReady && redisClient === client && redisStore)) {
      if (client) {
        resetClient(client);
      }
      throw new Error("Redis abuse connection is unavailable.");
    }

    return redisStore;
  };
}

export function createAbusePolicyEnforcer(input: {
  consumeTimeoutMs?: number;
  getStore: StoreProvider;
  isProduction: boolean;
  timers?: TimeoutTimers;
}): (request: AbuseEnforcementInput) => Promise<AbuseAdmission> {
  const consumeTimeoutMs = positiveTimeout(
    input.consumeTimeoutMs ?? DEFAULT_CONSUME_TIMEOUT_MS,
    "Abuse consume timeout"
  );
  const timers = input.timers ?? SYSTEM_TIMERS;

  /**
   * The store used while Redis is configured but not answering.
   *
   * Process-local, so its budgets are per-instance and reset on cold start —
   * degraded limiting, not none. The provider throws while its connection is
   * still coming up, on connect timeout, and on a dropped socket; treating
   * each of those as a 503 turned the limiter's own availability into the
   * product's, and every cold serverless boot answered its first requests
   * with an outage. A blip in the limiter degrades the limiter, never the
   * product.
   *
   * Deliberately NOT used when the provider returns `undefined`: that means
   * Redis is unconfigured, and production failing closed on missing
   * configuration is a decision this fallback must not quietly reverse.
   */
  const fallbackStore = new MemoryAbuseStore();

  return async (request) => {
    const policy = abusePolicyFor(request.route);
    const subjects = deriveSubjects(policy.subjects, request);
    if (!subjects) {
      return { kind: "unavailable", responseStatus: 503 };
    }

    let store: AbuseStore | undefined;
    try {
      store = request.store ?? (await input.getStore());
    } catch (error) {
      // Name only — a store error's message can carry the Redis URL, and the
      // URL carries a password. The name is enough to distinguish a connect
      // timeout from a refused socket, which is the diagnosis this log
      // exists for; tonight's sign-in outage was undiagnosable because this
      // catch was empty.
      console.error("Abuse store unavailable.", {
        name: error instanceof Error ? error.name : typeof error,
        stage: "provider",
      });
      if (request.failClosed) {
        return { kind: "unavailable", responseStatus: 503 };
      }
      store = fallbackStore;
    }

    if (!store) {
      return input.isProduction
        ? { kind: "unavailable", responseStatus: 503 }
        : { kind: "allowed" };
    }

    for (const subject of subjects) {
      try {
        const windows = [
          ["burst", policy.burst],
          ["sustained", policy.sustained],
        ] as const;
        // biome-ignore lint/performance/noAwaitInLoops: stop before consuming later subjects after denial
        const results = await withTimeout(
          Promise.all(
            windows.map(([windowName, window]) =>
              store.consume(
                `${request.route}:${windowName}:${subject.kind}:${subject.value}`,
                window.limit,
                window.windowSeconds
              )
            )
          ),
          consumeTimeoutMs,
          timers,
          "Abuse budget consumption timed out."
        );
        const denials = results.filter((result) => !result.allowed);

        if (denials.length > 0) {
          return {
            kind: "denied",
            responseStatus: 429,
            retryAfterSeconds: Math.max(
              ...denials.map((result) => result.retryAfterSeconds)
            ),
          };
        }
      } catch (error) {
        console.error("Abuse store unavailable.", {
          name: error instanceof Error ? error.name : typeof error,
          stage: "consume",
        });
        if (request.failClosed) {
          return { kind: "unavailable", responseStatus: 503 };
        }
        /**
         * The consume threw mid-request — a socket that dropped after the
         * store was handed out looks exactly like one that never connected.
         * Re-run this subject's windows against the memory fallback rather
         * than 503ing: the request stays limited, per-instance, and the
         * product stays up. Only the fallback itself failing reaches 503,
         * and the memory store has no I/O to fail on.
         */
        try {
          const windows = [
            ["burst", policy.burst],
            ["sustained", policy.sustained],
          ] as const;
          const results = await Promise.all(
            windows.map(([, window]) =>
              fallbackStore.consume(
                `${request.route}:${window.windowSeconds}:${subject.kind}:${subject.value}`,
                window.limit,
                window.windowSeconds
              )
            )
          );
          const denials = results.filter((result) => !result.allowed);
          if (denials.length > 0) {
            return {
              kind: "denied",
              responseStatus: 429,
              retryAfterSeconds: Math.max(
                ...denials.map((result) => result.retryAfterSeconds)
              ),
            };
          }
        } catch {
          return { kind: "unavailable", responseStatus: 503 };
        }
      }
    }

    return { kind: "allowed" };
  };
}

const getDefaultStore = createRedisStoreProvider();

const defaultEnforcer = createAbusePolicyEnforcer({
  getStore: getDefaultStore,
  isProduction: process.env.NODE_ENV === "production",
});

export function enforceAbusePolicy(
  input: AbuseEnforcementInput
): Promise<AbuseAdmission> {
  return defaultEnforcer(input);
}

export function abuseAdmissionResponse(
  admission: Exclude<AbuseAdmission, { kind: "allowed" }>
): Response {
  if (admission.kind === "denied") {
    return Response.json(
      {
        error: "rate_limited",
        message: "Too many requests. Try again later.",
      },
      {
        headers: {
          "cache-control": "no-store",
          "retry-after": String(admission.retryAfterSeconds),
        },
        status: admission.responseStatus,
      }
    );
  }

  return Response.json(
    {
      error: "abuse_control_unavailable",
      message: "Please try again later.",
    },
    {
      headers: { "cache-control": "no-store" },
      status: admission.responseStatus,
    }
  );
}

function deriveSubjects(
  required: readonly AbuseSubject[],
  input: AbuseEnforcementInput
): { kind: AbuseSubject; value: string }[] | null {
  const values: Record<AbuseSubject, string | undefined> = {
    ip: input.ip?.trim() || "unknown",
    tenant: input.tenant?.trim(),
    user: input.userId?.trim(),
  };

  const subjects: { kind: AbuseSubject; value: string }[] = [];
  for (const kind of required) {
    const value = values[kind];
    if (!value) {
      return null;
    }
    subjects.push({ kind, value });
  }

  return subjects;
}

function createDefaultRedisAdmissionClient(
  options: RedisClientOptions
): RedisAdmissionClient {
  const client = createClient(options);

  return {
    connect: () => client.connect(),
    destroy: () => client.destroy(),
    eval: (script, evalOptions) => client.eval(script, evalOptions),
    get isReady() {
      return client.isReady;
    },
    onError: (listener) => {
      client.on("error", listener);
    },
  };
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite positive integer.`);
  }
  return value;
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timers: TimeoutTimers,
  message: string
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = timers.setTimeout(
      () => reject(new Error(message)),
      timeoutMs
    );

    operation.then(
      (value) => {
        timers.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        timers.clearTimeout(timer);
        reject(error);
      }
    );
  });
}
