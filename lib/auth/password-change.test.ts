import assert from "node:assert/strict";
import test from "node:test";
import { MIN_PASSWORD_LENGTH, passwordChangeDecision } from "./password-change";

const ok = {
  confirmation: "brand-new-secret",
  currentMatches: true,
  next: "brand-new-secret",
  signedIn: true,
};

test("a signed-in user with the right current password may change it", () => {
  assert.deepEqual(passwordChangeDecision(ok), { kind: "allowed" });
});

test("a signed-out caller is refused before anything else is considered", () => {
  // Checked first: an unauthenticated caller must never learn whether a
  // current password was right, because that turns this into an oracle.
  assert.deepEqual(
    passwordChangeDecision({ ...ok, currentMatches: false, signedIn: false }),
    { kind: "unauthorized" }
  );
});

test("a wrong current password is refused", () => {
  // Without this, a stolen session cookie is enough to seize the account
  // permanently by changing the password.
  assert.deepEqual(passwordChangeDecision({ ...ok, currentMatches: false }), {
    kind: "wrong_password",
  });
});

test("the confirmation must match", () => {
  assert.deepEqual(
    passwordChangeDecision({ ...ok, confirmation: "something-else" }),
    { kind: "mismatch" }
  );
});

test("a password shorter than the minimum is refused", () => {
  const short = "a".repeat(MIN_PASSWORD_LENGTH - 1);

  assert.deepEqual(
    passwordChangeDecision({ ...ok, confirmation: short, next: short }),
    { kind: "too_short" }
  );
});

test("exactly the minimum length is accepted", () => {
  // The boundary has to fall one way, and the message says "at least".
  const exact = "a".repeat(MIN_PASSWORD_LENGTH);

  assert.deepEqual(
    passwordChangeDecision({ ...ok, confirmation: exact, next: exact }),
    { kind: "allowed" }
  );
});

test("reusing the current password is refused", () => {
  // The whole point of the temporary password flow is that the temporary one
  // stops working. Allowing a no-op change would silently defeat it.
  assert.deepEqual(
    passwordChangeDecision({
      ...ok,
      nextEqualsCurrent: true,
    }),
    { kind: "unchanged" }
  );
});

test("length is counted in characters, not bytes", () => {
  // A short passphrase of multi-byte characters must not pass a byte-length
  // check that a reasonable person would read as character length.
  const emoji = "🔐".repeat(MIN_PASSWORD_LENGTH - 1);

  assert.deepEqual(
    passwordChangeDecision({ ...ok, confirmation: emoji, next: emoji }),
    { kind: "too_short" }
  );
});

test("whitespace-only passwords are refused", () => {
  const spaces = " ".repeat(MIN_PASSWORD_LENGTH + 2);

  assert.deepEqual(
    passwordChangeDecision({ ...ok, confirmation: spaces, next: spaces }),
    { kind: "too_short" }
  );
});

test("the ordering of checks does not leak", () => {
  // Signed-out plus every other problem at once still reports only
  // unauthorized.
  assert.deepEqual(
    passwordChangeDecision({
      confirmation: "nope",
      currentMatches: false,
      next: "x",
      signedIn: false,
    }),
    { kind: "unauthorized" }
  );
});
