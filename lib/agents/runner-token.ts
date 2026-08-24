import {
  base64UrlDecode,
  base64UrlEncode,
  type RunnerClaims,
  runnerClaimsSchema,
  TOKEN_ALGORITHM,
  TOKEN_LIFETIME_SECONDS,
} from "@opencoven/agent-contracts";
import { isSubscriber, tenantForUser, toSession } from "@/lib/session";

/**
 * The ONLY place a runner identity token can be minted. This function lives
 * alongside the private signing key (`RUNNER_SIGNING_KEY`, held by the Next
 * app). The Cloudflare Worker that consumes these tokens has no equivalent —
 * it holds a verify (public) key only, so it can check a claim a caller
 * presents but it can never manufacture one itself. Keeping minting on one
 * side of that asymmetry is what makes the token trustworthy: if the worker
 * could mint tokens too, a compromised worker could hand any caller any
 * tenant.
 */
export async function mintRunnerToken(
  input: Omit<RunnerClaims, "exp">,
  privateKeyPkcs8: string
): Promise<string> {
  const claims = runnerClaimsSchema.parse({
    ...input,
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
  });

  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64UrlDecode(privateKeyPkcs8),
    { name: TOKEN_ALGORITHM },
    false,
    ["sign"]
  );

  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );

  const signature = await crypto.subtle.sign(
    { name: TOKEN_ALGORITHM },
    key,
    new TextEncoder().encode(payload)
  );

  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Derives the claims a signed-in user is entitled to.
 *
 * Extracted from the route handler because it is the security-relevant
 * decision in the whole mint path, and inline route logic is not reachable by
 * a unit test — hardcoding `plan: "subscriber"` here passed every test while
 * it lived in the route.
 *
 * `plan` goes through `isSubscriber` rather than comparing `type` directly:
 * `UserType` is currently `"guest" | "regular"`, so a comparison against
 * `"subscriber"` would not typecheck, and `toSession` is fail-closed, so until
 * billing exists nobody resolves to subscriber.
 *
 * `tenant` comes from the stable user id, NOT from `toSession`. A demo session
 * mints a fresh `demo:<uuid>` on every call — correct for an anonymous cookie
 * visitor, wrong here, because this path always has a signed-in user and a
 * tenant that changed per mint would make their own agents disappear.
 */
export function claimsForUser(user: {
  id: string;
  type: string;
}): Omit<RunnerClaims, "exp"> {
  return {
    plan: isSubscriber(toSession(user)) ? "subscriber" : "demo",
    sub: user.id,
    tenant: tenantForUser(user.id),
  };
}
