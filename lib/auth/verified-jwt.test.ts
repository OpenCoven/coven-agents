import assert from "node:assert/strict";
import test from "node:test";
import { encode, type JWT } from "next-auth/jwt";
import { identityFromVerifiedJwt, verifiedJwtIdentity } from "./verified-jwt";

const AUTH_SECRET = "verified-jwt-identity-test-secret";
const OTHER_SECRET = "verified-jwt-identity-other-secret";
const USER_ID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const INSECURE_COOKIE = "authjs.session-token";
const SECURE_COOKIE = "__Secure-authjs.session-token";

test("extracts canonical identity from Auth.js insecure and secure cookies", async () => {
  await Promise.all(
    (
      [
        ["http://localhost/api/subscription", { AUTH_SECRET }, INSECURE_COOKIE],
        [
          "http://internal/api/subscription",
          { AUTH_SECRET, AUTH_URL: "https://app.example" },
          SECURE_COOKIE,
        ],
      ] as const
    ).map(async ([url, environment, cookieName]) => {
      const request = await signedRequest(url, cookieName, token());

      assert.deepEqual(await verifiedJwtIdentity(request, { environment }), {
        authVersion: 4,
        userId: USER_ID,
      });
    })
  );
});

test("rejects invalid signatures and expired Auth.js tokens", async () => {
  const wrongSignature = await signedRequest(
    "https://app.example/api/subscription",
    SECURE_COOKIE,
    token(),
    { secret: OTHER_SECRET }
  );
  const expired = await signedRequest(
    "https://app.example/api/subscription",
    SECURE_COOKIE,
    token(),
    { maxAge: -60 }
  );
  const options = {
    environment: { AUTH_SECRET, AUTH_URL: "https://app.example" },
  };

  assert.equal(await verifiedJwtIdentity(wrongSignature, options), null);
  assert.equal(await verifiedJwtIdentity(expired, options), null);
});

test("rejects missing, noncanonical, demo, and invalid-version claims", async () => {
  await Promise.all(
    (
      [
        { authVersion: 4, type: "demo" },
        { authVersion: 4, id: "demo:visitor", type: "demo" },
        { authVersion: 4, id: "synthetic-demo", type: "demo" },
        { authVersion: Number.NaN, id: USER_ID, type: "demo" },
        { authVersion: -1, id: USER_ID, type: "demo" },
      ] satisfies Partial<JWT>[]
    ).map(async (candidate) => {
      const request = await signedRequest(
        "https://app.example/api/subscription",
        SECURE_COOKIE,
        candidate
      );

      assert.equal(
        await verifiedJwtIdentity(request, {
          environment: { AUTH_SECRET, AUTH_URL: "https://app.example" },
        }),
        null
      );
    })
  );
});

test("does not accept query, body, headers, or bearer contents as cookie identity", async () => {
  const encoded = await encode({
    salt: SECURE_COOKIE,
    secret: AUTH_SECRET,
    token: token(),
  });
  const request = new Request(
    `https://app.example/api/subscription?userId=${USER_ID}`,
    {
      body: JSON.stringify({ authVersion: 4, userId: USER_ID }),
      headers: {
        authorization: `Bearer ${encoded}`,
        "content-type": "application/json",
        "x-user-id": USER_ID,
      },
      method: "POST",
    }
  );

  assert.equal(
    await verifiedJwtIdentity(request, {
      environment: { AUTH_SECRET, AUTH_URL: "https://app.example" },
    }),
    null
  );
  assert.equal(request.bodyUsed, false);
});

test("pure identity validation keeps plan claims out of the authority result", () => {
  assert.deepEqual(
    identityFromVerifiedJwt({
      ...token(),
      subscribedUntil: "2099-01-01T00:00:00.000Z",
      type: "subscriber",
    }),
    {
      authVersion: 4,
      userId: USER_ID,
    }
  );
});

async function signedRequest(
  url: string,
  cookieName: string,
  claims: Partial<JWT>,
  options: { maxAge?: number; secret?: string } = {}
): Promise<Request> {
  const value = await encode({
    maxAge: options.maxAge,
    salt: cookieName,
    secret: options.secret ?? AUTH_SECRET,
    token: claims,
  });
  return new Request(url, {
    headers: { cookie: `${cookieName}=${value}` },
  });
}

function token(): JWT {
  return {
    authVersion: 4,
    id: USER_ID,
    type: "demo",
  };
}
