import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import NextAuth, { customFetch } from "next-auth";
import {
  createWorkOSProvider,
  readWorkOSConfiguration,
  verifiedWorkOSProfile,
} from "../lib/auth/workos";

test("WorkOS is opt-in and incomplete enabled configuration fails closed", () => {
  assert.equal(readWorkOSConfiguration({}), null);
  assert.equal(readWorkOSConfiguration({ WORKOS_AUTH_ENABLED: "0" }), null);
  assert.throws(() => readWorkOSConfiguration({ WORKOS_AUTH_ENABLED: "true" }));
  assert.throws(() => readWorkOSConfiguration({ WORKOS_AUTH_ENABLED: "1" }));
  assert.deepEqual(
    readWorkOSConfiguration({
      WORKOS_API_KEY: "test-key",
      WORKOS_AUTH_ENABLED: "1",
      WORKOS_CLIENT_ID: "client_example",
    }),
    { apiKey: "test-key", clientId: "client_example" }
  );
});

test("only a provider-verified bounded email can adopt a local account", () => {
  const profile = {
    email: " Val@Example.com ",
    email_verified: true,
    id: "user_example",
  };
  assert.equal(verifiedWorkOSProfile(profile).email, "val@example.com");
  for (const invalid of [
    { ...profile, email_verified: false },
    { ...profile, email_verified: "true" },
    { ...profile, email: "invalid" },
    { ...profile, email: `${"x".repeat(64)}@example.com` },
    { ...profile, id: "" },
    null,
  ]) {
    assert.throws(() => verifiedWorkOSProfile(invalid));
  }
});

test("AuthKit exchange preserves state/PKCE and keeps provider tokens out of the profile", async () => {
  const profile = {
    email: "val@example.com",
    email_verified: true,
    id: "user_example",
  };
  const provider = createWorkOSProvider(
    { apiKey: "test-key", clientId: "client_example" },
    (input, init) => {
      assert.equal(
        String(input),
        "https://api.workos.com/user_management/authenticate"
      );
      assert.equal(
        new Headers(init?.headers).get("content-type"),
        "application/json"
      );
      assert.deepEqual(JSON.parse(String(init?.body)), {
        client_id: "client_example",
        client_secret: "test-key",
        code: "one-use-code",
        code_verifier: "verifier",
        grant_type: "authorization_code",
      });
      return Promise.resolve(
        Response.json({
          access_token: "test-access",
          refresh_token: "test-refresh",
          user: profile,
        })
      );
    }
  );
  assert.deepEqual(provider.checks, ["state", "pkce"]);
  const exchange = provider[customFetch];
  assert.ok(exchange);
  const response = await exchange(
    "https://api.workos.com/user_management/authenticate",
    {
      body: new URLSearchParams({
        client_id: "client_example",
        client_secret: "test-key",
        code: "one-use-code",
        code_verifier: "verifier",
        grant_type: "authorization_code",
        redirect_uri: "https://agents.example.com/api/auth/callback/workos",
      }),
      method: "POST",
    }
  );
  const tokens = await response.json();
  assert.equal(tokens.token_type, "bearer");
  assert.equal(tokens.user.email, profile.email);
  assert.ok(provider.profile);
  const mapped = await provider.profile(verifiedWorkOSProfile(profile), tokens);
  assert.deepEqual(mapped, {
    email: "val@example.com",
    id: "user_example",
    type: "demo",
  });
  assert.equal("access_token" in mapped, false);
});

test("WorkOS failed exchanges do not return upstream secrets or user details", async () => {
  const provider = createWorkOSProvider(
    { apiKey: "test-key", clientId: "client_example" },
    () =>
      Promise.resolve(
        Response.json(
          { message: "secret detail", user: { email: "private@example.com" } },
          { status: 400 }
        )
      )
  );
  const exchange = provider[customFetch];
  assert.ok(exchange);
  const response = await exchange(
    "https://api.workos.com/user_management/authenticate",
    { body: new URLSearchParams({ code: "invalid" }), method: "POST" }
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_grant" });
});

test("Auth.js completes AuthKit callback and refuses missing state before exchange", async () => {
  let exchanges = 0;
  let acceptedProfile: unknown;
  const provider = createWorkOSProvider(
    { apiKey: "test-key", clientId: "client_example" },
    (_input, init) => {
      exchanges += 1;
      const body = JSON.parse(String(init?.body));
      assert.ok(body.code_verifier);
      assert.equal(body.code, "one-use-code");
      return Promise.resolve(
        Response.json({
          access_token: "test-access",
          user: {
            email: "val@example.com",
            email_verified: true,
            id: "user_example",
          },
        })
      );
    }
  );
  const { handlers } = NextAuth({
    basePath: "/api/auth",
    callbacks: {
      jwt({ token, profile }) {
        acceptedProfile = profile;
        return token;
      },
    },
    logger: {
      debug() {
        /* intentionally silent */
      },
      error() {
        /* expected refusal */
      },
      warn() {
        /* intentionally silent */
      },
    },
    providers: [provider],
    secret: "isolated-authkit-test-secret",
    trustHost: true,
  });
  const origin = "http://localhost:3137";
  const csrf = await handlers.GET(new NextRequest(`${origin}/api/auth/csrf`));
  const { csrfToken } = await csrf.json();
  const cookies = new Map<string, string>();
  function retainCookies(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }
  function cookieHeader() {
    return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  }
  retainCookies(csrf);
  const signIn = await handlers.POST(
    new NextRequest(`${origin}/api/auth/signin/workos?screen_hint=sign-up`, {
      body: new URLSearchParams({
        callbackUrl: `${origin}/account`,
        csrfToken,
      }),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookieHeader(),
      },
      method: "POST",
    })
  );
  retainCookies(signIn);
  const location = signIn.headers.get("location");
  assert.ok(location, `HTTP ${signIn.status}: ${await signIn.text()}`);
  const authorization = new URL(location);
  assert.equal(authorization.origin, "https://api.workos.com");
  assert.equal(authorization.searchParams.get("provider"), "authkit");
  assert.equal(authorization.searchParams.get("screen_hint"), "sign-up");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorization.searchParams.get("code_challenge"));
  const state = authorization.searchParams.get("state");
  assert.ok(state);
  await handlers.GET(
    new NextRequest(`${origin}/api/auth/callback/workos?code=one-use-code`, {
      headers: { cookie: cookieHeader() },
    })
  );
  assert.equal(exchanges, 0);
  const callback = await handlers.GET(
    new NextRequest(
      `${origin}/api/auth/callback/workos?code=one-use-code&state=${encodeURIComponent(state)}`,
      {
        headers: { cookie: cookieHeader() },
      }
    )
  );
  assert.equal(exchanges, 1);
  assert.equal(callback.headers.get("location"), `${origin}/account`);
  assert.deepEqual(acceptedProfile, {
    email: "val@example.com",
    email_verified: true,
    id: "user_example",
  });
  assert.ok(
    callback.headers
      .getSetCookie()
      .some((cookie) => cookie.startsWith("authjs.session-token="))
  );
  assert.equal(
    callback.headers
      .getSetCookie()
      .some((cookie) => cookie.includes("test-access")),
    false
  );
});
