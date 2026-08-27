import assert from "node:assert/strict";
import test from "node:test";
import { formatRevocationOutput } from "./account-output";

test("session revocation output is aggregate-only", () => {
  const output = formatRevocationOutput({
    authVersion: 8,
    id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
  });

  assert.equal(
    output,
    "account_id: 6ba7b810-9dad-11d1-80b4-00c04fd430c8\nauth_version: 8\n"
  );
  assert.doesNotMatch(output, /email|subscribedUntil|POSTGRES_URL/i);
});
