import assert from "node:assert/strict";
import test from "node:test";
import {
  applicationBasePath,
  applicationPath,
  browserApplicationPath,
  configuredApplicationBasePath,
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
