import assert from "node:assert/strict";
import test from "node:test";
import { exchangeRejectionCode } from "./user-auth";

test("GitHub's own refusal reasons stay distinguishable", () => {
  // A mistyped client secret, an expired sign-in, and a misconfigured callback
  // address are three different repairs. Collapsing them into one code named
  // none of them, which is what made the live failure undiagnosable.
  assert.equal(
    exchangeRejectionCode("incorrect_client_credentials"),
    "github_oauth_credentials_rejected"
  );
  assert.equal(
    exchangeRejectionCode("bad_verification_code"),
    "github_oauth_code_expired"
  );
  assert.equal(
    exchangeRejectionCode("expired_token"),
    "github_oauth_code_expired"
  );
  assert.equal(
    exchangeRejectionCode("redirect_uri_mismatch"),
    "github_oauth_redirect_mismatch"
  );
});

test("an unrecognized refusal stays generic rather than being guessed at", () => {
  for (const value of ["", "unsupported_grant_type", "something_new"]) {
    assert.equal(
      exchangeRejectionCode(value),
      "github_oauth_exchange_rejected",
      value
    );
  }
});
