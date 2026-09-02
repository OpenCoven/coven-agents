const PROJECT_NODE_ID = /^[A-Za-z0-9_=-]{1,256}$/u;

export const MAX_GITHUB_PROJECT_AUTHORITY_PROOF_LIFETIME_MS = 15 * 60_000;

export type GitHubProjectAuthorityProof = Readonly<{
  tenant: string;
  userProjectAuthorityAuthVersion: number | null;
  userProjectAuthorityConnectionGeneration: number | null;
  userProjectAuthorityExpiresAt: Date | string | null;
  userProjectAuthorityIssuedAt: Date | string | null;
  userProjectIds: readonly string[];
  userProjectManagementCeiling: boolean;
  userProjectManagementCurrent: boolean;
}>;

export type GitHubProjectAuthorityBinding = Readonly<{
  authVersion: number;
  connectionGeneration: number;
  now: Date;
  tenant: string;
}>;

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function proofDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function isWellFormedGitHubProjectAuthority(
  proof: GitHubProjectAuthorityProof
): boolean {
  const issuedAt = proofDate(proof.userProjectAuthorityIssuedAt);
  const expiresAt = proofDate(proof.userProjectAuthorityExpiresAt);
  if (!proof.userProjectManagementCurrent) {
    return (
      proof.userProjectIds.length === 0 &&
      proof.userProjectAuthorityAuthVersion === null &&
      proof.userProjectAuthorityConnectionGeneration === null &&
      proof.userProjectAuthorityExpiresAt === null &&
      proof.userProjectAuthorityIssuedAt === null
    );
  }
  if (
    !proof.userProjectManagementCeiling ||
    proof.userProjectIds.length < 1 ||
    proof.userProjectIds.length > 100 ||
    new Set(proof.userProjectIds).size !== proof.userProjectIds.length ||
    proof.userProjectIds.some(
      (projectId) => !PROJECT_NODE_ID.test(projectId)
    ) ||
    proof.userProjectAuthorityAuthVersion === null ||
    !validGeneration(proof.userProjectAuthorityAuthVersion) ||
    proof.userProjectAuthorityConnectionGeneration === null ||
    !validGeneration(proof.userProjectAuthorityConnectionGeneration) ||
    issuedAt === null ||
    expiresAt === null
  ) {
    return false;
  }
  const lifetimeMs = expiresAt.getTime() - issuedAt.getTime();
  return (
    lifetimeMs > 0 &&
    lifetimeMs <= MAX_GITHUB_PROJECT_AUTHORITY_PROOF_LIFETIME_MS
  );
}

export function isCurrentGitHubProjectAuthority(
  proof: GitHubProjectAuthorityProof,
  binding: GitHubProjectAuthorityBinding
): boolean {
  const issuedAt = proofDate(proof.userProjectAuthorityIssuedAt);
  const expiresAt = proofDate(proof.userProjectAuthorityExpiresAt);
  return (
    isWellFormedGitHubProjectAuthority(proof) &&
    proof.userProjectManagementCurrent &&
    proof.tenant === binding.tenant &&
    validGeneration(binding.authVersion) &&
    validGeneration(binding.connectionGeneration) &&
    proof.userProjectAuthorityAuthVersion === binding.authVersion &&
    proof.userProjectAuthorityConnectionGeneration ===
      binding.connectionGeneration &&
    !Number.isNaN(binding.now.getTime()) &&
    issuedAt !== null &&
    expiresAt !== null &&
    issuedAt <= binding.now &&
    expiresAt > binding.now
  );
}

export function currentGitHubProjectAuthorityExpiresAt(
  proofs: readonly GitHubProjectAuthorityProof[],
  binding: GitHubProjectAuthorityBinding
): Date | null {
  let latest: Date | null = null;
  for (const proof of proofs) {
    const expiresAt = proofDate(proof.userProjectAuthorityExpiresAt);
    if (
      isCurrentGitHubProjectAuthority(proof, binding) &&
      expiresAt !== null &&
      (latest === null || expiresAt > latest)
    ) {
      latest = expiresAt;
    }
  }
  return latest;
}

export function visibleGitHubProjectCapabilityExpiry(
  value: unknown,
  now: Date
): Date | null {
  if (typeof value !== "string" || Number.isNaN(now.getTime())) {
    return null;
  }
  const expiresAt = new Date(value);
  return Number.isNaN(expiresAt.getTime()) || expiresAt <= now
    ? null
    : expiresAt;
}
