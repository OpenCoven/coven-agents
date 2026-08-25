/** `User.email` is `varchar(64)`; a longer address cannot be stored. */
const MAX_EMAIL_LENGTH = 64;

export type GithubEmail = {
  email: string;
  primary: boolean;
  verified: boolean;
};

function usable(entry: GithubEmail | null | undefined): string | null {
  const email = entry?.email?.trim().toLowerCase();

  if (!email || email.length > MAX_EMAIL_LENGTH) {
    return null;
  }

  return email;
}

/**
 * Chooses the address to identify a GitHub sign-in by.
 *
 * **Only verified addresses are eligible, and that is load-bearing.**
 * Authorization here keys on email: the beta allowlist matches on it, and an
 * existing account is claimed by it. GitHub lets anyone type any address into
 * their profile — only the verified flag proves they control it. Accepting an
 * unverified address would let a stranger claim someone else's account by
 * typing their address into a fresh GitHub profile.
 *
 * Returns null when there is no verified address, so the caller refuses the
 * sign-in rather than inventing an identity.
 */
export function selectPrimaryEmail(
  entries: readonly GithubEmail[]
): string | null {
  const verified = entries.filter((entry) => entry?.verified && usable(entry));

  const primary = verified.find((entry) => entry.primary);

  return usable(primary ?? verified[0]);
}
