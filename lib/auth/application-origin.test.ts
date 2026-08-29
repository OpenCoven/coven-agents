import assert from "node:assert/strict";
import test from "node:test";
import {
  approvedApplicationOrigin,
  configuredApplicationOrigin,
  parseCanonicalApplicationOrigin,
} from "./application-origin";

test("application origins accept exact HTTPS and loopback HTTP authorities", () => {
  assert.equal(
    approvedApplicationOrigin({
      APP_ORIGIN: "https://app.example/",
      AUTH_URL: "https://app.example",
    }),
    "https://app.example"
  );
  assert.equal(
    approvedApplicationOrigin({
      APP_ORIGIN: "http://127.0.0.1:3100",
    }),
    "http://127.0.0.1:3100"
  );
  assert.equal(
    parseCanonicalApplicationOrigin("Origin", "http://[::1]:3000"),
    "http://[::1]:3000"
  );
});

test("application origins reject unsafe, ambiguous, and unapproved authorities", () => {
  const rejected = [
    {},
    {
      APP_ORIGIN: "http://app.example",
      AUTH_URL: "http://app.example",
    },
    {
      APP_ORIGIN: "https://sibling.example",
      AUTH_URL: "https://app.example",
    },
    {
      APP_ORIGIN: "https://app.example:444",
      AUTH_URL: "https://app.example",
    },
    {
      APP_ORIGIN: "https://user:password@app.example",
      AUTH_URL: "https://app.example",
    },
    {
      APP_ORIGIN: "https://app.example/path",
      AUTH_URL: "https://app.example",
    },
    {
      APP_ORIGIN: "https://app.example",
      AUTH_URL: "https://app.example",
      NEXTAUTH_URL: "https://sibling.example",
    },
  ];

  for (const environment of rejected) {
    assert.throws(() => approvedApplicationOrigin(environment));
    assert.equal(configuredApplicationOrigin(environment), null);
  }
});

test("application origins bind Vercel hosts without accepting host syntax tricks", () => {
  assert.equal(
    approvedApplicationOrigin({
      APP_ORIGIN: "https://app.example",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
    }),
    "https://app.example"
  );
  assert.throws(() =>
    approvedApplicationOrigin({
      APP_ORIGIN: "https://app.example",
      VERCEL_URL: "https://app.example",
    })
  );
  assert.throws(() =>
    parseCanonicalApplicationOrigin("Origin", "https://app.example/")
  );
});
