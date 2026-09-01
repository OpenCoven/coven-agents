import assert from "node:assert/strict";
import test from "node:test";
import {
  betaVerdict,
  isAllowedIdentity,
  isBetaExempt,
  readBetaGate,
} from "./beta";

const ON = { BETA_ALLOWLIST: "me@example.com", BETA_MODE: "on" };

test("the gate is off unless BETA_MODE says on", () => {
  // Default-off, because a gate that switches itself on would brick every
  // local checkout the moment this file merged.
  assert.equal(readBetaGate({}).enabled, false);
  assert.equal(
    readBetaGate({ BETA_ALLOWLIST: "me@example.com" }).enabled,
    false
  );
  assert.equal(readBetaGate(ON).enabled, true);
});

test("BETA_MODE only counts when it is exactly on", () => {
  // "false" and "0" are the values a person types meaning off. Truthiness
  // would read both as on and lock everyone out.
  for (const BETA_MODE of ["false", "0", "off", "", "ON "]) {
    assert.equal(
      readBetaGate({ BETA_ALLOWLIST: "me@example.com", BETA_MODE }).enabled,
      false,
      `${JSON.stringify(BETA_MODE)} must not enable the gate`
    );
  }
});

test("the allowlist is split, trimmed and lowercased", () => {
  const gate = readBetaGate({
    BETA_ALLOWLIST: " Me@Example.com , other@example.com ,,",
    BETA_MODE: "on",
  });

  assert.deepEqual(gate.allowlist, ["me@example.com", "other@example.com"]);
});

test("an enabled gate with an empty allowlist denies everyone", () => {
  // Fails closed. A typo'd or unset allowlist while the gate is on must lock
  // the door, not remove it -- the opposite default silently publishes the app.
  const gate = readBetaGate({ BETA_ALLOWLIST: "", BETA_MODE: "on" });

  assert.equal(gate.enabled, true);
  assert.equal(betaVerdict(gate, "/", "me@example.com"), "deny");
});

test("an allowlisted signed-in user is allowed", () => {
  assert.equal(betaVerdict(readBetaGate(ON), "/", "me@example.com"), "allow");
});

test("email matching ignores case and surrounding space", () => {
  const gate = readBetaGate(ON);

  assert.equal(betaVerdict(gate, "/", " ME@Example.COM "), "allow");
});

test("a signed-out visitor is denied", () => {
  // The demo session is stateless and needs no sign-in, so without this the
  // beta is not closed at all -- anyone reaching the URL gets a demo tenant.
  assert.equal(betaVerdict(readBetaGate(ON), "/", null), "deny");
});

test("a signed-in stranger is denied", () => {
  assert.equal(
    betaVerdict(readBetaGate(ON), "/", "stranger@example.com"),
    "deny"
  );
});

test("a substring of an allowed address is not allowed", () => {
  // Guards against matching with `includes`. These addresses are different
  // people at different domains.
  const gate = readBetaGate(ON);

  assert.equal(betaVerdict(gate, "/", "me@example.com.attacker.test"), "deny");
  assert.equal(betaVerdict(gate, "/", "notme@example.com"), "deny");
});

test("the machine-triggered reconciliation path is exempt", () => {
  // Vercel Cron and manual recovery carry dedicated bearer authority rather
  // than an Auth.js cookie. Gating this path would disable recovery rather than
  // close the beta.
  assert.equal(isBetaExempt("/api/internal/runner-reconcile"), true);
  assert.equal(
    betaVerdict(readBetaGate(ON), "/api/internal/runner-reconcile", null),
    "allow"
  );
});

test("the Stripe reconciliation machine route is exactly exempt", () => {
  assert.equal(isBetaExempt("/api/internal/stripe-reconcile"), true);
  assert.equal(
    betaVerdict(readBetaGate(ON), "/api/internal/stripe-reconcile", null),
    "allow"
  );
  assert.equal(isBetaExempt("/api/internal/stripe-reconcile/extra"), false);
  assert.equal(isBetaExempt("/api/internal/stripe-reconcile-now"), false);
});

test("the runner health and operator diagnostic paths are exactly exempt", () => {
  for (const pathname of ["/api/health", "/api/diagnostics/sandbox"]) {
    assert.equal(isBetaExempt(pathname), true, pathname);
    assert.equal(betaVerdict(readBetaGate(ON), pathname, null), "allow");
  }
});

test("runner machine-route descendants and lookalikes are not exempt", () => {
  for (const pathname of [
    "/api/health/ready",
    "/api/healthcheck",
    "/api/diagnostics/future",
    "/api/diagnostics/sandbox/extra",
    "/api/diagnostics/sandbox-check",
  ]) {
    assert.equal(isBetaExempt(pathname), false, pathname);
    assert.equal(betaVerdict(readBetaGate(ON), pathname, null), "deny");
  }
});

test("retired and future internal routes are not exempt", () => {
  for (const pathname of [
    "/api/internal",
    "/api/internal/credential",
    "/api/internal/future-service",
    "/api/internal/runner-reconcile/extra",
  ]) {
    assert.equal(isBetaExempt(pathname), false, pathname);
    assert.equal(betaVerdict(readBetaGate(ON), pathname, null), "deny");
  }
});

test("sign-in stays reachable so the gate is escapable", () => {
  for (const pathname of ["/login", "/api/auth/session", "/ping"]) {
    assert.equal(isBetaExempt(pathname), true, `${pathname} must be exempt`);
  }
});

test("registration is closed during the beta", () => {
  // An open register route lets a stranger create the account the gate is
  // meant to withhold.
  assert.equal(isBetaExempt("/register"), false);
  assert.equal(betaVerdict(readBetaGate(ON), "/register", null), "deny");
});

test("an exempt prefix does not leak to lookalike paths", () => {
  // Lookalike paths must not inherit an exact route's exemption.
  assert.equal(isBetaExempt("/api/internalish"), false);
  assert.equal(isBetaExempt("/api/internal/runner-reconcile-now"), false);
  assert.equal(isBetaExempt("/loginish"), false);
});

test("a disabled gate allows everything", () => {
  const gate = readBetaGate({});

  assert.equal(betaVerdict(gate, "/", null), "allow");
  assert.equal(betaVerdict(gate, "/register", null), "allow");
});

test("an invited identity is allowed regardless of path", () => {
  assert.equal(isAllowedIdentity(readBetaGate(ON), "me@example.com"), true);
});

test("a stranger is not an allowed identity even on an exempt path", () => {
  // `betaVerdict` says "allow" for /login so the gate stays escapable. That is
  // a different question from whether the person is invited, and conflating
  // them loops: refused at /, sent to /login, bounced back to / for being
  // signed in, forever.
  const gate = readBetaGate(ON);

  assert.equal(betaVerdict(gate, "/login", "stranger@example.com"), "allow");
  assert.equal(isAllowedIdentity(gate, "stranger@example.com"), false);
});

test("a signed-out visitor is not an allowed identity", () => {
  assert.equal(isAllowedIdentity(readBetaGate(ON), null), false);
});

test("identity matching ignores case and space", () => {
  assert.equal(isAllowedIdentity(readBetaGate(ON), " ME@Example.COM "), true);
});

test("a disabled gate admits everyone", () => {
  assert.equal(isAllowedIdentity(readBetaGate({}), null), true);
});

test("the Stripe webhook is exempt from the gate", () => {
  // Not cosmetic: Stripe does not follow redirects when delivering a webhook,
  // so a gated endpoint turns every event into a delivery failure and paid
  // subscriptions silently stop being recorded. The route authenticates by
  // signature, which is stronger than the gate it skips.
  assert.equal(isBetaExempt("/api/stripe/webhook"), true);
  assert.equal(
    betaVerdict(readBetaGate(ON), "/api/stripe/webhook", null),
    "allow"
  );
});

test("a lookalike stripe path is not exempt", () => {
  assert.equal(isBetaExempt("/api/stripeish"), false);
});
