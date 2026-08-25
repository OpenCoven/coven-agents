import { type GithubEmail, selectPrimaryEmail } from "./github-email";

const EMAILS_URL = "https://api.github.com/user/emails";

/**
 * Reads the signed-in GitHub user's verified email addresses.
 *
 * The OAuth profile carries an address too, but it is self-asserted and may be
 * absent when the user keeps it private. This asks the API instead, which
 * reports the `verified` flag — the only thing that proves the person controls
 * the address they are about to be identified by.
 *
 * The access token is used once, here, and never stored. Returns null on any
 * failure so the caller refuses the sign-in rather than proceeding without an
 * identity.
 */
export async function fetchGithubEmail(
  accessToken: string | undefined
): Promise<string | null> {
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(EMAILS_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "opencoven-agents",
      },
    });

    if (!response.ok) {
      return null;
    }

    const body = await response.json();

    return Array.isArray(body)
      ? selectPrimaryEmail(body as GithubEmail[])
      : null;
  } catch {
    return null;
  }
}
