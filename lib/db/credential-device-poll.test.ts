import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./credential-device-poll.ts", import.meta.url),
  "utf8"
);
const commitSource = readFileSync(
  new URL("../credentials/device-poll-commit.ts", import.meta.url),
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
  const authorityIndex = commitSource.indexOf(
    "await transaction.findAuthorityForUpdate"
  );
  const currentTimeIndex = commitSource.indexOf(
    "transaction.currentTime()",
    authorityIndex
  );
  const credentialIndex = commitSource.indexOf(
    "transaction.upsertCredential",
    currentTimeIndex
  );

  assert.ok(authorityIndex >= 0);
  assert.ok(currentTimeIndex > authorityIndex);
  assert.ok(credentialIndex > currentTimeIndex);
  assert.match(source, /\.from\(user\)[\s\S]*\.for\("update"\)/);
  assert.match(source, /currentTime:\s*\(\)\s*=>\s*new Date\(\)/);
  assert.match(commitSource, /sessionAuthorityMatches\(/);
  assert.match(commitSource, /tokenAuthVersion:\s*input\.authVersion/);
});
