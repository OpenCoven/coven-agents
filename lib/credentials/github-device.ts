import type { StoredCredential } from "./shape";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Scopes the Copilot CLI itself requests.
 *
 * Copied deliberately rather than minimised. Copilot entitlement is not
 * granted by a scope -- there is no Copilot scope -- so asking for less than
 * the CLI asks for risks a token the harness rejects for reasons that would
 * be very hard to diagnose from the outside.
 */
const SCOPES = "read:user,read:org,repo,gist";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type DeviceStart = {
  deviceCode: string;
  expiresIn: number;
  interval: number;
  userCode: string;
  verificationUri: string;
};

export type DeviceExchange =
  | { credential: StoredCredential; kind: "authorized" }
  | { kind: "denied" }
  | { kind: "expired" }
  | { kind: "pending" }
  | { kind: "slow_down" };

/** Begins a device authorization. */
export async function startDeviceFlow(
  clientId: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init)
): Promise<DeviceStart | null> {
  const response = await fetchImpl(DEVICE_CODE_URL, {
    body: new URLSearchParams({ client_id: clientId, scope: SCOPES }),
    headers: { accept: "application/json" },
    method: "POST",
  });

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as Record<string, unknown>;

  if (typeof body.device_code !== "string") {
    return null;
  }

  return {
    deviceCode: body.device_code,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
    interval: typeof body.interval === "number" ? body.interval : 5,
    userCode: String(body.user_code ?? ""),
    verificationUri: String(
      body.verification_uri ?? "https://github.com/login/device"
    ),
  };
}

/**
 * Turns a GitHub token response into a stored credential.
 *
 * Pure so the state machine can be tested without a network: the difference
 * between "keep polling" and "give up" is the whole contract, and getting it
 * wrong means either a hung UI or an abandoned authorization.
 */
export function interpretTokenResponse(
  body: Record<string, unknown>,
  now: number
): DeviceExchange {
  const error = typeof body.error === "string" ? body.error : null;

  if (error === "authorization_pending") {
    return { kind: "pending" };
  }
  if (error === "slow_down") {
    return { kind: "slow_down" };
  }
  if (error === "access_denied") {
    return { kind: "denied" };
  }
  if (error) {
    // expired_token, incorrect_device_code, unsupported_grant_type -- all
    // terminal, and all mean start again rather than keep polling.
    return { kind: "expired" };
  }

  const access = typeof body.access_token === "string" ? body.access_token : "";
  const refresh =
    typeof body.refresh_token === "string" ? body.refresh_token : "";

  if (!access) {
    return { kind: "expired" };
  }

  if (!refresh) {
    // No refresh token means the app has token expiry switched off, so the
    // access token does not expire. Store it as a PAT: there is nothing to
    // refresh and pretending otherwise would schedule a refresh that fails.
    return { credential: { kind: "pat", token: access }, kind: "authorized" };
  }

  const expiresIn =
    typeof body.expires_in === "number" ? body.expires_in : 28_800;

  return {
    credential: {
      access,
      expiresAt: now + expiresIn * 1000,
      kind: "oauth",
      refresh,
    },
    kind: "authorized",
  };
}

/** Exchanges a device code once. The caller owns the polling loop. */
export async function exchangeDeviceCode(
  input: { clientId: string; deviceCode: string },
  now: number,
  fetchImpl: FetchLike = (i, init) => fetch(i, init)
): Promise<DeviceExchange> {
  const response = await fetchImpl(ACCESS_TOKEN_URL, {
    body: new URLSearchParams({
      client_id: input.clientId,
      device_code: input.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
    headers: { accept: "application/json" },
    method: "POST",
  });

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  return interpretTokenResponse(body, now);
}

/**
 * Exchanges a refresh token for a fresh access token.
 *
 * Returns null when the refresh itself is refused -- a revoked authorization
 * or an expired refresh token. The caller must treat that as "reconnect
 * needed" rather than retrying, because no amount of retrying will fix it.
 */
export async function refreshCredential(
  input: { clientId: string; clientSecret: string; refresh: string },
  now: number,
  fetchImpl: FetchLike = (i, init) => fetch(i, init)
): Promise<StoredCredential | null> {
  const response = await fetchImpl(ACCESS_TOKEN_URL, {
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refresh,
    }),
    headers: { accept: "application/json" },
    method: "POST",
  });

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  const result = interpretTokenResponse(body, now);

  return result.kind === "authorized" ? result.credential : null;
}
