import assert from "node:assert/strict";
import test from "node:test";
import { selectPrimaryEmail } from "./github-email";

test("the primary verified address wins", () => {
  assert.equal(
    selectPrimaryEmail([
      { email: "other@example.com", primary: false, verified: true },
      { email: "me@example.com", primary: true, verified: true },
    ]),
    "me@example.com"
  );
});

test("an UNVERIFIED primary address is refused", () => {
  // This is the load-bearing one. Authorization here keys on email -- the beta
  // allowlist matches on it, and an existing account is claimed by it. GitHub
  // lets anyone type any address into their profile; only the verified flag
  // proves they control it. Accepting an unverified address would let a
  // stranger claim someone else's account by typing their address.
  assert.equal(
    selectPrimaryEmail([
      { email: "victim@example.com", primary: true, verified: false },
    ]),
    null
  );
});

test("falls back to a verified non-primary address", () => {
  assert.equal(
    selectPrimaryEmail([
      { email: "unverified@example.com", primary: true, verified: false },
      { email: "verified@example.com", primary: false, verified: true },
    ]),
    "verified@example.com"
  );
});

test("no verified address at all yields null", () => {
  assert.equal(
    selectPrimaryEmail([
      { email: "a@example.com", primary: true, verified: false },
      { email: "b@example.com", primary: false, verified: false },
    ]),
    null
  );
});

test("an empty list yields null", () => {
  assert.equal(selectPrimaryEmail([]), null);
});

test("addresses are normalised to lower case", () => {
  // The allowlist and the stored user row both compare lowercased, so an
  // address differing only in case must not create a second account.
  assert.equal(
    selectPrimaryEmail([
      { email: "  Me@Example.COM ", primary: true, verified: true },
    ]),
    "me@example.com"
  );
});

test("malformed entries are skipped rather than throwing", () => {
  assert.equal(
    selectPrimaryEmail([
      null as never,
      { email: "", primary: true, verified: true },
      { email: "good@example.com", primary: false, verified: true },
    ]),
    "good@example.com"
  );
});

test("an address too long for the column is refused", () => {
  // `User.email` is varchar(64). A longer address would be truncated or error
  // on insert; refusing is clearer than either.
  const long = `${"a".repeat(60)}@example.com`;

  assert.equal(
    selectPrimaryEmail([{ email: long, primary: true, verified: true }]),
    null
  );
});
