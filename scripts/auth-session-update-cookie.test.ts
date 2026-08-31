import assert from "node:assert/strict";
import test from "node:test";
import NextAuth from "next-auth";
import { decode, encode, type JWT } from "next-auth/jwt";
import type { AbuseStore } from "../lib/abuse/store";
import { ChatbotError } from "../lib/errors";
import { refreshClaimsForSessionUpdate } from "../lib/session-claims";

const AUTH_SECRET = "auth-session-update-cookie-test-secret";
const SESSION_COOKIE = "authjs.session-token";
const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const NOW = new Date("2026-08-31T12:00:00.000Z");

test("an update lookup outage keeps the Auth.js cookie and ignores client fields", async () => {
  const original = token();
  const response = await updateSession(
    original,
    {
      image: "https://attacker.test/avatar.png",
      subscribedUntil: "2099-01-01T00:00:00.000Z",
      type: "subscriber",
    },
    () => Promise.reject(new ChatbotError("bad_request:database"))
  );

  assert.equal(response.status, 200);
  const sessionCookie = updatedSessionCookie(response);
  assert.doesNotMatch(sessionCookie, /Max-Age=0/i);

  const decoded = await decode({
    salt: SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: cookieValue(sessionCookie),
  });
  assert.ok(decoded);
  assert.equal(decoded.id, USER_ID);
  assert.equal(decoded.authVersion, 4);
  assert.equal(decoded.picture, "https://images.test/existing.png");
  assert.equal(decoded.subscribedUntil, null);
  assert.equal(decoded.type, "demo");
  assert.equal("image" in decoded, false);
});

test("a missing stored user still makes Auth.js clear the revoked cookie", async () => {
  const response = await updateSession(token(), {}, () =>
    Promise.resolve(null)
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "null");
  assert.match(updatedSessionCookie(response), /Max-Age=0/i);
});

test("the abuse wrapper admits and bounds an Auth.js update before its stored-claim callback", async () => {
  const { withAuthAbusePolicy } = await import("../lib/auth/abuse");
  const calls: string[] = [];
  const {
    handlers: { GET, POST },
  } = NextAuth({
    basePath: "/api/auth",
    callbacks: {
      jwt({ session, token: current, trigger }) {
        if (trigger !== "update") {
          return current;
        }
        calls.push("stored-claims");
        return refreshClaimsForSessionUpdate(
          current,
          session,
          () =>
            Promise.resolve({
              authVersion: 4,
              image: "https://images.test/refreshed.png",
              subscribedUntil: null,
            }),
          NOW
        );
      },
    },
    providers: [],
    secret: AUTH_SECRET,
  });

  const csrfResponse = await GET(
    new Request("http://localhost/api/auth/csrf") as Parameters<typeof GET>[0]
  );
  const csrfBody = (await csrfResponse.json()) as { csrfToken: string };
  const csrfCookies = csrfResponse.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const encoded = await encode({
    salt: SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: token(),
  });
  const request = new Request("http://localhost/api/auth/session", {
    body: JSON.stringify({ csrfToken: csrfBody.csrfToken, data: {} }),
    headers: {
      "content-type": "application/json",
      cookie: `${csrfCookies}; ${SESSION_COOKIE}=${encoded}`,
      "x-real-ip": "203.0.113.80",
    },
    method: "POST",
  });
  recordBodyOpen(request, calls);
  const wrapped = withAuthAbusePolicy(POST, {
    enforceAbuse: (input) => {
      calls.push(
        input.route === "auth_session_update_ip"
          ? "ip-admission"
          : "user-admission"
      );
      return Promise.resolve({ kind: "allowed" });
    },
    readIdentity: () => {
      calls.push("identity");
      return Promise.resolve({ authVersion: 4, userId: USER_ID });
    },
  });

  const response = await wrapped(request as Parameters<typeof POST>[0]);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    "ip-admission",
    "body",
    "identity",
    "user-admission",
    "stored-claims",
  ]);
  assert.equal(
    ((await response.json()) as { user?: { image?: string | null } }).user
      ?.image,
    "https://images.test/refreshed.png"
  );
});

test("GET session admission precedes Auth.js for a valid cookie", async () => {
  const { withAuthAbusePolicy } = await import("../lib/auth/abuse");
  const calls: string[] = [];
  const {
    handlers: { GET },
  } = NextAuth({
    basePath: "/api/auth",
    callbacks: {
      session({ session }) {
        calls.push("authjs-session");
        return session;
      },
    },
    providers: [],
    secret: AUTH_SECRET,
  });
  const encoded = await encode({
    salt: SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: token(),
  });
  const request = new Request("http://localhost/api/auth/session", {
    headers: {
      cookie: `${SESSION_COOKIE}=${encoded}`,
      "x-real-ip": "203.0.113.81",
    },
  });
  const wrapped = withAuthAbusePolicy(GET, {
    enforceAbuse: (input) => {
      calls.push("ip-admission");
      assert.deepEqual(input, {
        ip: "203.0.113.81",
        route: "auth_session_read_ip",
      });
      return Promise.resolve({ kind: "allowed" });
    },
  });

  const response = await wrapped(request as Parameters<typeof GET>[0]);

  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["ip-admission", "authjs-session"]);
  assert.notEqual(await response.text(), "null");
});

test("GET session denial stops an invalid cookie before Auth.js JWE logging", async () => {
  const { withAuthAbusePolicy } = await import("../lib/auth/abuse");
  const calls: string[] = [];
  const {
    handlers: { GET },
  } = NextAuth({
    basePath: "/api/auth",
    logger: {
      error() {
        calls.push("authjs-jwe-error");
      },
    },
    providers: [],
    secret: AUTH_SECRET,
  });
  const wrapped = withAuthAbusePolicy(GET, {
    enforceAbuse: (input) => {
      calls.push(input.route);
      return Promise.resolve({
        kind: "denied",
        responseStatus: 429,
        retryAfterSeconds: 60,
      });
    },
  });

  const response = await wrapped(
    new Request("http://localhost/api/auth/session", {
      headers: {
        cookie: `${SESSION_COOKIE}=not-a-jwe`,
        "x-real-ip": "203.0.113.82",
      },
    }) as Parameters<typeof GET>[0]
  );

  assert.equal(response.status, 429);
  assert.deepEqual(calls, ["auth_session_read_ip"]);
});

test("an allowed invalid GET session cookie is budgeted before Auth.js handles it", async () => {
  const { withAuthAbusePolicy } = await import("../lib/auth/abuse");
  const calls: string[] = [];
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
  const {
    handlers: { GET },
  } = NextAuth({
    basePath: "/api/auth",
    logger: {
      error() {
        calls.push("authjs-jwe-error");
      },
    },
    providers: [],
    secret: AUTH_SECRET,
  });
  const wrapped = withAuthAbusePolicy(GET, { store });

  const response = await wrapped(
    new Request("http://localhost/api/auth/session", {
      headers: {
        cookie: `${SESSION_COOKIE}=not-a-jwe`,
        "x-real-ip": "203.0.113.83",
      },
    }) as Parameters<typeof GET>[0]
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "null");
  assert.deepEqual(calls, ["authjs-jwe-error"]);
  assert.deepEqual(consumedKeys, [
    "auth_session_read_ip:burst:ip:203.0.113.83:600:60",
    "auth_session_read_ip:sustained:ip:203.0.113.83:10000:3600",
  ]);
});

async function updateSession(
  initialToken: JWT,
  clientUpdate: unknown,
  findUser: Parameters<typeof refreshClaimsForSessionUpdate>[2]
): Promise<Response> {
  const {
    handlers: { GET, POST },
  } = NextAuth({
    basePath: "/api/auth",
    callbacks: {
      jwt({ session, token: current, trigger }) {
        if (trigger !== "update") {
          return current;
        }
        return refreshClaimsForSessionUpdate(current, session, findUser, NOW);
      },
    },
    providers: [],
    secret: AUTH_SECRET,
  });
  const csrfResponse = await GET(
    new Request("http://localhost/api/auth/csrf") as Parameters<typeof GET>[0]
  );
  const csrfBody = (await csrfResponse.json()) as { csrfToken: string };
  const csrfCookies = csrfResponse.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const encoded = await encode({
    salt: SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: initialToken,
  });

  return POST(
    new Request("http://localhost/api/auth/session", {
      body: JSON.stringify({
        csrfToken: csrfBody.csrfToken,
        data: clientUpdate,
      }),
      headers: {
        "content-type": "application/json",
        cookie: `${csrfCookies}; ${SESSION_COOKIE}=${encoded}`,
      },
      method: "POST",
    }) as Parameters<typeof POST>[0]
  );
}

function updatedSessionCookie(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cookie, "Auth.js must emit a session-cookie disposition");
  return cookie;
}

function cookieValue(setCookie: string): string {
  return setCookie.slice(SESSION_COOKIE.length + 1).split(";", 1)[0] ?? "";
}

function token(): JWT {
  return {
    authVersion: 4,
    id: USER_ID,
    picture: "https://images.test/existing.png",
    subscribedUntil: null,
    type: "demo",
  };
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
