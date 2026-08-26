import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { type AbuseStore, MemoryAbuseStore } from "@/lib/abuse/store";
import { authAbuseRoute, withAuthAbusePolicy } from "./abuse";

const TEST_ORIGIN = "https://coven.test";

test("classifies only Auth.js OAuth initiation and callback endpoints", () => {
  const cases = [
    ["/api/auth/signin", "auth_start"],
    ["/api/auth/signin/", "auth_start"],
    ["/api/auth/signin/github", "auth_start"],
    ["/api/auth/signin/github/", "auth_start"],
    ["/api/auth/callback/github", "auth_callback"],
    ["/api/auth/callback/github/", "auth_callback"],
    ["/api/auth/session", null],
    ["/api/auth/session/", null],
    ["/api/auth/csrf", null],
    ["/api/auth/providers", null],
    ["/api/auth/error", null],
    ["/api/auth/verify-request", null],
    ["/api/auth/signout", null],
    ["/api/auth/signout/github", null],
    ["/api/auth/callback", null],
    ["/api/auth/not-signin/github", null],
    ["/login", null],
  ] as const;

  for (const [pathname, expected] of cases) {
    assert.equal(authAbuseRoute(pathname), expected, pathname);
  }
});

test("wraps Auth.js GET and POST starts and callbacks but bypasses cheap actions", async () => {
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
    ["GET", "/api/auth/signin", "auth_start"],
    ["POST", "/api/auth/signin/github", "auth_start"],
    ["GET", "/api/auth/callback/github", "auth_callback"],
    ["POST", "/api/auth/callback/github", "auth_callback"],
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

test("limiter outages block starts and callbacks but not session support reads", async () => {
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
    assert.equal(response.status, 503, `${method} ${pathname}`);
    assert.deepEqual(await response.json(), {
      error: "abuse_control_unavailable",
      message: "Please try again later.",
    });
  }

  for (const pathname of [
    "/api/auth/session",
    "/api/auth/providers",
    "/api/auth/csrf",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each response body is asserted before the next request
    const response = await wrapped(authRequest(pathname, "GET"));
    assert.equal(response.status, 200, pathname);
    assert.deepEqual(await response.json(), { readable: true });
  }
  assert.equal(handlerCalls, 3);
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
