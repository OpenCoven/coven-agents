import assert from "node:assert/strict";
import test from "node:test";
import type { RunnerClaims } from "@opencoven/agent-contracts";
import { checkRunnerAuthority } from "./runner-authority";

const CLAIMS: RunnerClaims = {
  authVersion: 4,
  exp: 1_800_000_000,
  kid: "current",
  plan: "subscriber",
  sub: "9c858901-8a57-4791-81fe-4c455b099bc9",
  tenant: "u_9c8589018a57479181fe4c455b099bc9",
};

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

test("authority sends the exact claim identity to the app and accepts only an allow response", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const result = await checkRunnerAuthority(
    CLAIMS,
    {
      appOrigin: "https://app.example/",
      serviceToken: "service-token",
    },
    (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return response(200, { allowed: true });
    }
  );

  assert.deepEqual(result, { kind: "allowed" });
  assert.equal(seenUrl, "https://app.example/api/internal/runner-authority");
  assert.equal(seenInit?.method, "POST");
  assert.equal(
    new Headers(seenInit?.headers).get("x-service-token"),
    "service-token"
  );
  assert.deepEqual(JSON.parse(String(seenInit?.body)), {
    authVersion: 4,
    plan: "subscriber",
    sub: CLAIMS.sub,
    tenant: CLAIMS.tenant,
  });
});

test("authority maps generic app denials without parsing private data", async () => {
  await Promise.all(
    (
      [
        [401, "unauthorized", { error: "unauthorized" }],
        [403, "subscription_required", { error: "subscription_required" }],
      ] as const
    ).map(async ([status, kind, body]) => {
      const result = await checkRunnerAuthority(
        CLAIMS,
        { appOrigin: "https://app.example", serviceToken: "service-token" },
        () => Promise.resolve(response(status, body))
      );
      assert.deepEqual(result, { kind });
    })
  );
});

test("authority fails closed on missing configuration, outage, malformed allow, and oversized response", async () => {
  const unavailable = await checkRunnerAuthority(
    CLAIMS,
    { appOrigin: undefined, serviceToken: "service-token" },
    () => Promise.reject(new Error("offline"))
  );
  assert.deepEqual(unavailable, { kind: "unavailable" });

  const outage = await checkRunnerAuthority(
    CLAIMS,
    { appOrigin: "https://app.example", serviceToken: "service-token" },
    () => Promise.reject(new Error("offline"))
  );
  assert.deepEqual(outage, { kind: "unavailable" });

  const malformed = await checkRunnerAuthority(
    CLAIMS,
    { appOrigin: "https://app.example", serviceToken: "service-token" },
    () => Promise.resolve(response(200, { allowed: false }))
  );
  assert.deepEqual(malformed, { kind: "unavailable" });

  const oversized = await checkRunnerAuthority(
    CLAIMS,
    { appOrigin: "https://app.example", serviceToken: "service-token" },
    () => Promise.resolve(new Response("x".repeat(2049), { status: 200 }))
  );
  assert.deepEqual(oversized, { kind: "unavailable" });
});
