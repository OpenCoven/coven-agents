import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchTenantCredential,
  normalizeCredential,
} from "./tenant-credentials.js";

function respondWith(status: number, body: unknown) {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

test("a stored credential is returned", async () => {
  const credential = await fetchTenantCredential(
    { harnessId: "copilot", tenant: "acme" },
    {
      endpoint: "https://app.test",
      fetchImpl: respondWith(200, { credential: "ghp_abc" }),
      identityToken: "identity",
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
      identityToken: "identity",
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
        identityToken: "identity",
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
        identityToken: "identity",
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
        identityToken: "identity",
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
      identityToken: "identity",
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

test("a 200 with no usable credential throws rather than yielding null", async () => {
  // Corrects an earlier assertion that enshrined the wrong behaviour. A 200
  // means the app found something; an unusable body is an app bug, and
  // reporting it as "this tenant has none" is the conflation this module is
  // built to avoid.
  await assert.rejects(() =>
    fetchTenantCredential(
      { harnessId: "copilot", tenant: "acme" },
      {
        endpoint: "https://app.test",
        fetchImpl: respondWith(200, {}),
        identityToken: "identity",
        serviceToken: "svc",
      }
    )
  );
});

test("a credential is normalised once so its two consumers agree", () => {
  // The leak this prevents: `requireHarness` trims before injecting into the
  // sandbox, while evidence redaction searches for whatever it was handed. If
  // those differ, a credential stored with stray whitespace is used in one
  // form and hunted for in another, so it survives redaction.
  assert.equal(normalizeCredential("  ghp_secret\n"), "ghp_secret");
  assert.equal(normalizeCredential("ghp_secret"), "ghp_secret");
});

test("a credential that is only whitespace is no credential", () => {
  for (const blank of ["", "   ", "\n\t"]) {
    assert.equal(normalizeCredential(blank), null);
  }
  assert.equal(normalizeCredential(null), null);
});
