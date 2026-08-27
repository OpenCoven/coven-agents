import assert from "node:assert/strict";
import test from "node:test";
import { base64UrlEncode, type RunnerClaims } from "@opencoven/agent-contracts";
import { HarnessError, requireHarness } from "./harness-runner.js";
import { verifyRunnerToken } from "./identity.js";
import { normalizeCredential } from "./tenant-credentials.js";

/**
 * The properties this whole change exists to establish, asserted together.
 *
 * Every individual piece has its own tests. These are here because the
 * failures that actually happened were never inside a component — they were
 * between two components that each behaved correctly. A credential trimmed on
 * one side and searched for untrimmed on the other leaked despite every unit
 * test passing, the owner-secret grep being clean, and the isolation mutation
 * failing exactly as intended.
 *
 * So these assert agreement, not behaviour.
 */

const OWNER_SECRETS = {
  CLAUDE_CODE_OAUTH_TOKEN: "owner-token",
  CODEX_API_KEY: "owner-token",
  COPILOT_GITHUB_TOKEN: "owner-token",
  GH_TOKEN: "owner-token",
  GITHUB_TOKEN: "owner-token",
};

function withOwnerSecrets(body: () => void): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(OWNER_SECRETS)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    body();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

test("no combination of owner secrets yields a run without a tenant credential", () => {
  // The single most important assertion in the spec. If this ever passes
  // because the run succeeded, tenant isolation is gone.
  withOwnerSecrets(() => {
    assert.throws(
      () => requireHarness("copilot", { credential: null }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === "harness_unauthenticated"
    );
  });
});

test("a credential is used and redacted in exactly the same form", () => {
  // The leak that four separate verification methods missed. `requireHarness`
  // trims before injecting into the sandbox; evidence redaction searches for
  // whatever it was handed. If those disagree by so much as a newline, the
  // token is used in one form and hunted for in another.
  for (const stored of [
    "ghp_plain",
    "  ghp_leading",
    "ghp_trailing  ",
    "\tghp_tabbed\n",
  ]) {
    const normalized = normalizeCredential(stored);
    assert.ok(normalized, `${JSON.stringify(stored)} should normalise`);

    const { auth } = requireHarness("copilot", { credential: normalized });

    assert.equal(
      auth.value,
      normalized,
      "the sandbox value and the redaction value must be identical"
    );
  }
});

test("whitespace is never mistaken for a credential", () => {
  for (const blank of ["", "   ", "\n", "\t\t"]) {
    assert.equal(normalizeCredential(blank), null);
    assert.throws(
      () =>
        requireHarness("copilot", { credential: normalizeCredential(blank) }),
      (error: unknown) =>
        error instanceof HarnessError &&
        error.code === "harness_unauthenticated"
    );
  }
});

test("a forged identity cannot name a tenant", async () => {
  // Unsigned, well-formed, and claiming someone else's tenant. The worker
  // holds only a verify key, so it can reject this but could never mint it.
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const claims: RunnerClaims = {
    authVersion: 0,
    exp: Math.floor(Date.now() / 1000) + 900,
    kid: "legacy",
    plan: "subscriber",
    sub: "attacker",
    tenant: "victim",
  };
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );

  const forgeries = [
    `${payload}.`,
    `${payload}.not-a-signature`,
    `${payload}.${base64UrlEncode(new Uint8Array(64))}`,
  ];
  const verdicts = await Promise.all(
    forgeries.map((forged) => verifyRunnerToken(forged, pair.publicKey))
  );

  for (const [index, verdict] of verdicts.entries()) {
    assert.equal(
      verdict,
      null,
      `${forgeries[index]?.slice(-20)} must not verify`
    );
  }
});

test("a valid claim for one tenant never reads as another", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const claims: RunnerClaims = {
    authVersion: 0,
    exp: Math.floor(Date.now() / 1000) + 900,
    kid: "legacy",
    plan: "subscriber",
    sub: "user-1",
    tenant: "acme",
  };
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    new TextEncoder().encode(payload)
  );
  const token = `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;

  const verified = await verifyRunnerToken(token, pair.publicKey);

  assert.equal(verified?.tenant, "acme");
  assert.notEqual(verified?.tenant, "victim");
});
