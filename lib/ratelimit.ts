import { createClient } from "redis";

import { requireAbuseKeySecret } from "@/lib/abuse/config";
import {
  type AbuseStore,
  MemoryAbuseStore,
  RedisAbuseStore,
} from "@/lib/abuse/store";
import { isProductionEnvironment } from "@/lib/constants";
import { ChatbotError } from "@/lib/errors";

const MAX_MESSAGES = 10;
const TTL_SECONDS = 60 * 60;

let client: { readonly isReady: boolean } | null = null;
let store: AbuseStore | null = null;

/**
 * The store used while Redis is configured but not answering.
 *
 * Process-local, so its budgets are per-instance and reset on cold start —
 * degraded limiting, not none. It exists because the alternative was observed
 * in production: `getStore` returned `undefined` whenever `client.isReady` was
 * false, and the enforcement layer treats "configured but no store" in
 * production as a 503. node-redis connects asynchronously, so every cold
 * serverless boot answered its first requests with 503 — the admission layer
 * turning its own connection latency into an outage. A blip in the limiter's
 * backing store should degrade the limiter, never the product.
 */
const fallbackStore = new MemoryAbuseStore();

/**
 * How long Redis gets to answer before the memory fallback does.
 *
 * Deliberately below the enforcement layer's own consume timeout (1000ms):
 * node-redis queues commands while a connection is coming up rather than
 * rejecting them, so a not-ready client hangs instead of throwing — and a hang
 * that outlives the enforcement timeout is a 503, the exact outcome this store
 * exists to prevent. Racing at 400ms means the fallback always answers first.
 */
const REDIS_ANSWER_DEADLINE_MS = 400;

/**
 * Tries Redis first and falls back to the in-memory store when the attempt
 * throws or stalls — a connection that dropped mid-request, one that never
 * came up, and one still queueing offline all deserve degradation rather than
 * a 503 from the enforcement layer's catch.
 */
export class ResilientAbuseStore implements AbuseStore {
  private readonly primary: AbuseStore;
  private readonly deadlineMs: number;

  constructor(primary: AbuseStore, deadlineMs = REDIS_ANSWER_DEADLINE_MS) {
    this.primary = primary;
    this.deadlineMs = deadlineMs;
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<Awaited<ReturnType<AbuseStore["consume"]>>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.primary.consume(key, limit, windowSeconds),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Redis did not answer inside the deadline."));
          }, this.deadlineMs);
        }),
      ]);
    } catch {
      return await fallbackStore.consume(key, limit, windowSeconds);
    } finally {
      clearTimeout(timer);
    }
  }
}

function getStore(): AbuseStore | undefined {
  const redisUrl = process.env.REDIS_URL;
  const keySecret = requireAbuseKeySecret(
    redisUrl,
    process.env.ABUSE_KEY_SECRET
  );
  if (!redisUrl || !keySecret) {
    return undefined;
  }

  if (!client) {
    const nextClient = createClient({ url: redisUrl });
    nextClient.on("error", () => undefined);

    client = nextClient;
    store = new ResilientAbuseStore(
      new RedisAbuseStore(
        {
          eval: (script, options) => nextClient.eval(script, options),
        },
        keySecret
      )
    );

    nextClient.connect().catch(() => {
      if (client === nextClient) {
        client = null;
        store = null;
      }
    });
  }

  // Not gated on `isReady`. Redis is configured, so admission must happen —
  // the resilient store reaches Redis when it answers and the memory fallback
  // when it does not, and an unready connection is the fallback's whole
  // reason to exist.
  return store ?? fallbackStore;
}

export function createRateLimitChecker(input: {
  getStore: () => AbuseStore | undefined;
  isProduction: boolean;
}): (ip: string | undefined) => Promise<void> {
  return async (ip: string | undefined): Promise<void> => {
    if (!input.isProduction || !ip) {
      return;
    }

    const abuseStore = input.getStore();
    if (!abuseStore) {
      return;
    }

    try {
      const result = await abuseStore.consume(
        `chat:ip:${ip}`,
        MAX_MESSAGES,
        TTL_SECONDS
      );

      if (!result.allowed) {
        throw new ChatbotError("rate_limit:chat");
      }
    } catch (error) {
      if (error instanceof ChatbotError) {
        throw error;
      }
    }
  };
}

const defaultCheckRateLimit = createRateLimitChecker({
  getStore,
  isProduction: isProductionEnvironment,
});

export function checkRateLimit(ip: string | undefined): Promise<void> {
  return defaultCheckRateLimit(ip);
}

export const checkIpRateLimit = checkRateLimit;
