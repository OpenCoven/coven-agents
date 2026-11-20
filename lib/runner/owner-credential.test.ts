import assert from "node:assert/strict";
import test from "node:test";
import { issueOwnerSecret, ownerBearerDigest } from "./owner-credential";

test("owner bearer digest round trips and each issuance is distinct", () => {
  const first = issueOwnerSecret();
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.equal(ownerBearerDigest(`Bearer ${first.secret}`), first.digest);
  assert.notEqual(issueOwnerSecret().digest, first.digest);
});

test("malformed and other audience bearer values have no lookup digest", () => {
  const { secret } = issueOwnerSecret();
  for (const header of [
    null,
    "",
    secret,
    `Bearer ${secret}x`,
    `Basic ${secret}`,
    `Bearer ${secret.replace("owner", "admin")}`,
    "a".repeat(8192),
  ]) {
    assert.equal(ownerBearerDigest(header), null);
  }
});
