import assert from "node:assert/strict";
import test from "node:test";
import { sessionMenu } from "./session-menu";

test("a signed-in visitor is offered sign out", () => {
  const menu = sessionMenu({ email: "me@example.com" });

  assert.equal(menu.signedIn, true);
  assert.equal(menu.label, "Sign out");
});

test("a signed-out visitor is offered sign in, not sign out", () => {
  // The chat menu used to say "Login to your account" while the agents menu
  // said nothing at all. A visitor with no session must never be offered a
  // sign-out that would do nothing.
  const menu = sessionMenu({ email: null });

  assert.equal(menu.signedIn, false);
  assert.equal(menu.label, "Sign in");
});

test("both paths land on /login directly", () => {
  // Signing out used to return to "/", which redirects to the console, which
  // the beta gate redirects to /login -- three hops to reach the page the
  // other menu reached in one.
  assert.equal(sessionMenu({ email: "me@example.com" }).destination, "/login");
  assert.equal(sessionMenu({ email: null }).destination, "/login");
});

test("an empty string is treated as signed out", () => {
  assert.equal(sessionMenu({ email: "" }).signedIn, false);
  assert.equal(sessionMenu({ email: undefined }).signedIn, false);
});
