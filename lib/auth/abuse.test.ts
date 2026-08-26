import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { type AbuseStore, MemoryAbuseStore } from "@/lib/abuse/store";
import { authAbuseRoute, withAuthAbusePolicy } from "./abuse";

const TEST_ORIGIN = "https://coven.test";

test("classifies only Auth.js OAuth initiation and callback methods", () => {
  const cases = [
    ["GET", "/api/auth/signin", null],
    ["GET", "/api/auth/signin/", null],
    ["GET", "/api/auth/signin/github", null],
    ["GET", "/api/auth/signin/github/", null],
    ["POST", "/api/auth/signin", "auth_start"],
    ["POST", "/api/auth/signin/", "auth_start"],
    ["POST", "/api/auth/signin/github", "auth_start"],
    ["POST", "/api/auth/signin/github/", "auth_start"],
    ["GET", "/api/auth/callback/github", "auth_callback"],
    ["GET", "/api/auth/callback/github/", "auth_callback"],
    ["POST", "/api/auth/callback/github", "auth_callback"],
    ["POST", "/api/auth/callback/github/", "auth_callback"],
    ["PUT", "/api/auth/callback/github", null],
    ["GET", "/api/auth/session", null],
    ["POST", "/api/auth/session/", null],
    ["GET", "/api/auth/csrf", null],
    ["GET", "/api/auth/providers", null],
    ["GET", "/api/auth/error", null],
    ["GET", "/api/auth/verify-request", null],
    ["POST", "/api/auth/signout", null],
    ["GET", "/api/auth/signout/github", null],
    ["GET", "/api/auth/callback", null],
    ["POST", "/api/auth/not-signin/github", null],
    ["GET", "/login", null],
  ] as const;

  for (const [method, pathname, expected] of cases) {
    assert.equal(
      authAbuseRoute(method, pathname),
      expected,
      `${method} ${pathname}`
    );
  }
});

test("classifies OAuth routes beneath the configured base path", () => {
  assert.equal(
    authAbuseRoute("POST", "/demo/api/auth/signin/github", "/demo"),
    "auth_start"
  );
  assert.equal(
    authAbuseRoute("GET", "/demo/api/auth/callback/github", "/demo"),
    "auth_callback"
  );
  assert.equal(authAbuseRoute("GET", "/demo/api/auth/session", "/demo"), null);
});

test("the wrapper enforces OAuth limits beneath the configured base path", async () => {
  const consumedKeys: string[] = [];
  const store: AbuseStore = {
    consume(key, limit, windowSeconds) {
      consumedKeys.push(`${key}:${limit}:${windowSeconds}`);
      return Promise.resolve({
        allowed: true,
        remaining: limit - 1,
        retryAfterSeconds: windowSeconds,
      });
    },
  };
  const wrapped = withAuthAbusePolicy(
    () => new Response(null, { status: 204 }),
    { basePath: "/demo", store }
  );

  const response = await wrapped(
    authRequest("/demo/api/auth/signin/github", "POST")
  );

  assert.equal(response.status, 204);
  assert.equal(consumedKeys.length, 2);
  assert.ok(consumedKeys.every((key) => key.startsWith("auth_start:")));
});

test("wraps POST starts and callback methods but bypasses GET sign-in and cheap actions", async () => {
  const consumedKeys: string[] = [];
  const store: AbuseStore = {
    consume(key, limit, windowSeconds) {
      consumedKeys.push(`${key}:${limit}:${windowSeconds}`);
      return Promise.resolve({
        allowed: true,
        remaining: limit - 1,
        retryAfterSeconds: windowSeconds,
      });
    },
  };
  const handled: Request[] = [];
  const wrapped = withAuthAbusePolicy(
    (request: Request) => {
      handled.push(request);
      return new Response(null, { status: 204 });
    },
    { store }
  );
  const cases = [
    ["GET", "/api/auth/signin", null],
    ["GET", "/api/auth/signin/github", null],
    ["POST", "/api/auth/signin", "auth_start"],
    ["POST", "/api/auth/signin/github", "auth_start"],
    ["GET", "/api/auth/callback/github", "auth_callback"],
    ["POST", "/api/auth/callback/github", "auth_callback"],
    ["PUT", "/api/auth/callback/github", null],
    ["GET", "/api/auth/session", null],
    ["POST", "/api/auth/session", null],
    ["GET", "/api/auth/providers", null],
    ["GET", "/api/auth/csrf", null],
    ["POST", "/api/auth/signout", null],
  ] as const;

  for (const [method, pathname, expectedRoute] of cases) {
    consumedKeys.length = 0;
    const request = authRequest(pathname, method);
    // biome-ignore lint/performance/noAwaitInLoops: each assertion owns the recording store state
    const response = await wrapped(request);

    assert.equal(response.status, 204, `${method} ${pathname}`);
    assert.strictEqual(handled.at(-1), request, `${method} ${pathname}`);
    if (expectedRoute) {
      assert.equal(consumedKeys.length, 2, `${method} ${pathname}`);
      assert.ok(
        consumedKeys.every((key) => key.startsWith(`${expectedRoute}:`)),
        `${method} ${pathname}`
      );
    } else {
      assert.deepEqual(consumedKeys, [], `${method} ${pathname}`);
    }
  }
});

test("repeated GET sign-in pages do not consume the store but POST initiation does", async () => {
  const consumedKeys: string[] = [];
  const store: AbuseStore = {
    consume(key, limit, windowSeconds) {
      consumedKeys.push(`${key}:${limit}:${windowSeconds}`);
      return Promise.resolve({
        allowed: true,
        remaining: limit - 1,
        retryAfterSeconds: windowSeconds,
      });
    },
  };
  const wrapped = withAuthAbusePolicy(
    () => new Response(null, { status: 204 }),
    { store }
  );

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const pathname =
      attempt % 2 === 0 ? "/api/auth/signin/github" : "/api/auth/signin";
    // biome-ignore lint/performance/noAwaitInLoops: repeated requests prove GET pages never consume quota
    const response = await wrapped(authRequest(pathname, "GET", "203.0.113.9"));
    assert.equal(response.status, 204, `GET ${pathname} attempt ${attempt}`);
  }
  assert.equal(consumedKeys.length, 0);

  const started = await wrapped(
    authRequest("/api/auth/signin/github", "POST", "203.0.113.9")
  );

  assert.equal(started.status, 204);
  assert.equal(consumedKeys.length, 2);
  assert.ok(consumedKeys.every((key) => key.startsWith("auth_start:")));
});

test("denies the sixth auth initiation per IP without affecting another IP", async () => {
  const store = new MemoryAbuseStore();
  let handlerCalls = 0;
  const wrapped = withAuthAbusePolicy(
    () => {
      handlerCalls += 1;
      return new Response(null, { status: 204 });
    },
    { store }
  );

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: rate-limit attempts must consume in order
    const response = await wrapped(
      authRequest("/api/auth/signin/github", "POST", "203.0.113.10")
    );
    assert.equal(response.status, 204, `attempt ${attempt}`);
  }

  const denied = await wrapped(
    authRequest("/api/auth/signin/github", "POST", "203.0.113.10")
  );
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("cache-control"), "no-store");
  assert.equal(denied.headers.get("retry-after"), "60");
  assert.deepEqual(await denied.json(), {
    error: "rate_limited",
    message: "Too many requests. Try again later.",
  });

  const otherIp = await wrapped(
    authRequest("/api/auth/signin/github", "POST", "203.0.113.11")
  );
  assert.equal(otherIp.status, 204);
  assert.equal(handlerCalls, 6);
});

test("callbacks use their separate ten-per-minute budget", async () => {
  const store = new MemoryAbuseStore();
  let handlerCalls = 0;
  const wrapped = withAuthAbusePolicy(
    () => {
      handlerCalls += 1;
      return new Response(null, { status: 204 });
    },
    { store }
  );
  const ip = "203.0.113.20";

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(
      // biome-ignore lint/performance/noAwaitInLoops: rate-limit attempts must consume in order
      (await wrapped(authRequest("/api/auth/signin/github", "POST", ip)))
        .status,
      204
    );
  }
  assert.equal(
    (await wrapped(authRequest("/api/auth/signin/github", "POST", ip))).status,
    429
  );

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: rate-limit attempts must consume in order
    const response = await wrapped(
      authRequest("/api/auth/callback/github", "GET", ip)
    );
    assert.equal(response.status, 204, `callback ${attempt}`);
  }
  assert.equal(
    (await wrapped(authRequest("/api/auth/callback/github", "GET", ip))).status,
    429
  );
  assert.equal(handlerCalls, 15);
});

test("missing IPs share the existing unknown abuse bucket", async () => {
  const store = new MemoryAbuseStore();
  let handlerCalls = 0;
  const wrapped = withAuthAbusePolicy(
    () => {
      handlerCalls += 1;
      return new Response(null, { status: 204 });
    },
    { store }
  );

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(
      // biome-ignore lint/performance/noAwaitInLoops: rate-limit attempts must consume in order
      (await wrapped(authRequest("/api/auth/signin/github", "POST"))).status,
      204
    );
  }

  assert.equal(
    (await wrapped(authRequest("/api/auth/signin/github", "POST"))).status,
    429
  );
  assert.equal(handlerCalls, 5);
});

/**
 * SECOND REVERSAL of this contract tonight, recorded in the test that
 * enforced it. Fail-closed on starts and callbacks 503ed production sign-in
 * the moment the limiter's store hiccuped — reproduced with a bare curl
 * against the deployed app. Replay safety lives in the state/PKCE/CSRF
 * machinery; the limiter is defense-in-depth here, and it now degrades to
 * per-instance memory limiting on a store failure instead of taking sign-in
 * down with it.
 */
test("limiter outages degrade starts and callbacks instead of blocking sign-in", async () => {
  const outageStore: AbuseStore = {
    consume() {
      return Promise.reject(new Error("Redis unavailable"));
    },
  };
  let handlerCalls = 0;
  const wrapped = withAuthAbusePolicy(
    () => {
      handlerCalls += 1;
      return Response.json({ readable: true });
    },
    { store: outageStore }
  );

  for (const [method, pathname] of [
    ["POST", "/api/auth/signin/github"],
    ["GET", "/api/auth/callback/github"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: each response body is asserted before the next request
    const response = await wrapped(authRequest(pathname, method));
    assert.equal(response.status, 200, `${method} ${pathname}`);
    assert.deepEqual(await response.json(), { readable: true });
  }

  for (const [method, pathname] of [
    ["GET", "/api/auth/signin"],
    ["GET", "/api/auth/signin/github"],
    ["GET", "/api/auth/session"],
    ["POST", "/api/auth/session"],
    ["GET", "/api/auth/providers"],
    ["GET", "/api/auth/csrf"],
    ["POST", "/api/auth/signout"],
  ] as const) {
    // biome-ignore lint/performance/noAwaitInLoops: each response body is asserted before the next request
    const response = await wrapped(authRequest(pathname, method));
    assert.equal(response.status, 200, `${method} ${pathname}`);
    assert.deepEqual(await response.json(), { readable: true });
  }
  // Nine, not seven: the two gated flows above now reach the handler under a
  // store outage instead of 503ing before it.
  assert.equal(handlerCalls, 9);
});

test("returns the original handler response and passes request context unchanged", async () => {
  const store = new MemoryAbuseStore();
  const request = authRequest(
    "/api/auth/signin/github",
    "POST",
    "203.0.113.30"
  );
  const context = {
    params: Promise.resolve({ nextauth: ["signin", "github"] }),
  };
  const expected = new Response(null, {
    headers: {
      location: "https://github.com/login/oauth/authorize",
      "set-cookie": "authjs.state=opaque; HttpOnly; Secure",
    },
    status: 302,
  });
  const wrapped = withAuthAbusePolicy(
    (receivedRequest: Request, receivedContext: typeof context) => {
      assert.strictEqual(receivedRequest, request);
      assert.strictEqual(receivedContext, context);
      return expected;
    },
    { store }
  );

  const actual = await wrapped(request, context);

  assert.strictEqual(actual, expected);
  assert.equal(
    actual.headers.get("location"),
    expected.headers.get("location")
  );
  assert.equal(
    actual.headers.get("set-cookie"),
    expected.headers.get("set-cookie")
  );
});

test("the catch-all route cannot bypass the abuse wrapper with a direct re-export", () => {
  const source = readFileSync(
    new URL(
      "../../app/(auth)/api/auth/[...nextauth]/route.ts",
      import.meta.url
    ),
    "utf8"
  );

  assert.match(source, /GET as authGET/);
  assert.match(source, /POST as authPOST/);
  assert.match(source, /withAuthAbusePolicy/);
  assert.match(source, /export const GET = withAuthAbusePolicy\(authGET\)/);
  assert.match(source, /export const POST = withAuthAbusePolicy\(authPOST\)/);
  assert.doesNotMatch(source, /export\s*\{\s*GET\s*,\s*POST\s*\}/);
  assert.doesNotMatch(
    source,
    /export (?:async function|const) (?:PUT|PATCH|DELETE)/
  );
});

function authRequest(pathname: string, method: string, ip?: string): Request {
  const headers = new Headers();
  if (ip) {
    headers.set("x-real-ip", ip);
  }
  return new Request(`${TEST_ORIGIN}${pathname}`, { headers, method });
}
