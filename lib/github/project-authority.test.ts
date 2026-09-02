import assert from "node:assert/strict";
import test from "node:test";
import {
  currentGitHubProjectAuthorityExpiresAt,
  type GitHubProjectAuthorityProof,
  isCurrentGitHubProjectAuthority,
  MAX_GITHUB_PROJECT_AUTHORITY_PROOF_LIFETIME_MS,
  visibleGitHubProjectCapabilityExpiry,
} from "./project-authority";

const NOW = new Date("2026-09-02T12:00:00.000Z");
const TENANT = "u_9c8589018a57479181fe4c455b099bc9";

function proof(
  overrides: Partial<GitHubProjectAuthorityProof> = {}
): GitHubProjectAuthorityProof {
  return {
    tenant: TENANT,
    userProjectAuthorityAuthVersion: 7,
    userProjectAuthorityConnectionGeneration: 9,
    userProjectAuthorityExpiresAt: new Date(
      NOW.getTime() + MAX_GITHUB_PROJECT_AUTHORITY_PROOF_LIFETIME_MS
    ),
    userProjectAuthorityIssuedAt: NOW,
    userProjectIds: ["PVT_current"],
    userProjectManagementCeiling: true,
    userProjectManagementCurrent: true,
    ...overrides,
  };
}

const binding = {
  authVersion: 7,
  connectionGeneration: 9,
  now: NOW,
  tenant: TENANT,
};

test("Project proof is current before, but not at, its exact expiry", () => {
  const expiresAt = new Date("2026-09-02T12:10:00.000Z");
  const current = proof({ userProjectAuthorityExpiresAt: expiresAt });

  assert.equal(
    isCurrentGitHubProjectAuthority(current, {
      ...binding,
      now: new Date(expiresAt.getTime() - 1),
    }),
    true
  );
  assert.equal(
    isCurrentGitHubProjectAuthority(current, {
      ...binding,
      now: expiresAt,
    }),
    false
  );
});

test("Project proof preserves absolute instants across explicit time-zone offsets", () => {
  assert.equal(
    isCurrentGitHubProjectAuthority(
      proof({
        userProjectAuthorityExpiresAt: "2026-09-02T07:15:00.000-05:00",
        userProjectAuthorityIssuedAt: "2026-09-02T07:00:00.000-05:00",
      }),
      binding
    ),
    true
  );
});

test("Project proof fails closed for stale generations, sessions, tenants, and malformed lifetimes", () => {
  for (const [authority, authorityBinding] of [
    [proof(), { ...binding, authVersion: 8 }],
    [proof(), { ...binding, connectionGeneration: 10 }],
    [proof(), { ...binding, tenant: "u_other" }],
    [
      proof({
        userProjectAuthorityExpiresAt: new Date(
          NOW.getTime() + MAX_GITHUB_PROJECT_AUTHORITY_PROOF_LIFETIME_MS + 1
        ),
      }),
      binding,
    ],
    [
      proof({
        userProjectAuthorityIssuedAt: new Date(NOW.getTime() + 1),
      }),
      binding,
    ],
  ] as const) {
    assert.equal(
      isCurrentGitHubProjectAuthority(authority, authorityBinding),
      false
    );
  }
});

test("UI Project capability exposure uses only current bounded server expiry", () => {
  const current = proof();
  const expiresAt = current.userProjectAuthorityExpiresAt;
  assert.ok(expiresAt instanceof Date);
  assert.deepEqual(
    currentGitHubProjectAuthorityExpiresAt([current], binding),
    expiresAt
  );
  assert.deepEqual(
    visibleGitHubProjectCapabilityExpiry(
      expiresAt.toISOString(),
      new Date(expiresAt.getTime() - 1)
    ),
    expiresAt
  );
  assert.equal(
    visibleGitHubProjectCapabilityExpiry(expiresAt.toISOString(), expiresAt),
    null
  );
  assert.equal(
    currentGitHubProjectAuthorityExpiresAt(
      [proof({ tenant: "u_other" })],
      binding
    ),
    null
  );
});
