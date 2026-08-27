import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  MAX_RUNNER_TOKEN_BYTES,
  MAX_RUNNER_TOKEN_SEGMENT_BYTES,
  runnerClaimsSchema,
  splitToken,
} from "./identity";

test("base64url round-trips bytes without padding", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  const encoded = base64UrlEncode(bytes);

  assert.ok(!encoded.includes("="), "must not be padded");
  assert.ok(!encoded.includes("+") && !encoded.includes("/"), "url safe");
  assert.deepEqual(base64UrlDecode(encoded), bytes);
});

test("claims reject anything the worker must not trust", () => {
  const valid = {
    authVersion: 0,
    exp: 1_800_000_000,
    kid: "key-2026-08",
    plan: "subscriber",
    sub: "user-1",
    tenant: "acme",
  };
  assert.equal(runnerClaimsSchema.parse(valid).tenant, "acme");

  for (const bad of [
    { ...valid, plan: "admin" },
    { ...valid, tenant: "" },
    { ...valid, exp: -1 },
    { ...valid, extra: "smuggled" },
    { ...valid, kid: "" },
    { ...valid, authVersion: -1 },
  ]) {
    assert.throws(
      () => runnerClaimsSchema.parse(bad),
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test("a token without exactly two segments is refused", () => {
  assert.equal(splitToken("only-one-segment"), null);
  assert.equal(splitToken("a.b.c"), null);
  assert.equal(splitToken(""), null);

  const parts = splitToken("payload.signature");
  assert.deepEqual(parts, { payload: "payload", signature: "signature" });
});

test("a token with an empty segment is refused", () => {
  // Not covered by the two-segment check: these both split into exactly two
  // parts, so only the emptiness check rejects them.
  assert.equal(splitToken(".signature"), null);
  assert.equal(splitToken("payload."), null);
  assert.equal(splitToken("."), null);
});

test("token and segment sizes are bounded before decoding", () => {
  assert.equal(
    splitToken(`${"a".repeat(MAX_RUNNER_TOKEN_SEGMENT_BYTES + 1)}.signature`),
    null
  );
  assert.equal(
    splitToken(`${"a".repeat(MAX_RUNNER_TOKEN_BYTES)}.signature`),
    null
  );
});

test("claims bound the fields the worker trusts for isolation", () => {
  const valid = {
    authVersion: 0,
    exp: 1_800_000_000,
    kid: "key-2026-08",
    plan: "subscriber",
    sub: "user-1",
    tenant: "acme",
  };

  // `tenant` is the isolation boundary. An unbounded value must not parse.
  assert.equal(
    runnerClaimsSchema.parse({ ...valid, tenant: "t".repeat(64) }).tenant
      .length,
    64
  );
  assert.throws(() =>
    runnerClaimsSchema.parse({ ...valid, tenant: "t".repeat(65) })
  );

  assert.equal(
    runnerClaimsSchema.parse({ ...valid, sub: "s".repeat(128) }).sub.length,
    128
  );
  assert.throws(() =>
    runnerClaimsSchema.parse({ ...valid, sub: "s".repeat(129) })
  );
});
