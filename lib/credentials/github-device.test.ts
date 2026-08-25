import assert from "node:assert/strict";
import test from "node:test";
import { interpretTokenResponse } from "./github-device";

const NOW = 1_800_000_000_000;

test("a successful exchange yields a refreshable credential", () => {
  const result = interpretTokenResponse(
    {
      access_token: "gho_a",
      expires_in: 28_800,
      refresh_token: "ghr_r",
    },
    NOW
  );

  assert.equal(result.kind, "authorized");
  if (result.kind === "authorized" && result.credential.kind === "oauth") {
    assert.equal(result.credential.access, "gho_a");
    assert.equal(result.credential.refresh, "ghr_r");
    assert.equal(result.credential.expiresAt, NOW + 28_800_000);
  }
});

test("authorization_pending means keep polling", () => {
  assert.equal(
    interpretTokenResponse({ error: "authorization_pending" }, NOW).kind,
    "pending"
  );
});

test("slow_down is distinct from pending, because the interval must change", () => {
  // Treating it as pending keeps polling at the old rate and GitHub keeps
  // returning slow_down -- a loop that never completes.
  assert.equal(
    interpretTokenResponse({ error: "slow_down" }, NOW).kind,
    "slow_down"
  );
});

test("access_denied is terminal and distinct from expiry", () => {
  // The user said no. Retrying would re-prompt someone who declined.
  assert.equal(
    interpretTokenResponse({ error: "access_denied" }, NOW).kind,
    "denied"
  );
});

test("an unknown error stops polling rather than looping forever", () => {
  for (const error of ["expired_token", "incorrect_device_code", "boom"]) {
    assert.equal(interpretTokenResponse({ error }, NOW).kind, "expired", error);
  }
});

test("a token with no refresh token is stored as a PAT", () => {
  // The app has token expiry switched off, so the access token does not
  // expire. Storing it as oauth would schedule a refresh that always fails.
  const result = interpretTokenResponse({ access_token: "gho_forever" }, NOW);

  assert.equal(result.kind, "authorized");
  if (result.kind === "authorized") {
    assert.deepEqual(result.credential, {
      kind: "pat",
      token: "gho_forever",
    });
  }
});

test("a response with neither token nor error is not treated as success", () => {
  assert.equal(interpretTokenResponse({}, NOW).kind, "expired");
});

test("a missing expires_in falls back to GitHub's documented eight hours", () => {
  const result = interpretTokenResponse(
    { access_token: "a", refresh_token: "r" },
    NOW
  );

  assert.equal(result.kind, "authorized");
  if (result.kind === "authorized" && result.credential.kind === "oauth") {
    assert.equal(result.credential.expiresAt, NOW + 28_800_000);
  }
});
