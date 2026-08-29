import assert from "node:assert/strict";
import test from "node:test";
import { base64UrlEncode } from "@opencoven/agent-contracts";
import { POST } from "./route";

async function publicKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return base64UrlEncode(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey))
  );
}

async function withEnvironment<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    key: process.env.RUNNER_VERIFY_KEY,
    keyId: process.env.RUNNER_VERIFY_KEY_ID,
    service: process.env.RUNNER_SERVICE_TOKEN,
  };
  process.env.RUNNER_VERIFY_KEY_ID = "current";
  process.env.RUNNER_VERIFY_KEY = await publicKey();
  process.env.RUNNER_SERVICE_TOKEN = "service-secret";
  try {
    return await run();
  } finally {
    if (previous.key === undefined) {
      delete process.env.RUNNER_VERIFY_KEY;
    } else {
      process.env.RUNNER_VERIFY_KEY = previous.key;
    }
    if (previous.keyId === undefined) {
      delete process.env.RUNNER_VERIFY_KEY_ID;
    } else {
      process.env.RUNNER_VERIFY_KEY_ID = previous.keyId;
    }
    if (previous.service === undefined) {
      delete process.env.RUNNER_SERVICE_TOKEN;
    } else {
      process.env.RUNNER_SERVICE_TOKEN = previous.service;
    }
  }
}

test("the authority endpoint accepts only a bounded token body", async () => {
  await withEnvironment(async () => {
    const response = await POST(
      new Request("https://app.test/api/internal/runner-authority", {
        body: JSON.stringify({
          sub: "victim",
          token: "forged",
        }),
        headers: {
          "content-type": "application/json",
          "x-service-token": "service-secret",
        },
        method: "POST",
      })
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  });
});

test("a forged runner token is denied before database authority lookup", async () => {
  await withEnvironment(async () => {
    const response = await POST(
      new Request("https://app.test/api/internal/runner-authority", {
        body: JSON.stringify({ token: "forged.runner.token" }),
        headers: {
          "content-type": "application/json",
          "x-service-token": "service-secret",
        },
        method: "POST",
      })
    );

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  });
});

test("an oversized authority token is rejected before verification or database work", async () => {
  await withEnvironment(async () => {
    const response = await POST(
      new Request("https://app.test/api/internal/runner-authority", {
        body: JSON.stringify({ token: "x".repeat(8193) }),
        headers: {
          "content-type": "application/json",
          "x-service-token": "service-secret",
        },
        method: "POST",
      })
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  });
});
