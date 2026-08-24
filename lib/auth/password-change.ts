/**
 * Minimum length for a new password.
 *
 * Matches the registration schema (`z.string().min(6)`) so the two surfaces
 * cannot disagree about what is acceptable — a password accepted at sign-up
 * and refused at change would look like a bug.
 */
export const MIN_PASSWORD_LENGTH = 6;

export type PasswordChangeInput = {
  confirmation: string;
  currentMatches: boolean;
  next: string;
  nextEqualsCurrent?: boolean;
  signedIn: boolean;
};

export type PasswordChangeDecision = {
  kind:
    | "allowed"
    | "mismatch"
    | "too_short"
    | "unauthorized"
    | "unchanged"
    | "wrong_password";
};

/**
 * Decides whether a password change may proceed.
 *
 * Pure, because this is the decision that governs who keeps control of an
 * account, and route-handler logic is unreachable by a unit test.
 *
 * Order matters. `signedIn` is checked first so an unauthenticated caller can
 * never learn whether a guessed current password was correct — otherwise this
 * endpoint becomes a password oracle. `currentMatches` is checked before the
 * new password is validated for the same reason: the shape of the response
 * should not depend on anything the caller could not already do.
 */
export function passwordChangeDecision(
  input: PasswordChangeInput
): PasswordChangeDecision {
  if (!input.signedIn) {
    return { kind: "unauthorized" };
  }

  // A stolen session cookie alone must not be enough to seize the account.
  if (!input.currentMatches) {
    return { kind: "wrong_password" };
  }

  if (input.next !== input.confirmation) {
    return { kind: "mismatch" };
  }

  // `[...next]` counts characters rather than UTF-16 code units, so a
  // passphrase of astral-plane characters is measured the way a person reads
  // it. Trimmed first so a run of spaces cannot pad out the length.
  if ([...input.next.trim()].length < MIN_PASSWORD_LENGTH) {
    return { kind: "too_short" };
  }

  // The temporary-password flow only works if the temporary one stops working.
  if (input.nextEqualsCurrent) {
    return { kind: "unchanged" };
  }

  return { kind: "allowed" };
}
