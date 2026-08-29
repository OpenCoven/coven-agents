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

test("production Vercel origins bind only the project production authority", () => {
  assert.equal(
    approvedApplicationOrigin({
      APP_ORIGIN: "https://app.example",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: "generated-project.vercel.app",
    }),
    "https://app.example"
  );
  assert.throws(() =>
    approvedApplicationOrigin({
      APP_ORIGIN: "https://generated-project.vercel.app",
      VERCEL_ENV: "production",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: "generated-project.vercel.app",
    })
  );
  assert.throws(() =>
    approvedApplicationOrigin({
      APP_ORIGIN: "https://app.example",
      VERCEL_ENV: "production",
      VERCEL_URL: "generated-project.vercel.app",
    })
  );
});

test("preview Vercel origins bind only the current deployment authority", () => {
  assert.equal(
    approvedApplicationOrigin({
      APP_ORIGIN: "https://project-git-feature-team.vercel.app",
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: "project-git-feature-team.vercel.app",
    }),
    "https://project-git-feature-team.vercel.app"
  );
  assert.throws(() =>
    approvedApplicationOrigin({
      APP_ORIGIN: "https://app.example",
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
      VERCEL_URL: "project-git-feature-team.vercel.app",
    })
  );
  assert.throws(() =>
    approvedApplicationOrigin({
      APP_ORIGIN: "https://project-git-feature-team.vercel.app",
      VERCEL_ENV: "preview",
      VERCEL_PROJECT_PRODUCTION_URL: "app.example",
    })
  );
});

test("explicit Auth.js origins take precedence over Vercel authorities", () => {
  for (const override of [
    { AUTH_URL: "https://auth.example" },
    { NEXTAUTH_URL: "https://auth.example" },
  ]) {
    assert.equal(
      approvedApplicationOrigin({
        APP_ORIGIN: "https://auth.example",
        VERCEL_ENV: "production",
        ...override,
      }),
      "https://auth.example"
    );
  }
});

test("Vercel origins reject host syntax tricks and scheme or port mismatches", () => {
  for (const productionUrl of [
    "https://app.example",
    "app.example:444",
    "app.example/path",
    "app.example\\@attacker.example",
  ]) {
    assert.throws(() =>
      approvedApplicationOrigin({
        APP_ORIGIN: "https://app.example",
        VERCEL_ENV: "production",
        VERCEL_PROJECT_PRODUCTION_URL: productionUrl,
      })
    );
  }
  assert.throws(() =>
    approvedApplicationOrigin({
      APP_ORIGIN: "https://project-git-feature-team.vercel.app:444",
      VERCEL_ENV: "preview",
      VERCEL_URL: "project-git-feature-team.vercel.app:444",
    })
  );
  assert.throws(() =>
    parseCanonicalApplicationOrigin("Origin", "https://app.example/")
  );
});
