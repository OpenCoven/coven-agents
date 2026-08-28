import {
  base64UrlDecode,
  type RunnerRunScope,
  splitToken,
} from "@opencoven/agent-contracts";

/**
 * Replace a token this long before it expires.
 *
 * Refreshing only once expired would guarantee at least one 401 per token
 * lifetime, and it would arrive mid-request rather than between them.
 */
export const IDENTITY_REFRESH_MARGIN_MS = 60_000;

const MINT_ENDPOINT = "/api/runner-token";

type FetchLike = (
  input: string,
  init?: { body?: string; headers?: Record<string, string>; method?: string }
) => Promise<Response>;

/** Reads `exp` without verifying — the worker verifies; this only schedules. */
function expiryOf(token: string): number | null {
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }
  try {
    const claims = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(parts.payload))
    ) as { exp?: unknown };
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Supplies a current identity token, minting a new one only when the cached
 * one is missing or close to expiry.
 *
 * The console cannot hold a long-lived credential: identity tokens live 15
 * minutes by design, because expiry is the only revocation mechanism. That
 * makes minting a per-session concern rather than something a user pastes,
 * which is the point — there is nothing here for a user to copy to someone
 * else.
 *
 * Every failure throws. Returning an empty string would be sent as `Bearer `
 * and read by the worker as a malformed token, turning "you are signed out"
 * into a confusing 401 about identity.
 */
export function createIdentityMinter(
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): (run?: RunnerRunScope) => Promise<string> {
  let cached: { expiresAt: number; token: string } | null = null;

  return async (run) => {
    if (
      !run &&
      cached &&
      cached.expiresAt - Date.now() > IDENTITY_REFRESH_MARGIN_MS
    ) {
      return cached.token;
    }

    const response = await fetchImpl(MINT_ENDPOINT, {
      ...(run
        ? {
            body: JSON.stringify({ run }),
            headers: { "content-type": "application/json" },
          }
        : {}),
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(
        `Could not obtain a runner identity (${response.status}). Sign in and try again.`
      );
    }

    const body = (await response.json()) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) {
      throw new Error("The identity endpoint returned no token.");
    }

    const expiresAt = expiryOf(body.token);
    if (expiresAt === null) {
      // Deliberately not cached: pinning a token whose expiry cannot be read
      // would keep serving it until the page reloads.
      throw new Error("The identity endpoint returned an unreadable token.");
    }

    if (!run) {
      cached = { expiresAt, token: body.token };
    }
    return body.token;
  };
}
