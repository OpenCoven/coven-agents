import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function visit(cookie?: string, path = "/"): Promise<Response> {
  const request = new NextRequest(`https://app.test${path}`, {
    headers: cookie ? { cookie } : {},
  });
  return proxy(request) as Promise<Response>;
}

async function withClosedBeta<T>(operation: () => Promise<T>): Promise<T> {
  const previousMode = process.env.BETA_MODE;
  const previousAllowlist = process.env.BETA_ALLOWLIST;
  process.env.BETA_MODE = "on";
  delete process.env.BETA_ALLOWLIST;
  try {
    return await operation();
  } finally {
    if (previousMode === undefined) {
      delete process.env.BETA_MODE;
    } else {
      process.env.BETA_MODE = previousMode;
    }
    if (previousAllowlist === undefined) {
      delete process.env.BETA_ALLOWLIST;
    } else {
      process.env.BETA_ALLOWLIST = previousAllowlist;
    }
  }
}

test("a first-time anonymous visitor is given a demo cookie", async () => {
  const response = await visit();

  const set = response.headers.get("set-cookie") ?? "";
  assert.match(set, /coven-demo=/);
  assert.match(set, /HttpOnly/i);
  assert.match(set, /SameSite=lax/i);
});

test("an existing demo cookie is not reissued", async () => {
  // Reissuing would replace the id the tenant is derived from. Named for what
  // it actually asserts — the tenant-stability property it enables is proven
  // in lib/session.test.ts, against the function that derives the tenant.
  const response = await visit(
    "coven-demo=3f2504e0-4f89-11d3-9a0c-0305e82c3301"
  );

  assert.equal(
    response.headers.get("set-cookie"),
    null,
    "an existing demo cookie must not be reissued"
  );
});

test("a demo cookie the server did not mint is replaced", async () => {
  // `demoTenant` ignores a value that is not one of its own uuids, so leaving
  // it in place would hand the visitor a fresh random tenant on every request:
  // every page still renders while their state silently fails to follow them.
  const response = await visit("coven-demo=already-has-one");

  assert.match(
    response.headers.get("set-cookie") ?? "",
    /coven-demo=/,
    "an unusable demo cookie must be replaced, not kept"
  );
});

test("an anonymous visit is never redirected to a guest provider", async () => {
  // The old behaviour inserted a User row per anonymous request. A redirect
  // here would mean the database is being written to again.
  const response = await visit();

  assert.notEqual(response.status, 307);
  assert.equal(response.headers.get("location"), null);
});

test("the admin page refuses before rendering or minting a demo identity", async () => {
  const response = await visit(undefined, "/admin");

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("closed beta keeps reconciliation reachable with a query string", async () => {
  const response = await withClosedBeta(() =>
    visit(undefined, "/api/internal/runner-reconcile?source=cron")
  );

  assert.equal(response.headers.get("location"), null);
});

test("closed beta keeps exact runner machine routes reachable with query strings", async () => {
  await withClosedBeta(async () => {
    await Promise.all(
      [
        "/api/health?probe=runner",
        "/api/diagnostics/sandbox?probe=operator",
      ].map(async (path) => {
        const response = await visit(undefined, path);

        assert.equal(response.headers.get("location"), null, path);
      })
    );
  });
});

test("closed beta redirects runner machine-route descendants and lookalikes", async () => {
  await withClosedBeta(async () => {
    await Promise.all(
      [
        "/api/health/ready?probe=runner",
        "/api/healthcheck?probe=runner",
        "/api/diagnostics/future?probe=operator",
        "/api/diagnostics/sandbox/extra?probe=operator",
        "/api/diagnostics/sandbox-check?probe=operator",
      ].map(async (path) => {
        const response = await visit(undefined, path);

        assert.equal(response.status, 307, path);
        assert.match(
          response.headers.get("location") ?? "",
          /\/login\?beta=1$/u,
          path
        );
      })
    );
  });
});

test("closed beta does not bypass retired internal routes", async () => {
  const response = await withClosedBeta(() =>
    visit(undefined, "/api/internal/credential?phase=issue")
  );

  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") ?? "", /\/login\?beta=1$/u);
});
