import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

function visit(cookie?: string): Promise<Response> {
  const request = new NextRequest("https://app.test/", {
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
  const response = await visit("coven-demo=already-has-one");

  assert.equal(
    response.headers.get("set-cookie"),
    null,
    "an existing demo cookie must not be reissued"
  );
});

test("an anonymous visit is never redirected to a guest provider", async () => {
  // The old behaviour inserted a User row per anonymous request. A redirect
  // here would mean the database is being written to again.
  const response = await visit();

  assert.notEqual(response.status, 307);
  assert.equal(response.headers.get("location"), null);
});
