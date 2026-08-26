import { createHmac } from "node:crypto";
import { requireNonemptyAbuseKeySecret } from "./config";

export { requireAbuseKeySecret } from "./config";

const REDIS_KEY_PREFIX = "coven:abuse:v1:";

const CONSUME_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
local pttlMs = redis.call("PTTL", KEYS[1])
return { count, pttlMs }
`.trim();

export type AbuseBudgetResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

export interface AbuseStore {
  consume: (
    key: string,
    limit: number,
    windowSeconds: number,
    nowMs?: number
  ) => Promise<AbuseBudgetResult>;
}

export interface RedisEvalExecutor {
  eval: (
    script: string,
    options: { arguments: string[]; keys: string[] }
  ) => Promise<unknown>;
}

export class RedisAbuseStore implements AbuseStore {
  private readonly executor: RedisEvalExecutor;
  private readonly keySecret: string;

  constructor(executor: RedisEvalExecutor, keySecret: string) {
    this.executor = executor;
    this.keySecret = requireNonemptyAbuseKeySecret(keySecret);
  }

  async consume(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<AbuseBudgetResult> {
    validateConsumeInput(key, limit, windowSeconds);

    const digest = createHmac("sha256", this.keySecret)
      .update(key)
      .digest("hex");
    const reply = await this.executor.eval(CONSUME_SCRIPT, {
      arguments: [String(windowSeconds)],
      keys: [`${REDIS_KEY_PREFIX}${digest}`],
    });
    const [count, pttlMs] = parseRedisReply(reply);

    return budgetResult(count, limit, Math.max(1, Math.ceil(pttlMs / 1000)));
  }
}

export class MemoryAbuseStore implements AbuseStore {
  private readonly budgets = new Map<
    string,
    { count: number; expiresAt: number }
  >();

  consume(
    key: string,
    limit: number,
    windowSeconds: number,
    nowMs = Date.now()
  ): Promise<AbuseBudgetResult> {
    try {
      validateConsumeInput(key, limit, windowSeconds);
      validateNow(nowMs);

      let budget = this.budgets.get(key);
      if (!budget || nowMs >= budget.expiresAt) {
        budget = {
          count: 0,
          expiresAt: nowMs + windowSeconds * 1000,
        };
        this.budgets.set(key, budget);
      }

      budget.count += 1;

      return Promise.resolve(
        budgetResult(
          budget.count,
          limit,
          Math.ceil((budget.expiresAt - nowMs) / 1000)
        )
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

function budgetResult(
  count: number,
  limit: number,
  retryAfterSeconds: number
): AbuseBudgetResult {
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    retryAfterSeconds,
  };
}

function parseRedisReply(reply: unknown): [number, number] {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error("Invalid Redis abuse budget reply.");
  }

  const [count, pttlMs] = reply;
  if (
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 1 ||
    typeof pttlMs !== "number" ||
    !Number.isInteger(pttlMs) ||
    pttlMs <= 0
  ) {
    throw new Error("Invalid Redis abuse budget reply.");
  }

  return [count, pttlMs];
}

function validateConsumeInput(
  key: string,
  limit: number,
  windowSeconds: number
): void {
  if (typeof key !== "string" || !key.trim()) {
    throw new TypeError("Abuse budget key must be nonempty.");
  }
  assertPositiveInteger(limit, "Abuse budget limit");
  assertPositiveInteger(windowSeconds, "Abuse budget windowSeconds");
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a finite positive integer.`);
  }
}

function validateNow(nowMs: number): void {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new TypeError("Abuse budget nowMs must be finite and nonnegative.");
  }
}
