import assert from "node:assert/strict";
import test from "node:test";
import {
  APPLICATION_CALLBACK_PARAM,
  applicationBasePath,
  applicationHomePath,
  applicationLoginPath,
  applicationPath,
  browserApplicationPath,
  configuredApplicationBasePath,
  safeApplicationCallbackPath,
} from "./application-path";

test("application paths consistently include normal and demo base paths", () => {
  assert.equal(applicationPath("/api/subscription", ""), "/api/subscription");
  assert.equal(
    applicationPath("/api/subscription", "/demo"),
    "/demo/api/subscription"
  );
  assert.equal(applicationPath("/api/checkout", "/demo"), "/demo/api/checkout");
  assert.equal(
    applicationPath("/account?checkout=success", "/demo"),
    "/demo/account?checkout=success"
  );
});

test("configured application base paths derive only from the server demo mode", () => {
  assert.equal(configuredApplicationBasePath({}), "");
  assert.equal(configuredApplicationBasePath({ IS_DEMO: "0" }), "");
  assert.equal(configuredApplicationBasePath({ IS_DEMO: "1" }), "/demo");
});

test("browser application paths use the inlined public base path", () => {
  const previous = process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.NEXT_PUBLIC_BASE_PATH = "/demo";
  try {
    assert.equal(
      browserApplicationPath("/api/subscription"),
      "/demo/api/subscription"
    );
    assert.equal(browserApplicationPath("/api/checkout"), "/demo/api/checkout");
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_BASE_PATH = previous;
    }
  }
});

test("application paths reject ambiguous or cross-origin inputs", () => {
  for (const value of ["demo", "/demo/", "//example.test", "/demo?query=1"]) {
    assert.throws(() => applicationBasePath(value));
  }
  for (const value of ["api/subscription", "//example.test/path", "/a/../b"]) {
    assert.throws(() => applicationPath(value, "/demo"));
  }
});

test("safe application callbacks preserve canonical query and fragments", () => {
  assert.equal(applicationHomePath(""), "/");
  assert.equal(applicationHomePath("/demo"), "/demo");
  assert.equal(
    safeApplicationCallbackPath(
      "/account?source=ledger&checkout=success#allowance",
      ""
    ),
    "/account?source=ledger&checkout=success#allowance"
  );
  assert.equal(
    safeApplicationCallbackPath(
      "/demo/account?source=ledger&checkout=success#allowance",
      "/demo"
    ),
    "/demo/account?source=ledger&checkout=success#allowance"
  );
});

test("application login paths encode one validated callback without double-prefixing", () => {
  const callback = "/demo/account?source=ledger&checkout=success#allowance";
  const loginPath = applicationLoginPath(callback, "/demo");
  const parsed = new URL(loginPath, "https://example.test");

  assert.equal(parsed.pathname, "/login");
  assert.equal(parsed.searchParams.get(APPLICATION_CALLBACK_PARAM), callback);
  assert.equal(loginPath.startsWith("/demo/login"), false);
});

test("unsafe application callbacks fall back to the configured application home", () => {
  for (const value of [
    "https://attacker.test/account",
    "//attacker.test/account",
    "%68%74%74%70%73%3A%2F%2Fattacker.test",
    "/demo/%2e%2e/account",
    "/demo/%",
    "/account",
    "/demo-other/account",
  ]) {
    assert.equal(safeApplicationCallbackPath(value, "/demo"), "/demo", value);
  }
  assert.equal(
    safeApplicationCallbackPath("/a/../account", ""),
    "/",
    "non-canonical dot segments"
  );
  assert.equal(
    safeApplicationCallbackPath("\u0000/account", ""),
    "/",
    "malformed input"
  );
});
