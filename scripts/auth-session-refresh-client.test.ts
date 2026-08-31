import assert from "node:assert/strict";
import test from "node:test";
import type { NextRequest } from "next/server";
import NextAuth from "next-auth";
import { decode, encode, type JWT } from "next-auth/jwt";
import { refreshSubscriberSession } from "../lib/auth/session-refresh.client";
import { refreshClaimsForSessionUpdate } from "../lib/session-claims";

const AUTH_SECRET = "abortable-session-refresh-test-secret";
const SESSION_COOKIE = "authjs.session-token";
const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const SUBSCRIBED_UNTIL = new Date("2099-01-15T12:00:00.000Z");
const NOW = new Date("2026-08-31T12:00:00.000Z");

test("the abortable refresh follows the installed Auth.js session-update wire protocol", async () => {
  let clientUpdate: unknown;
  const {
    handlers: { GET, POST },
  } = NextAuth({
    basePath: "/api/auth",
    callbacks: {
      jwt({ session, token, trigger }) {
        if (trigger !== "update") {
          return token;
        }
        clientUpdate = session;
        return refreshClaimsForSessionUpdate(
          token,
          session,
          () =>
            Promise.resolve({
              authVersion: 4,
              image: null,
              subscribedUntil: SUBSCRIBED_UNTIL,
            }),
          NOW
        );
      },
      session({ session, token }) {
        if (session.user) {
          session.user.id = token.id;
          session.user.type = token.type;
        }
        return session;
      },
    },
    providers: [],
    secret: AUTH_SECRET,
  });
  const controller = new AbortController();
  const calls: Array<{
    body: string | null;
    method: string;
    pathname: string;
    signal: AbortSignal | null;
  }> = [];
  const fetcher = await authHandlerFetch(GET, POST, calls);

  const refreshedSession = await refreshSubscriberSession(
    USER_ID,
    controller.signal,
    fetcher
  );

  assert.equal(refreshedSession?.user?.id, USER_ID);
  assert.equal(refreshedSession?.user?.type, "subscriber");
  assert.deepEqual(clientUpdate, {
    expectedUserId: USER_ID,
    refreshSubscription: true,
  });
  assert.deepEqual(
    calls.map(({ method, pathname }) => `${method} ${pathname}`),
    ["GET /api/auth/csrf", "POST /api/auth/session"]
  );
  assert.equal(calls[0]?.signal, controller.signal);
  assert.equal(calls[1]?.signal, controller.signal);
  const updateBody = JSON.parse(calls[1]?.body ?? "{}") as {
    csrfToken?: unknown;
    data?: unknown;
  };
  assert.equal(typeof updateBody.csrfToken, "string");
  assert.deepEqual(updateBody.data, {
    expectedUserId: USER_ID,
    refreshSubscription: true,
  });
  const refreshedCookie = fetcher.cookies.get(SESSION_COOKIE);
  assert.ok(refreshedCookie);
  const refreshedToken = await decode({
    salt: SESSION_COOKIE,
    secret: AUTH_SECRET,
    token: refreshedCookie,
  });
  assert.equal(refreshedToken?.id, USER_ID);
  assert.equal(refreshedToken?.type, "subscriber");
});

test("a returned subscriber session for another identity is rejected", async () => {
  const controller = new AbortController();
  const responses = [
    Response.json({ csrfToken: "csrf" }),
    Response.json({
      expires: "2099-01-01T00:00:00.000Z",
      user: {
        id: "9d2c6c20-406e-4ae0-b31a-5e44fc84b3aa",
        type: "subscriber",
      },
    }),
  ];

  const session = await refreshSubscriberSession(
    USER_ID,
    controller.signal,
    () => Promise.resolve(responses.shift() ?? new Response(null))
  );

  assert.equal(session, null);
});

async function authHandlerFetch(
  GET: (request: NextRequest) => Promise<Response>,
  POST: (request: NextRequest) => Promise<Response>,
  calls: Array<{
    body: string | null;
    method: string;
    pathname: string;
    signal: AbortSignal | null;
  }>
): Promise<
  typeof fetch & {
    cookies: Map<string, string>;
  }
> {
  const cookies = new Map<string, string>();
  cookies.set(
    SESSION_COOKIE,
    await encode({
      salt: SESSION_COOKIE,
      secret: AUTH_SECRET,
      token: sessionToken(),
    })
  );

  const fetcher = async (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      "http://localhost"
    );
    const headers = new Headers(init?.headers);
    headers.set(
      "cookie",
      [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    );
    const method = init?.method ?? "GET";
    calls.push({
      body: typeof init?.body === "string" ? init.body : null,
      method,
      pathname: url.pathname,
      signal: init?.signal ?? null,
    });
    const request = new Request(url, {
      ...init,
      headers,
      method,
    });
    const response =
      method === "POST"
        ? await POST(request as NextRequest)
        : await GET(request as NextRequest);
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = setCookie.split(";");
      const separator = pair?.indexOf("=") ?? -1;
      if (separator < 1) {
        continue;
      }
      const name = pair?.slice(0, separator) ?? "";
      if (attributes.some((value) => /max-age=0/i.test(value))) {
        cookies.delete(name);
      } else {
        cookies.set(name, pair?.slice(separator + 1) ?? "");
      }
    }
    return response;
  };

  return Object.assign(fetcher, { cookies }) as typeof fetch & {
    cookies: Map<string, string>;
  };
}

function sessionToken(): JWT {
  return {
    authVersion: 4,
    email: "person@example.invalid",
    id: USER_ID,
    subscribedUntil: null,
    type: "demo",
  };
}
