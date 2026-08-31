import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./credential-device-poll.ts", import.meta.url),
  "utf8"
);

test("credential and completion queries share one database transaction", () => {
  assert.equal(
    source.match(/database\.transaction\(/g)?.length,
    1,
    "the adapter must open exactly one transaction"
  );
  assert.match(source, /database\.transaction\(async \(transaction\) =>/);
  assert.match(source, /transaction[\s\S]*\.insert\(tenantCredential\)/);
  assert.match(source, /transaction[\s\S]*\.update\(idempotencyRecord\)/);
  assert.doesNotMatch(source, /\bdb\.(?:insert|update)\(/);
});

test("the transaction fences the exact live device-poll claim", () => {
  for (const fence of [
    /eq\(idempotencyRecord\.id,\s*input\.claim\.recordId\)/,
    /eq\(idempotencyRecord\.ownerId,\s*input\.claim\.ownerId\)/,
    /eq\(idempotencyRecord\.operation,\s*input\.claim\.operation\)/,
    /eq\(idempotencyRecord\.keyHash,\s*input\.claim\.keyHash\)/,
    /storedIdempotencyClaimHash\(input\.claim\)/,
    /eq\(idempotencyRecord\.state,\s*"in_progress"\)/,
    /eq\(\s*idempotencyRecord\.expiresAt,\s*input\.claim\.claimExpiresAt\s*\)/,
    /gt\(idempotencyRecord\.expiresAt,\s*input\.completedAt\)/,
  ]) {
    assert.match(source, fence);
  }
  assert.match(source, /\.for\("update"\)/);
  assert.match(source, /tenantForUser\(input\.claim\.ownerId\)/);
});

test("the transaction locks and validates current session authority before credential storage", () => {
  const authorityIndex = source.indexOf("findAuthorityForUpdate");
  const credentialIndex = source.indexOf("async upsertCredential");

  assert.ok(authorityIndex >= 0);
  assert.ok(credentialIndex > authorityIndex);
  assert.match(source, /\.from\(user\)[\s\S]*\.for\("update"\)/);
  assert.match(source, /sessionAuthorityMatches\(/);
  assert.match(source, /tokenAuthVersion:\s*input\.authVersion/);
});
