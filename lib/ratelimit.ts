import { createClient } from "redis";

import { requireAbuseKeySecret } from "@/lib/abuse/config";
import { type AbuseStore, RedisAbuseStore } from "@/lib/abuse/store";
import { isProductionEnvironment } from "@/lib/constants";
import { ChatbotError } from "@/lib/errors";

const MAX_MESSAGES = 10;
const TTL_SECONDS = 60 * 60;

let client: { readonly isReady: boolean } | null = null;
let store: AbuseStore | null = null;

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
    store = new RedisAbuseStore(
      {
        eval: (script, options) => nextClient.eval(script, options),
      },
      keySecret
    );

    nextClient.connect().catch(() => {
      if (client === nextClient) {
        client = null;
        store = null;
      }
    });
  }

  return client?.isReady ? (store ?? undefined) : undefined;
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
