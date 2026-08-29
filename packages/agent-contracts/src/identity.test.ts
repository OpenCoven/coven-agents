import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  TENANT_ID_PATTERN,
} from "./identity";

test("base64url round-trips bytes without padding", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  const encoded = base64UrlEncode(bytes);

  assert.ok(!encoded.includes("="), "must not be padded");
  assert.ok(!encoded.includes("+") && !encoded.includes("/"), "url safe");
  assert.deepEqual(base64UrlDecode(encoded), bytes);
});

test("tenant ids retain a bounded provider-safe alphabet", () => {
  for (const value of ["acme", "u_0123456789abcdef", "t".repeat(64)]) {
    assert.equal(TENANT_ID_PATTERN.test(value), true, value);
  }
  for (const value of [
    "",
    "tenant-with-dash",
    "tenant:colon",
    "t".repeat(65),
  ]) {
    assert.equal(TENANT_ID_PATTERN.test(value), false, value);
  }
});
