const USER_URL = "https://api.github.com/user";

/**
 * Reads the signed-in GitHub account's creation date.
 *
 * The open beta campaign hands run minutes to anyone who signs in, which makes
 * minting fresh GitHub accounts the cheapest way to farm free compute. Account
 * age is the one signal GitHub gives us that a farmer cannot backdate, so it
 * is the floor the campaign stands on.
 *
 * `/user/emails` proves control of an address but says nothing about age, so
 * this is a second call rather than an extension of `fetchGithubEmail`. It
 * runs once per sign-in, only while the campaign is enrolling.
 *
 * The access token is used once, here, and never stored. Returns null on any
 * failure, and `githubAccountOldEnough` refuses a null: an account whose age
 * we could not establish is not admitted to the campaign. Failing closed here
 * costs an eligible person their free minutes; failing open costs an unbounded
 * compute bill.
 */
export async function fetchGithubAccountCreatedAt(
  accessToken: string | undefined
): Promise<Date | null> {
  if (!accessToken) {
    return null;
  }

  try {
    const response = await fetch(USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${accessToken}`,
        "user-agent": "opencoven-agents",
      },
    });

    if (!response.ok) {
      return null;
    }

    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) {
      return null;
    }
    const raw = (body as { created_at?: unknown }).created_at;
    if (typeof raw !== "string") {
      return null;
    }

    const createdAt = new Date(raw);
    return Number.isNaN(createdAt.getTime()) ? null : createdAt;
  } catch {
    return null;
  }
}
