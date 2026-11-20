import assert from "node:assert/strict";
import test from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTPayload,
  SignJWT,
} from "jose";
import {
  bearerAccessToken,
  createWorkOSAccessTokenVerifier,
  fetchVerifiedWorkOSUser,
  readWorkOSTokenConfiguration,
  WORKOS_ISSUER,
  workosJwksUrl,
} from "./workos-access-token";

const configuration = { apiKey: "sk_test_fixture", clientId: "client_fixture" };
const NOW = new Date("2026-11-11T12:00:00.000Z");
const seconds = (date: Date) => Math.floor(date.getTime() / 1000);

async function signer(algorithm: "ES256" | "RS256" = "RS256") {
  const { privateKey, publicKey } = await generateKeyPair(algorithm);
  const jwk = { ...(await exportJWK(publicKey)), alg: algorithm, kid: "k1" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const sign = (
    claims: JWTPayload = {},
    options: Readonly<{ omit?: readonly string[] }> = {}
  ) => {
    const payload: JWTPayload = {
      client_id: configuration.clientId,
      exp: seconds(NOW) + 300,
      iat: seconds(NOW) - 5,
      iss: WORKOS_ISSUER,
      sid: "session_01FIXTURE",
      sub: "user_01FIXTURE",
      ...claims,
    };
    for (const name of options.omit ?? []) {
      delete payload[name];
    }
    return new SignJWT(payload)
      .setProtectedHeader({ alg: algorithm, kid: "k1" })
      .sign(privateKey);
  };
  return { keys, sign };
}

test("configuration is absent unless both server values are valid", () => {
  assert.equal(readWorkOSTokenConfiguration({}), null);
  assert.equal(
    readWorkOSTokenConfiguration({ WORKOS_CLIENT_ID: "client_a" }),
    null
  );
  assert.equal(
    readWorkOSTokenConfiguration({
      WORKOS_API_KEY: "sk_a",
      WORKOS_CLIENT_ID: "not-a-client",
    }),
    null
  );
  assert.deepEqual(
    readWorkOSTokenConfiguration({
      WORKOS_API_KEY: " sk_a ",
      WORKOS_CLIENT_ID: " client_a ",
    }),
    { apiKey: "sk_a", clientId: "client_a" }
  );
});

test("the JWKS URL is pinned to the WorkOS API and the configured client", () => {
  assert.equal(
    workosJwksUrl("client_fixture").href,
    "https://api.workos.com/sso/jwks/client_fixture"
  );
  assert.throws(() => workosJwksUrl("client_../x"));
});

test("only a single well-formed bearer token is read, and cookies are ignored", () => {
  const request = (headers: Record<string, string>) =>
    new Request("https://agents.example/api", { headers });
  assert.equal(bearerAccessToken(request({})), null);
  assert.equal(
    bearerAccessToken(request({ cookie: "authjs.session-token=a.b.c" })),
    null
  );
  assert.equal(
    bearerAccessToken(request({ authorization: "Basic a.b.c" })),
    null
  );
  assert.equal(
    bearerAccessToken(request({ authorization: "Bearer abc" })),
    null
  );
  assert.equal(
    bearerAccessToken(request({ authorization: "Bearer a.b.c d" })),
    null
  );
  assert.equal(
    bearerAccessToken(
      request({ authorization: `Bearer ${"a".repeat(9000)}.b.c` })
    ),
    null
  );
  assert.equal(
    bearerAccessToken(request({ authorization: "Bearer aa.bb.cc" })),
    "aa.bb.cc"
  );
});

test("a valid access token yields the WorkOS user and session", async () => {
  const { keys, sign } = await signer();
  const verify = createWorkOSAccessTokenVerifier(configuration, {
    keys,
    now: () => NOW,
  });
  assert.deepEqual(await verify(await sign()), {
    kind: "verified",
    sessionId: "session_01FIXTURE",
    userId: "user_01FIXTURE",
  });
  // WorkOS documents the issuer both with and without a trailing slash.
  assert.equal(
    (await verify(await sign({ iss: `${WORKOS_ISSUER}/` }))).kind,
    "verified"
  );
});

test("every invalid token is rejected", async () => {
  const { keys, sign } = await signer();
  const other = await signer();
  const verify = createWorkOSAccessTokenVerifier(configuration, {
    keys,
    now: () => NOW,
  });
  const rejected = [
    await sign({ exp: seconds(NOW) - 60 }),
    await sign({ iat: seconds(NOW) + 600, nbf: seconds(NOW) + 600 }),
    // Issued in the future with no `nbf`: the lifetime cap must be
    // measured from now, not from whatever issue time the token claims.
    await sign({ exp: seconds(NOW) + 900, iat: seconds(NOW) + 600 }),
    await sign({ iss: "https://evil.example" }),
    await sign({ client_id: "client_other" }),
    await sign({}, { omit: ["client_id"] }),
    await sign({}, { omit: ["exp"] }),
    await sign({}, { omit: ["sub"] }),
    await sign({}, { omit: ["sid"] }),
    await sign({ sub: "org_01FIXTURE" }),
    await sign({ sub: 7 as never }),
    // An impersonated session must not act as the owner.
    await sign({ act: { sub: "admin@example.test" } }),
    // More than the documented few minutes is not a session access token.
    await sign({ exp: seconds(NOW) + 86_400 }),
    await other.sign(),
    "not.a.jwt",
    "",
  ];
  for (const token of rejected) {
    // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
    assert.deepEqual(await verify(token), { kind: "rejected" }, token);
  }
});

test("an unsigned or differently signed algorithm is rejected", async () => {
  const rsa = await signer();
  const ec = await signer("ES256");
  const verify = createWorkOSAccessTokenVerifier(configuration, {
    keys: ec.keys,
    now: () => NOW,
  });
  assert.deepEqual(await verify(await ec.sign()), { kind: "rejected" });
  const [, payload] = (await rsa.sign()).split(".");
  const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${payload}.`;
  assert.deepEqual(await verify(none), { kind: "rejected" });
});

test("a key-set outage is unavailable, never a pass", async () => {
  const { sign } = await signer();
  const verify = createWorkOSAccessTokenVerifier(configuration, {
    keys: () => Promise.reject(new TypeError("fetch failed")),
    now: () => NOW,
  });
  assert.deepEqual(await verify(await sign()), { kind: "unavailable" });
});

function userResponse(body: unknown, status = 200) {
  const calls: { headers: Headers; init: RequestInit; url: string }[] = [];
  const request = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({
      headers: new Headers(init.headers),
      init,
      url: String(input),
    });
    return Promise.resolve(Response.json(body, { status }));
  }) as typeof fetch;
  return { calls, request };
}

test("the user lookup returns only a verified, matching email", async () => {
  const { calls, request } = userResponse({
    email: " Owner@Example.Test ",
    email_verified: true,
    id: "user_01FIXTURE",
  });
  assert.deepEqual(
    await fetchVerifiedWorkOSUser("user_01FIXTURE", configuration, request),
    { email: "owner@example.test", kind: "verified" }
  );
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.workos.com/user_management/users/user_01FIXTURE"
  );
  assert.equal(calls[0].headers.get("authorization"), "Bearer sk_test_fixture");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
});

test("an unverified, mismatched, or malformed user is rejected", async () => {
  for (const body of [
    {
      email: "owner@example.test",
      email_verified: false,
      id: "user_01FIXTURE",
    },
    { email: "owner@example.test", email_verified: true, id: "user_01OTHER" },
    { email: "not-an-email", email_verified: true, id: "user_01FIXTURE" },
    { email_verified: true, id: "user_01FIXTURE" },
    null,
  ]) {
    const { request } = userResponse(body);
    assert.deepEqual(
      // biome-ignore lint/performance/noAwaitInLoops: Cases run in order so a failure names its own input.
      await fetchVerifiedWorkOSUser("user_01FIXTURE", configuration, request),
      { kind: "rejected" }
    );
  }
  const missing = userResponse({ message: "not found" }, 404);
  assert.deepEqual(
    await fetchVerifiedWorkOSUser(
      "user_01FIXTURE",
      configuration,
      missing.request
    ),
    { kind: "rejected" }
  );
});

test("a user lookup outage is unavailable and an unsafe ID is never sent", async () => {
  const down = userResponse({}, 503);
  assert.deepEqual(
    await fetchVerifiedWorkOSUser(
      "user_01FIXTURE",
      configuration,
      down.request
    ),
    { kind: "unavailable" }
  );
  const throwing = (() =>
    Promise.reject(new Error("sk_test_fixture leaked"))) as typeof fetch;
  assert.deepEqual(
    await fetchVerifiedWorkOSUser("user_01FIXTURE", configuration, throwing),
    { kind: "unavailable" }
  );
  const unsafe = userResponse({});
  assert.deepEqual(
    await fetchVerifiedWorkOSUser(
      "user_../../x",
      configuration,
      unsafe.request
    ),
    { kind: "rejected" }
  );
  assert.equal(unsafe.calls.length, 0);
});
