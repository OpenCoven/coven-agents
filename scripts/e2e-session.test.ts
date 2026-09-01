import assert from "node:assert/strict";
import test from "node:test";
import { sessionCookies } from "../tests/e2e/session";

test("generated hermetic session cookies are scoped to the IPv4 app host", async () => {
  const cookies = await sessionCookies("subscriber", {
    environment: {
      APP_ORIGIN: "http://127.0.0.1:43123",
      AUTH_SECRET: "test-hermetic-auth",
    },
  });
  assert.deepEqual(
    cookies.map((cookie) => cookie.domain),
    ["127.0.0.1"]
  );
});

test("generated normal session cookies remain scoped to localhost", async () => {
  const cookies = await sessionCookies("subscriber", {
    environment: { AUTH_SECRET: "test-normal-auth" },
  });
  assert.deepEqual(
    cookies.map((cookie) => cookie.domain),
    ["localhost"]
  );
});
