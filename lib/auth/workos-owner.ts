import "server-only";

import { userTypeFor } from "@/lib/subscription";
import type { SessionLike } from "./subscriber-access";
import {
  bearerAccessToken,
  type WorkOSAccessTokenVerifier,
  type WorkOSTokenConfiguration,
  type WorkOSUserResult,
} from "./workos-access-token";

export type WorkOSOwnerAccount = Readonly<{
  authVersion: number;
  campaignExpiresAt?: Date | null;
  campaignGrantedAt?: Date | null;
  emailVerified: boolean;
  id: string;
  subscribedUntil?: Date | null;
}>;

export type WorkOSOwnerAuthentication =
  | Readonly<{ kind: "authenticated"; session: SessionLike }>
  | Readonly<{ kind: "unauthorized" | "unavailable" }>;

export type WorkOSOwnerDependencies = Readonly<{
  configuration: () => WorkOSTokenConfiguration | null;
  fetchUser: (
    userId: string,
    configuration: WorkOSTokenConfiguration
  ) => Promise<WorkOSUserResult>;
  findAccountsByEmail: (
    email: string
  ) => Promise<readonly WorkOSOwnerAccount[]>;
  now?: () => Date;
  verifier: (
    configuration: WorkOSTokenConfiguration
  ) => WorkOSAccessTokenVerifier;
}>;

/**
 * Resolves a WorkOS access token to one existing local account.
 *
 * WorkOS proves who is calling; it does not decide what they may do. The
 * result is a session-shaped value carrying the account's current stored
 * version and entitlement-derived type, which the caller must still pass
 * through the ordinary subscriber authorization. No account is created or
 * linked here. A verified email that matches zero or several accounts is
 * refused, and so is the one match when its own email is not verified
 * locally. A request without a bearer token is never authenticated from its
 * cookies.
 */
export async function authenticateWorkOSOwner(
  request: Request,
  dependencies: WorkOSOwnerDependencies
): Promise<WorkOSOwnerAuthentication> {
  let configuration: WorkOSTokenConfiguration | null;
  try {
    configuration = dependencies.configuration();
  } catch {
    return { kind: "unavailable" };
  }
  if (!configuration) {
    return { kind: "unavailable" };
  }
  const token = bearerAccessToken(request);
  if (!token) {
    return { kind: "unauthorized" };
  }

  const verified = await dependencies.verifier(configuration)(token);
  if (verified.kind !== "verified") {
    return {
      kind: verified.kind === "unavailable" ? "unavailable" : "unauthorized",
    };
  }
  const user = await dependencies.fetchUser(verified.userId, configuration);
  if (user.kind !== "verified") {
    return {
      kind: user.kind === "unavailable" ? "unavailable" : "unauthorized",
    };
  }

  let accounts: readonly WorkOSOwnerAccount[];
  try {
    accounts = await dependencies.findAccountsByEmail(user.email);
  } catch {
    return { kind: "unavailable" };
  }
  const [account] = accounts;
  if (accounts.length !== 1 || !account || account.emailVerified !== true) {
    return { kind: "unauthorized" };
  }
  return {
    kind: "authenticated",
    session: {
      user: {
        authVersion: account.authVersion,
        id: account.id,
        type: userTypeFor(account, (dependencies.now ?? (() => new Date()))()),
      },
    },
  };
}
