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
