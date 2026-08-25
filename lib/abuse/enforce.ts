import { createClient } from "redis";
import { requireAbuseKeySecret } from "./config";
import { abusePolicyFor } from "./policy";
import { type AbuseStore, RedisAbuseStore } from "./store";
import type { AbuseRoute, AbuseSubject } from "./types";

export type AbuseAdmission =
  | { kind: "allowed" }
  | { kind: "denied"; responseStatus: 429; retryAfterSeconds: number }
  | { kind: "unavailable"; responseStatus: 503 };

export type AbuseEnforcementInput = {
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

let redisClient: { readonly isReady: boolean } | null = null;
let redisConnection: Promise<unknown> | null = null;
let redisStore: AbuseStore | null = null;

async function getDefaultStore(): Promise<AbuseStore | undefined> {
  const redisUrl = process.env.REDIS_URL;
  const keySecret = requireAbuseKeySecret(
    redisUrl,
    process.env.ABUSE_KEY_SECRET
  );
  if (!(redisUrl && keySecret)) {
    return undefined;
  }

  if (!redisClient) {
    const nextClient = createClient({ url: redisUrl });
    nextClient.on("error", () => undefined);

    redisClient = nextClient;
    redisStore = new RedisAbuseStore(
      {
        eval: (script, options) => nextClient.eval(script, options),
      },
      keySecret
    );
    redisConnection = nextClient.connect().catch((error: unknown) => {
      if (redisClient === nextClient) {
        redisClient = null;
        redisConnection = null;
        redisStore = null;
      }
      throw error;
    });
  }

  await redisConnection;
  return redisClient?.isReady ? (redisStore ?? undefined) : undefined;
}

export function createAbusePolicyEnforcer(input: {
  getStore: StoreProvider;
  isProduction: boolean;
}): (request: AbuseEnforcementInput) => Promise<AbuseAdmission> {
  return async (request) => {
    const policy = abusePolicyFor(request.route);
    const subjects = deriveSubjects(policy.subjects, request);
    if (!subjects) {
      return { kind: "unavailable", responseStatus: 503 };
    }

    let store: AbuseStore | undefined;
    try {
      store = request.store ?? (await input.getStore());
    } catch {
      return { kind: "unavailable", responseStatus: 503 };
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
        const results = await Promise.all(
          windows.map(([windowName, window]) =>
            store.consume(
              `${request.route}:${windowName}:${subject.kind}:${subject.value}`,
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

    return { kind: "allowed" };
  };
}

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
