import assert from "node:assert/strict";
import test from "node:test";
import { fetchTenantCredential } from "./tenant-credentials.js";

function respondWith(status: number, body: unknown) {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

test("a stored credential is returned", async () => {
  const credential = await fetchTenantCredential(
    { harnessId: "copilot", tenant: "acme" },
    {
      endpoint: "https://app.test",
      fetchImpl: respondWith(200, { credential: "ghp_abc" }),
      serviceToken: "svc",
    }
  );

  assert.equal(credential, "ghp_abc");
});

test("a tenant with no credential yields null, not an error", async () => {
  const credential = await fetchTenantCredential(
    { harnessId: "copilot", tenant: "acme" },
    {
      endpoint: "https://app.test",
      fetchImpl: respondWith(404, { error: "no_credential" }),
      serviceToken: "svc",
    }
  );

  assert.equal(credential, null);
});

test("an unreachable app fails closed rather than returning null", async () => {
  // "We could not ask" must never be confused with "there is none". The
  // caller refuses a run on null; if a transport failure also returned null,
  // an outage would look identical to a tenant who has not configured a
  // credential — and the difference matters when the next step decides
  // whether to fall back.
  await assert.rejects(() =>
    fetchTenantCredential(
      { harnessId: "copilot", tenant: "acme" },
      {
        endpoint: "https://app.test",
        fetchImpl: () => Promise.reject(new Error("network down")),
        serviceToken: "svc",
      }
    )
  );
});

test("a non-404 error status throws rather than yielding null", async () => {
  // A 500 from the app is an outage, not an absent credential.
  await assert.rejects(() =>
    fetchTenantCredential(
      { harnessId: "copilot", tenant: "acme" },
      {
        endpoint: "https://app.test",
        fetchImpl: respondWith(500, { error: "boom" }),
        serviceToken: "svc",
      }
    )
  );
});

test("an unauthorized service token throws rather than yielding null", async () => {
  // A rejected service token is a misconfiguration. Treating it as "no
  // credential" would make every run silently unauthenticated.
  await assert.rejects(() =>
    fetchTenantCredential(
      { harnessId: "copilot", tenant: "acme" },
      {
        endpoint: "https://app.test",
        fetchImpl: respondWith(401, { error: "unauthorized" }),
        serviceToken: "svc",
      }
    )
  );
});

test("the service token is sent and the request names one tenant and harness", async () => {
  let seen: RequestInit | undefined;
  let seenUrl = "";

  await fetchTenantCredential(
    { harnessId: "copilot", tenant: "acme" },
    {
      endpoint: "https://app.test",
      fetchImpl: (url: string, init: RequestInit) => {
        seenUrl = url;
        seen = init;
        return Promise.resolve(
          new Response(JSON.stringify({ credential: "x" }), { status: 200 })
        );
      },
      serviceToken: "svc",
    }
  );

  const headers = new Headers(seen?.headers);
  assert.equal(headers.get("x-service-token"), "svc");
  assert.equal(seenUrl, "https://app.test/api/internal/credential");
  assert.deepEqual(JSON.parse(String(seen?.body)), {
    harnessId: "copilot",
    tenant: "acme",
  });
});

test("a 200 without a credential field yields null", async () => {
  const credential = await fetchTenantCredential(
    { harnessId: "copilot", tenant: "acme" },
    {
      endpoint: "https://app.test",
      fetchImpl: respondWith(200, {}),
      serviceToken: "svc",
    }
  );

  assert.equal(credential, null);
});
