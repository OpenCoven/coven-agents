import assert from "node:assert/strict";
import test from "node:test";
import NextAuth from "next-auth";
import { encode } from "next-auth/jwt";
import { ChatbotError } from "../lib/errors";
import { validateSessionToken } from "../lib/session-claims";

const SECRET = "hermetic-session-read-test-secret";
const NOW = new Date("2026-09-14T12:00:00.000Z");
const OWNER = "00000000-0000-4000-8000-000000000001";

for (const secure of [false, true]) {
  test(`Auth.js clears every revoked session cookie chunk (secure=${secure})`, async () => {
    const name = `${secure ? "__Secure-" : ""}authjs.session-token`;
    const response = await readSession(name, secure, () =>
      Promise.resolve({
        authVersion: 8,
        image: null,
        subscribedUntil: new Date("2099-01-01"),
      })
    );
    assert.equal(response.status, 200);
    assert.equal(await response.json(), null);
    const cleared = response.headers
      .getSetCookie()
      .filter((cookie) => cookie.startsWith(`${name}.`));
    assert.equal(cleared.length, 2);
    for (const cookie of cleared) {
      assert.match(cookie, /Max-Age=0/);
    }
  });
}

test("a classified outage does not instruct Auth.js to delete the session", async () => {
  const response = await readSession("authjs.session-token", false, () =>
    Promise.reject(new ChatbotError("bad_request:database"))
  );
  assert.equal(response.status, 200);
  assert.notEqual(await response.json(), null);
  assert.ok(
    response.headers
      .getSetCookie()
      .some(
        (cookie) =>
          cookie.startsWith("authjs.session-token=") &&
          !cookie.includes("Max-Age=0")
      )
  );
});

async function readSession(
  name: string,
  secure: boolean,
  findUser: Parameters<typeof validateSessionToken>[1]
) {
  const {
    handlers: { GET },
  } = NextAuth({
    basePath: "/api/auth",
    callbacks: {
      jwt: ({ token }) => validateSessionToken(token, findUser, NOW),
    },
    providers: [],
    secret: SECRET,
    trustHost: true,
    useSecureCookies: secure,
  });
  const encoded = await encode({
    salt: name,
    secret: SECRET,
    token: { authVersion: 7, id: OWNER, subscribedUntil: null, type: "demo" },
  });
  const middle = Math.floor(encoded.length / 2);
  return GET(
    new Request(`${secure ? "https" : "http"}://localhost/api/auth/session`, {
      headers: {
        cookie: `${name}.0=${encoded.slice(0, middle)}; ${name}.1=${encoded.slice(middle)}`,
      },
    }) as Parameters<typeof GET>[0]
  );
}
