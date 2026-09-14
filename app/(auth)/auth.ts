import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import NextAuth, { type DefaultSession, type Session } from "next-auth";
import type { DefaultJWT } from "next-auth/jwt";
import GitHub from "next-auth/providers/github";
import { cache } from "react";
import { enrollInCampaignIfEligible } from "@/lib/auth/campaign-enrollment";
import { fetchGithubAccountCreatedAt } from "@/lib/auth/github-account-age";
import { fetchGithubEmail } from "@/lib/auth/github-email-fetch";
import { sessionExpiredLoginRoute } from "@/lib/auth/session-recovery";
import {
  authVersionMatches,
  validAuthVersion,
} from "@/lib/auth/session-revocation";
import { readCampaignPolicy } from "@/lib/billing/campaign";
import {
  enrollCampaignParticipant,
  findOrCreateFederatedUser,
  findUserById,
} from "@/lib/db/queries";
import { ChatbotError } from "@/lib/errors";
import { isCanonicalUuid } from "@/lib/session";
import {
  refreshClaimsForSessionUpdate,
  refreshTokenType,
  validateSessionToken,
} from "@/lib/session-claims";
import { isSubscribedAt, userTypeFor } from "@/lib/subscription";
import {
  type SubscriptionAuthority,
  serializeSubscriptionAuthority,
} from "@/lib/subscription-authority";
import { authConfig } from "./auth.config";

export type UserType = "demo" | "subscriber";

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      authVersion: number;
      id: string;
      subscriptionAuthorityExpiresAt?: string | null;
      type: UserType;
    } & DefaultSession["user"];
  }

  interface User {
    authVersion?: number;
    campaignExpiresAt?: Date | null;
    campaignGrantedAt?: Date | null;
    email?: string | null;
    id?: string;
    subscribedUntil?: Date | null;
    type: UserType;
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    authVersion?: number;
    /**
     * Carried for the same reason as `subscribedUntil`: `type` is recomputed
     * from these on every callback, so a grant left off the token would decay
     * a campaign participant to `demo` on their first request after sign-in.
     */
    campaignExpiresAt?: string | null;
    campaignGrantedAt?: string | null;
    id: string;
    /** Carried so `type` can be recomputed without a database read. */
    subscribedUntil?: string | null;
    type: UserType;
  }
}

export const {
  handlers: { GET, POST },
  auth: nextAuth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,
  callbacks: {
    async jwt({ token, user, account, trigger, session: updated }) {
      /**
       * A session update POST is only a signal to reload the stored user. The
       * browser payload is never an authority source: the avatar route commits
       * its image first, and this refresh then picks up that image together
       * with the current subscription and revocation version.
       */
      if (trigger === "update") {
        return refreshClaimsForSessionUpdate(
          token,
          updated,
          findUserById,
          new Date()
        );
      }

      /**
       * A GitHub sign-in has to be mapped onto a local `User` row before it
       * means anything: the tenant is derived from that row's id, and
       * `subscribedUntil` lives on it. Without this the session would carry a
       * GitHub numeric id that owns no data and matches no subscription.
       *
       * The address comes from GitHub's verified-emails API rather than the
       * profile, because the profile address is self-asserted. Authorization
       * keys on email here, so an unverified one would let a stranger claim
       * an account by typing its address into a fresh GitHub profile.
       */
      if (account?.provider === "github") {
        const email = await fetchGithubEmail(account.access_token);

        if (!email) {
          // No verified address: refuse rather than invent an identity.
          return token;
        }

        const row = await findOrCreateFederatedUser(email);
        /**
         * The open beta campaign is decided here, at sign-in, because this is
         * the only moment we hold a GitHub access token — and the account's
         * age, which is the campaign's defence against farmed accounts, can
         * only be read with one. It never throws: an ineligible or failed
         * enrollment simply leaves the account without campaign minutes,
         * whereas an exception here is a person who cannot sign in.
         */
        const now = new Date();
        const enrollment = await enrollInCampaignIfEligible(
          {
            accessToken: account.access_token,
            now,
            policy: readCampaignPolicy(process.env),
            user: row,
          },
          {
            enroll: enrollCampaignParticipant,
            fetchAccountCreatedAt: fetchGithubAccountCreatedAt,
          }
        );
        const granted =
          enrollment.kind === "enrolled" ||
          enrollment.kind === "already_enrolled"
            ? enrollment.user
            : row;

        token.email = row.email;
        token.id = row.id;
        token.authVersion = row.authVersion;
        // Carried on the token so the account menu can render the stored
        // avatar without a database read on every request. `update()` from
        // the settings form is what keeps it current between sign-ins.
        token.picture = row.image ?? null;
        token.subscribedUntil = row.subscribedUntil?.toISOString() ?? null;
        token.campaignExpiresAt =
          granted.campaignExpiresAt?.toISOString() ?? null;
        token.campaignGrantedAt =
          granted.campaignGrantedAt?.toISOString() ?? null;

        return refreshTokenType(token, now);
      }

      if (user) {
        token.id = user.id as string;
        token.authVersion = user.authVersion ?? 0;
        // The date, not the derived type, is what gets carried. `type` used to
        // be written here once and never recomputed, so a lapsed subscription
        // kept subscriber entitlements — and a subscriber session is what may
        // write to the owner's database — until the token happened to expire.
        token.subscribedUntil = user.subscribedUntil?.toISOString() ?? null;
        token.campaignExpiresAt = user.campaignExpiresAt?.toISOString() ?? null;
        token.campaignGrantedAt = user.campaignGrantedAt?.toISOString() ?? null;
      }

      if (!user && process.env.POSTGRES_URL) {
        return validateSessionToken(token, findUserById, new Date());
      }
      return refreshTokenType(token, new Date());
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        if (validAuthVersion(token.authVersion)) {
          session.user.authVersion = token.authVersion;
        }
        session.user.type = token.type;
        session.user.image = token.picture ?? null;
        session.user.subscriptionAuthorityExpiresAt =
          typeof token.subscribedUntil === "string"
            ? token.subscribedUntil
            : null;
      }

      return session;
    },
  },
  providers: [
    /**
     * The only way in.
     *
     * The password provider is gone: there is no mail delivery here, so a
     * forgotten password was unrecoverable, and maintaining two paths meant
     * two sets of rules about who may sign in. GitHub is also what tenants
     * already have -- they bring a Copilot or Claude credential regardless.
     *
     * This makes AUTH_GITHUB_ID and AUTH_GITHUB_SECRET required rather than
     * optional: without them no one can sign in at all.
     */
    GitHub({
      authorization: {
        // Identity only. No repository scope is requested; agents
        // authenticate with credentials the tenant supplies separately.
        params: { scope: "read:user user:email" },
      },
    }),
  ],
});

/**
 * NextAuth verifies the cookie, but the cookie is not the authority for
 * revocation. Every server-side authorization helper calls this wrapper,
 * which re-reads the user row and rejects stale or malformed versions.
 */
type ResolvedAuth =
  | {
      kind: "authorized";
      session: Session;
      user: NonNullable<Awaited<ReturnType<typeof findUserById>>>;
    }
  | {
      kind: "storage-unavailable";
      session: Session;
    };

const resolveAuth = cache(async (now?: Date): Promise<ResolvedAuth | null> => {
  const session = await nextAuth();

  if (!session) {
    return null;
  }
  const userId = session?.user?.id;
  if (!(userId && isCanonicalUuid(userId))) {
    return null;
  }

  const tokenAuthVersion = session.user.authVersion;
  if (!validAuthVersion(tokenAuthVersion)) {
    return null;
  }

  if (!process.env.POSTGRES_URL) {
    return { kind: "storage-unavailable", session };
  }

  let owner: Awaited<ReturnType<typeof findUserById>>;
  try {
    owner = await findUserById(userId);
  } catch (error) {
    if (error instanceof ChatbotError && error.surface === "database") {
      return { kind: "storage-unavailable", session };
    }
    throw error;
  }
  if (!owner || !authVersionMatches(owner.authVersion, tokenAuthVersion)) {
    return null;
  }

  const resolvedNow = now ?? new Date();
  session.user.authVersion = owner.authVersion;
  session.user.type = userTypeFor(owner, resolvedNow);
  session.user.image = owner.image ?? null;
  return { kind: "authorized", session, user: owner };
});

export async function auth() {
  const resolved = await resolveAuth();
  return resolved?.kind === "authorized" ? resolved.session : null;
}

async function redirectRevokedPage(returnPath: string): Promise<void> {
  const cookieStore = await cookies();
  const hasSessionCookie = cookieStore
    .getAll()
    .some(({ name }) =>
      /^(?:__Secure-)?authjs\.session-token(?:\.\d+)?$/.test(name)
    );
  if (hasSessionCookie) {
    redirect(
      sessionExpiredLoginRoute(
        returnPath,
        process.env.NEXT_PUBLIC_BASE_PATH ?? ""
      )
    );
  }
}

export async function pageAuth(returnPath: string) {
  const resolved = await resolveAuth();
  if (!resolved) {
    await redirectRevokedPage(returnPath);
  }
  return resolved?.session ?? null;
}

export async function subscriptionPageAuthority(
  now: Date,
  returnPath?: string
): Promise<SubscriptionAuthority> {
  const resolved = await resolveAuth(now);
  const resolutionId = randomUUID();
  if (!resolved) {
    if (returnPath) {
      await redirectRevokedPage(returnPath);
    }
    return serializeSubscriptionAuthority({
      authVersion: null,
      checkedAt: now,
      isSubscriber: false,
      resolutionId,
      subscribedUntil: null,
      userId: null,
    });
  }
  if (resolved.kind === "storage-unavailable") {
    return serializeSubscriptionAuthority({
      authVersion: resolved.session.user.authVersion,
      checkedAt: now,
      isSubscriber: resolved.session.user.type === "subscriber",
      resolutionId,
      subscribedUntil:
        resolved.session.user.subscriptionAuthorityExpiresAt ?? null,
      userId: resolved.session.user.id,
    });
  }
  return serializeSubscriptionAuthority({
    authVersion: resolved.session.user.authVersion,
    checkedAt: now,
    isSubscriber: isSubscribedAt(resolved.user, now),
    resolutionId,
    subscribedUntil: resolved.user.subscribedUntil,
    userId: resolved.session.user.id,
  });
}
