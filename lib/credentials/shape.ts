/**
 * How a stored credential is represented inside the encrypted blob.
 *
 * A pasted PAT is an opaque string and always was. A device-flow credential
 * needs three fields, because the access token expires in eight hours and the
 * refresh token is what keeps a subscriber working the next morning.
 *
 * Both live in the same ciphertext column: the envelope encrypts a string, so
 * an OAuth credential is that string containing JSON. That avoids a migration
 * and, more usefully, means a credential stored before this existed still
 * reads correctly — it simply is not JSON, so it is a PAT.
 */
export type StoredCredential =
  | { access: string; expiresAt: number; kind: "oauth"; refresh: string }
  | { kind: "pat"; token: string };

const OAUTH_MARKER = "oc.oauth.v1";

export function serializeCredential(credential: StoredCredential): string {
  if (credential.kind === "pat") {
    return credential.token;
  }

  return JSON.stringify({
    a: credential.access,
    e: credential.expiresAt,
    r: credential.refresh,
    v: OAUTH_MARKER,
  });
}

/**
 * Reads a stored credential back.
 *
 * Anything that is not our own JSON envelope is a PAT. That is deliberate
 * rather than lenient: a token is an opaque string chosen by GitHub, and
 * guessing at its structure is how a valid credential gets rejected.
 */
export function parseStoredCredential(raw: string): StoredCredential | null {
  const trimmed = raw.trim();

  if (!trimmed) {
    return null;
  }

  if (!trimmed.startsWith("{")) {
    return { kind: "pat", token: trimmed };
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;

    if (parsed.v !== OAUTH_MARKER) {
      return { kind: "pat", token: trimmed };
    }

    const access = typeof parsed.a === "string" ? parsed.a : "";
    const refresh = typeof parsed.r === "string" ? parsed.r : "";
    const expiresAt = typeof parsed.e === "number" ? parsed.e : 0;

    if (!(access && refresh)) {
      // Our marker but missing halves: refusing beats returning a credential
      // that cannot be refreshed and will fail silently in eight hours.
      return null;
    }

    return { access, expiresAt, kind: "oauth", refresh };
  } catch {
    return { kind: "pat", token: trimmed };
  }
}

/**
 * Replace a token this long before it expires.
 *
 * A run can take minutes, and the credential is read once at the start. A
 * token valid for another thirty seconds would expire mid-run, so the margin
 * is generous relative to the eight-hour lifetime it protects.
 */
export const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export function needsRefresh(
  credential: StoredCredential,
  now: number,
  marginMs: number = REFRESH_MARGIN_MS
): boolean {
  if (credential.kind === "pat") {
    // A PAT has no expiry we can see and no way to refresh it.
    return false;
  }

  return credential.expiresAt - now <= marginMs;
}
