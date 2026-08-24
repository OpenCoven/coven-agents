import assert from "node:assert/strict";
import test from "node:test";
import { resolveBoundTenant } from "./binding";

const CLAIMS = {
  exp: 1,
  plan: "subscriber" as const,
  sub: "u",
  tenant: "acme",
};

test("the tenant comes from the verified claim, not the request body", () => {
  // The shipped defect: the route authenticated the shared service token and
  // then trusted whatever tenant the body named, so anything holding that one
  // token could ask for any tenant's credential.
  const resolved = resolveBoundTenant(CLAIMS, { tenant: "victim" });

  assert.equal(resolved, "acme");
});

test("a body naming another tenant is refused outright, not silently ignored", () => {
  // Silently using the claim would let a compromised caller keep guessing
  // without ever learning it was being overruled. A mismatch is a signal.
  assert.throws(
    () => resolveBoundTenant(CLAIMS, { tenant: "victim" }, { strict: true }),
    /tenant/i
  );
});

test("a matching body tenant is accepted", () => {
  assert.equal(
    resolveBoundTenant(CLAIMS, { tenant: "acme" }, { strict: true }),
    "acme"
  );
});

test("an absent claim yields nothing, whatever the body says", () => {
  assert.equal(resolveBoundTenant(null, { tenant: "acme" }), null);
  assert.equal(resolveBoundTenant(null, { tenant: "victim" }), null);
});

test("a claim with an empty tenant is not a tenant", () => {
  for (const tenant of ["", "   "]) {
    assert.equal(resolveBoundTenant({ ...CLAIMS, tenant }, {}), null);
  }
});
