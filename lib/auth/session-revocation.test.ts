import assert from "node:assert/strict";
import test from "node:test";
import { sessionAuthorityMatches } from "./session-revocation";

const NOW = new Date("2026-08-27T00:00:00.000Z");

test("an unchanged auth version with an active subscription remains authoritative", () => {
  assert.equal(
    sessionAuthorityMatches({
      database: {
        authVersion: 4,
        subscribedUntil: new Date("2026-08-28T00:00:00.000Z"),
      },
      now: NOW,
      tokenAuthVersion: 4,
    }),
    true
  );
});

test("incrementing the server auth version immediately revokes the token", () => {
  assert.equal(
    sessionAuthorityMatches({
      database: {
        authVersion: 5,
        subscribedUntil: new Date("2026-08-28T00:00:00.000Z"),
      },
      now: NOW,
      tokenAuthVersion: 4,
    }),
    false
  );
});

test("expired or invalid subscription authority fails closed", () => {
  for (const subscribedUntil of [
    null,
    new Date("2026-08-26T23:59:59.000Z"),
    new Date(Number.NaN),
  ]) {
    assert.equal(
      sessionAuthorityMatches({
        database: { authVersion: 4, subscribedUntil },
        now: NOW,
        tokenAuthVersion: 4,
      }),
      false
    );
  }
});

test("missing or malformed token versions fail closed", () => {
  for (const tokenAuthVersion of [
    undefined,
    null,
    -1,
    1.5,
    Number.NaN,
  ] as unknown[]) {
    assert.equal(
      sessionAuthorityMatches({
        database: {
          authVersion: 4,
          subscribedUntil: new Date("2026-08-28T00:00:00.000Z"),
        },
        now: NOW,
        tokenAuthVersion: tokenAuthVersion as number,
      }),
      false
    );
  }
});
