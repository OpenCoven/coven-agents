import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { encode } from "next-auth/jwt";
import { type AbuseStore, MemoryAbuseStore } from "@/lib/abuse/store";
import { verifiedJwtIdentity } from "@/lib/auth/verified-jwt";
import { authAbuseRoute, withAuthAbusePolicy } from "./abuse";

const TEST_ORIGIN = "https://coven.test";
const AUTH_SECRET = "auth-abuse-verified-session-secret";
const SECURE_SESSION_COOKIE = "__Secure-authjs.session-token";
const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

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
    ["POST", "/api/auth/session", "auth_session_update"],
    ["POST", "/api/auth/session/", "auth_session_update"],
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
  assert.equal(
    authAbuseRoute("POST", "/demo/api/auth/session", "/demo"),
    "auth_session_update"
  );
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

test("session replay preserves NextRequest base-path metadata", async () => {
  const request = new NextRequest(`${TEST_ORIGIN}/demo/api/auth/session`, {
    body: JSON.stringify({ csrfToken: "csrf", data: {} }),
    headers: { "x-real-ip": "203.0.113.43" },
    method: "POST",
    nextConfig: { basePath: "/demo" },
  });
  assert.equal(request.nextUrl.basePath, "/demo");
  assert.equal(request.nextUrl.pathname, "/api/auth/session");
  const wrapped = withAuthAbusePolicy(
    (receivedRequest: NextRequest) => {
      assert.equal(receivedRequest.nextUrl.basePath, "/demo");
      assert.equal(receivedRequest.nextUrl.pathname, "/api/auth/session");
      return new Response(null, { status: 204 });
    },
    {
      basePath: "/demo",
      enforceAbuse: () => Promise.resolve({ kind: "allowed" }),
      readIdentity: () => Promise.resolve(null),
    }
  );

  const response = await wrapped(request);

  assert.equal(response.status, 204);
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
    ["POST", "/api/auth/session", "auth_session_update_ip"],
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
    if (expectedRoute === "auth_session_update_ip") {
      assert.notStrictEqual(handled.at(-1), request, `${method} ${pathname}`);
    } else {
      assert.strictEqual(handled.at(-1), request, `${method} ${pathname}`);
    }
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

test("session updates admit IP, bound the body, verify identity, admit user, then invoke Auth.js", async () => {
  const calls: string[] = [];
  const controller = new AbortController();
  const expectedBody = new TextEncoder().encode(
    JSON.stringify({ csrfToken: "csrf", data: {} })
  );
  const request = new FrameworkRequest(`${TEST_ORIGIN}/api/auth/session`, {
    body: expectedBody,
    duplex: "half",
    headers: {
      "content-type": "application/json",
      cookie: `${SECURE_SESSION_COOKIE}=opaque`,
      "x-preserved": "yes",
      "x-real-ip": "203.0.113.44",
    },
    method: "POST",
    signal: controller.signal,
  } as RequestInit & { duplex: "half" });
  recordBodyOpen(request, calls);
  const replayedSignals: AbortSignal[] = [];
  const wrapped = withAuthAbusePolicy(
    async (receivedRequest: FrameworkRequest) => {
      calls.push("handler");
      assert.notStrictEqual(receivedRequest, request);
      assert.ok(receivedRequest instanceof FrameworkRequest);
      assert.equal(receivedRequest.nextUrl.pathname, "/api/auth/session");
      assert.equal(receivedRequest.url, request.url);
      assert.equal(receivedRequest.method, request.method);
      assert.deepEqual(
        Object.fromEntries(receivedRequest.headers),
        Object.fromEntries(request.headers)
      );
      assert.deepEqual(
        new Uint8Array(await receivedRequest.arrayBuffer()),
        expectedBody
      );
      replayedSignals.push(receivedRequest.signal);
      return new Response(null, { status: 204 });
    },
    {
      enforceAbuse: (input) => {
        if (input.route === "auth_session_update_ip") {
          calls.push("ip");
          assert.deepEqual(input, {
            ip: "203.0.113.44",
            route: "auth_session_update_ip",
          });
        } else {
          calls.push("user");
          assert.deepEqual(input, {
            ip: null,
            route: "auth_session_update",
            userId: USER_ID,
          });
        }
        return Promise.resolve({ kind: "allowed" });
      },
      readIdentity: (receivedRequest) => {
        calls.push("identity");
        assert.notStrictEqual(receivedRequest, request);
        assert.equal(receivedRequest.bodyUsed, false);
        return Promise.resolve({
          authVersion: 4,
          userId: USER_ID,
        });
      },
    }
  );

  const response = await wrapped(request);

  assert.equal(response.status, 204);
  assert.deepEqual(calls, ["ip", "body", "identity", "user", "handler"]);
  const [replayedSignal] = replayedSignals;
  assert.ok(replayedSignal);
  assert.equal(replayedSignal.aborted, false);
  controller.abort();
  assert.equal(replayedSignal.aborted, true);
});

test("IP denial stops before body reading, JWE work, and the Auth.js handler", async () => {
  const calls: string[] = [];
  const request = postRequest('{"csrfToken":"csrf","data":{}}');
  recordBodyOpen(request, calls);
  const wrapped = withAuthAbusePolicy(
    () => {
      calls.push("handler");
      return new Response(null, { status: 204 });
    },
    {
      enforceAbuse: (input) => {
        calls.push(input.route);
        return Promise.resolve({
          kind: "denied",
          responseStatus: 429,
          retryAfterSeconds: 12,
        });
      },
      readIdentity: () => {
        calls.push("identity");
        return Promise.resolve({
          authVersion: 4,
          userId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        });
      },
    }
  );

  const response = await wrapped(withIp(request, "203.0.113.45"));

  assert.equal(response.status, 429);
  assert.deepEqual(calls, ["auth_session_update_ip"]);
});

test("user denial occurs after bounded body reading and identity verification", async () => {
  const calls: string[] = [];
  const request = withIp(
    postRequest('{"csrfToken":"csrf","data":{}}'),
    "203.0.113.45"
  );
  recordBodyOpen(request, calls);
  const wrapped = withAuthAbusePolicy(
    () => {
      calls.push("handler");
      return new Response(null, { status: 204 });
    },
    {
      enforceAbuse: (input) => {
        if (input.route === "auth_session_update_ip") {
          calls.push("ip");
          return Promise.resolve({ kind: "allowed" });
        }
        calls.push("user");
        return Promise.resolve({
          kind: "denied",
          responseStatus: 429,
          retryAfterSeconds: 12,
        });
      },
      readIdentity: () => {
        calls.push("identity");
        return Promise.resolve({ authVersion: 4, userId: USER_ID });
      },
    }
  );

  const response = await wrapped(request);

  assert.equal(response.status, 429);
  assert.deepEqual(calls, ["ip", "body", "identity", "user"]);
});

test("a real Auth.js cookie consumes the session update IP and verified-user budgets", async () => {
  const consumedKeys: string[] = [];
  const value = await encode({
    salt: SECURE_SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: { authVersion: 4, id: USER_ID, type: "demo" },
  });
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
    {
      readIdentity: (receivedRequest) =>
        verifiedJwtIdentity(receivedRequest, {
          environment: {
            AUTH_SECRET,
            AUTH_URL: TEST_ORIGIN,
          },
        }),
      store,
    }
  );
  const request = authRequest("/api/auth/session", "POST", "203.0.113.46");
  request.headers.set("cookie", `${SECURE_SESSION_COOKIE}=${value}`);

  const response = await wrapped(request);

  assert.equal(response.status, 204);
  assert.equal(consumedKeys.length, 4);
  assert.ok(
    consumedKeys.some((key) =>
      key.startsWith("auth_session_update_ip:burst:ip:203.0.113.46:120:60")
    )
  );
  assert.ok(
    consumedKeys.some((key) =>
      key.startsWith(`auth_session_update:sustained:user:${USER_ID}:100:3600`)
    )
  );
});

test("absent, invalid, and expired cookies still consume IP quota and reach Auth.js without user quota", async () => {
  const expired = await encode({
    maxAge: -60,
    salt: SECURE_SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: { authVersion: 4, id: USER_ID, type: "demo" },
  });
  const cases = [
    ["absent", null],
    ["invalid", "not-a-jwe"],
    ["expired", expired],
  ] as const;

  for (const [label, cookieValue] of cases) {
    const calls: string[] = [];
    const request = postRequest('{"csrfToken":"csrf","data":{}}');
    request.headers.set("x-real-ip", "203.0.113.47");
    if (cookieValue) {
      request.headers.set("cookie", `${SECURE_SESSION_COOKIE}=${cookieValue}`);
    }
    recordBodyOpen(request, calls);
    const wrapped = withAuthAbusePolicy(
      async (receivedRequest: Request) => {
        calls.push("handler");
        assert.equal(
          await receivedRequest.text(),
          '{"csrfToken":"csrf","data":{}}'
        );
        return new Response(null, { status: 204 });
      },
      {
        enforceAbuse: (input) => {
          calls.push(input.route);
          return Promise.resolve({ kind: "allowed" });
        },
        readIdentity: (receivedRequest) =>
          verifiedJwtIdentity(receivedRequest, {
            environment: {
              AUTH_SECRET,
              AUTH_URL: TEST_ORIGIN,
            },
          }),
      }
    );

    // biome-ignore lint/performance/noAwaitInLoops: each cookie disposition owns its call trace
    const response = await wrapped(request);

    assert.equal(response.status, 204, label);
    assert.deepEqual(
      calls,
      ["auth_session_update_ip", "body", "handler"],
      label
    );
  }
});

test("declared and chunked 1 MiB session updates return 413 before JWE work or Auth.js", async () => {
  const cases = [
    {
      label: "declared",
      request: postRequest("x", {
        "content-length": String(1024 * 1024),
      }),
    },
    {
      label: "chunked",
      request: new Request(`${TEST_ORIGIN}/api/auth/session`, {
        body: new Uint8Array(1024 * 1024),
        method: "POST",
      }),
    },
  ];

  for (const { label, request } of cases) {
    const calls: string[] = [];
    recordBodyOpen(request, calls);
    const wrapped = withAuthAbusePolicy(
      () => {
        calls.push("handler");
        return new Response(null, { status: 204 });
      },
      {
        enforceAbuse: (input) => {
          calls.push(input.route);
          return Promise.resolve({ kind: "allowed" });
        },
        readIdentity: () => {
          calls.push("identity");
          return Promise.resolve(null);
        },
      }
    );

    // biome-ignore lint/performance/noAwaitInLoops: each body framing owns its call trace
    const response = await wrapped(request);

    assert.equal(response.status, 413, label);
    assert.deepEqual(
      calls,
      label === "declared"
        ? ["auth_session_update_ip"]
        : ["auth_session_update_ip", "body"],
      label
    );
    assert.deepEqual(await response.json(), {
      error: "payload_too_large",
      message: "Session update payload is too large.",
    });
  }
});

test("an exact-limit multibyte session body is preserved byte-for-byte", async () => {
  const suffix = new TextEncoder().encode("🧙");
  const expected = new Uint8Array(16_384);
  expected.fill(0x20);
  expected.set(suffix, expected.byteLength - suffix.byteLength);
  let received: Uint8Array | null = null;
  const wrapped = withAuthAbusePolicy(
    async (request: Request) => {
      received = new Uint8Array(await request.arrayBuffer());
      return new Response(null, { status: 204 });
    },
    {
      enforceAbuse: () => Promise.resolve({ kind: "allowed" }),
      readIdentity: () => Promise.resolve({ authVersion: 4, userId: USER_ID }),
    }
  );

  const response = await wrapped(
    new Request(`${TEST_ORIGIN}/api/auth/session`, {
      body: expected,
      headers: { "content-length": String(expected.byteLength) },
      method: "POST",
    })
  );

  assert.equal(response.status, 204);
  assert.deepEqual(received, expected);
});

test("session body stream failures return an explicit retryable read error", async () => {
  const calls: string[] = [];
  const request = new Request(`${TEST_ORIGIN}/api/auth/session`, {
    body: new ReadableStream({
      pull(controller) {
        controller.error(new Error("connection reset"));
      },
    }),
    duplex: "half",
    method: "POST",
  } as RequestInit & { duplex: "half" });
  const wrapped = withAuthAbusePolicy(
    () => {
      calls.push("handler");
      return new Response(null, { status: 204 });
    },
    {
      enforceAbuse: (input) => {
        calls.push(input.route);
        return Promise.resolve({ kind: "allowed" });
      },
      readIdentity: () => {
        calls.push("identity");
        return Promise.resolve(null);
      },
    }
  );

  const response = await wrapped(request);

  assert.equal(response.status, 400);
  assert.deepEqual(calls, ["auth_session_update_ip"]);
  assert.deepEqual(await response.json(), {
    error: "request_body_unreadable",
    message: "Could not read the session update payload. Retry the request.",
  });
});

test("ordinary GET session reads do not verify identity or consume update quota", async () => {
  const calls: string[] = [];
  const wrapped = withAuthAbusePolicy(
    () => {
      calls.push("handler");
      return new Response(null, { status: 204 });
    },
    {
      enforceAbuse: () => {
        calls.push("abuse");
        return Promise.resolve({ kind: "allowed" });
      },
      readIdentity: () => {
        calls.push("identity");
        return Promise.resolve(null);
      },
    }
  );

  const response = await wrapped(authRequest("/api/auth/session", "GET"));

  assert.equal(response.status, 204);
  assert.deepEqual(calls, ["handler"]);
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

function postRequest(body: BodyInit, headers: HeadersInit = {}): Request {
  return new Request(`${TEST_ORIGIN}/api/auth/session`, {
    body,
    headers,
    method: "POST",
  });
}

function withIp<T extends Request>(request: T, ip: string): T {
  request.headers.set("x-real-ip", ip);
  return request;
}

function recordBodyOpen(request: Request, calls: string[]): void {
  const { body } = request;
  assert.ok(body);
  Object.defineProperty(request, "body", {
    configurable: true,
    value: {
      getReader() {
        calls.push("body");
        return body.getReader();
      },
    },
  });
}

class FrameworkRequest extends Request {
  readonly nextUrl: URL;

  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init);
    this.nextUrl = new URL(this.url);
  }
}
