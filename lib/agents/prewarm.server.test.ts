import assert from "node:assert/strict";
import test from "node:test";
import { prewarmTenantSandbox } from "./prewarm.server";

const USER_ID = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
const FUTURE = new Date(Date.now() + 86_400_000);

async function signingKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  return Buffer.from(raw).toString("base64url");
}

type Recorded = { headers: Record<string, string>; url: string };

function recordingFetch(calls: Recorded[]): typeof fetch {
  return ((url: string, init?: RequestInit) => {
    calls.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      url,
    });
    return Promise.resolve(new Response(null, { status: 202 }));
  }) as typeof fetch;
}

async function withEnv(
  env: Record<string, string | undefined>,
  run: () => Promise<void>
): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(env)) {
    saved.set(name, process.env[name]);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("a subscriber's sign-in warms through the prewarm route", async () => {
  const calls: Recorded[] = [];
  await withEnv(
    {
      AGENT_CONTROL_TOKEN: "control-token",
      CLOUD_RUNNER_URL: "https://runner.test/",
      RUNNER_SIGNING_KEY: await signingKey(),
    },
    async () => {
      await prewarmTenantSandbox(
        { id: USER_ID, subscribedUntil: FUTURE },
        recordingFetch(calls)
      );
    }
  );

  assert.equal(calls.length, 1);
  const [request] = calls;
  assert.ok(request);
  // Trailing slash stripped, so the endpoint join cannot double it.
  assert.equal(request.url, "https://runner.test/api/tenant/prewarm");
  assert.equal(request.headers["x-runner-token"], "control-token");
  assert.match(request.headers.authorization ?? "", /^Bearer .+/);
});

test("a lapsed subscription warms nothing and touches no network", async () => {
  const calls: Recorded[] = [];
  await withEnv(
    {
      AGENT_CONTROL_TOKEN: "control-token",
      CLOUD_RUNNER_URL: "https://runner.test",
      RUNNER_SIGNING_KEY: await signingKey(),
    },
    async () => {
      await prewarmTenantSandbox(
        { id: USER_ID, subscribedUntil: new Date(Date.now() - 1000) },
        recordingFetch(calls)
      );
      await prewarmTenantSandbox(
        { id: USER_ID, subscribedUntil: null },
        recordingFetch(calls)
      );
    }
  );

  assert.deepEqual(calls, []);
});

test("missing configuration skips the warm instead of throwing", async () => {
  const calls: Recorded[] = [];
  await withEnv(
    {
      AGENT_CONTROL_TOKEN: undefined,
      CLOUD_RUNNER_URL: undefined,
      NEXT_PUBLIC_CLOUD_RUNNER_URL: undefined,
      RUNNER_SIGNING_KEY: undefined,
    },
    async () => {
      await prewarmTenantSandbox(
        { id: USER_ID, subscribedUntil: FUTURE },
        recordingFetch(calls)
      );
    }
  );

  assert.deepEqual(calls, []);
});

test("every failure inside the warm is swallowed", async () => {
  // Sign-in must never inherit the warmer's problems: a throwing transport
  // and a non-uuid user id both resolve silently.
  await withEnv(
    {
      AGENT_CONTROL_TOKEN: "control-token",
      CLOUD_RUNNER_URL: "https://runner.test",
      RUNNER_SIGNING_KEY: await signingKey(),
    },
    async () => {
      await prewarmTenantSandbox(
        { id: USER_ID, subscribedUntil: FUTURE },
        (() =>
          Promise.reject(new Error("socket closed"))) as unknown as typeof fetch
      );
      await prewarmTenantSandbox(
        { id: "not-a-uuid", subscribedUntil: FUTURE },
        recordingFetch([])
      );
    }
  );
});
