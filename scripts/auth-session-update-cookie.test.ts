import assert from "node:assert/strict";
import test from "node:test";
import NextAuth from "next-auth";
import { decode, encode, type JWT } from "next-auth/jwt";
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
