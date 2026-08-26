import assert from "node:assert/strict";
import test from "node:test";
import {
  needsRefresh,
  parseStoredCredential,
  REFRESH_MARGIN_MS,
  serializeCredential,
} from "./shape";

const OAUTH = {
  access: "gho_access",
  expiresAt: 1_800_000_000_000,
  kind: "oauth" as const,
  refresh: "ghr_refresh",
};

test("an oauth credential round-trips", () => {
  const parsed = parseStoredCredential(serializeCredential(OAUTH));

  assert.deepEqual(parsed, OAUTH);
});

test("a pasted PAT round-trips unchanged", () => {
  // The token is an opaque string chosen by GitHub. Anything we do to it
  // beyond storing it verbatim is a way to reject a valid credential.
  const pat = { kind: "pat" as const, token: "github_pat_11ABC" };

  assert.equal(serializeCredential(pat), "github_pat_11ABC");
  assert.deepEqual(parseStoredCredential("github_pat_11ABC"), pat);
});

test("a credential stored before oauth existed still reads as a PAT", () => {
  // The whole reason both shapes share one column: an existing subscriber's
  // credential must keep working across this change.
  assert.deepEqual(parseStoredCredential("gho_legacy_value"), {
    kind: "pat",
    token: "gho_legacy_value",
  });
});

test("JSON that is not ours is treated as a PAT, not parsed", () => {
  // A token that happens to start with a brace is still a token.
  const odd = '{"not":"ours"}';

  assert.deepEqual(parseStoredCredential(odd), { kind: "pat", token: odd });
});

test("our envelope missing half its fields is refused", () => {
  // Returning it would hand back a credential that cannot be refreshed and
  // fails silently once the access token expires.
  const broken = JSON.stringify({ a: "only-access", v: "oc.oauth.v1" });

  assert.equal(parseStoredCredential(broken), null);
});

test("an empty value is nothing, not an empty PAT", () => {
  assert.equal(parseStoredCredential(""), null);
  assert.equal(parseStoredCredential("   "), null);
});

test("a token close to expiry is refreshed before it is used", () => {
  // A run reads the credential once at the start and can take minutes. A
  // token with seconds left would expire mid-run.
  const now = OAUTH.expiresAt - REFRESH_MARGIN_MS + 1000;

  assert.equal(needsRefresh(OAUTH, now), true);
});

test("a token with plenty of life is left alone", () => {
  const now = OAUTH.expiresAt - REFRESH_MARGIN_MS - 60_000;

  assert.equal(needsRefresh(OAUTH, now), false);
});

test("an already-expired token needs refreshing", () => {
  assert.equal(needsRefresh(OAUTH, OAUTH.expiresAt + 1), true);
});

test("a PAT is never refreshed", () => {
  // It has no expiry we can see and no refresh token to use.
  assert.equal(
    needsRefresh({ kind: "pat", token: "x" }, Number.MAX_SAFE_INTEGER),
    false
  );
});
