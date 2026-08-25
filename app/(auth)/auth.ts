import NextAuth, { type DefaultSession } from "next-auth";
import type { DefaultJWT } from "next-auth/jwt";
import GitHub from "next-auth/providers/github";
import { fetchGithubEmail } from "@/lib/auth/github-email-fetch";
import { findOrCreateFederatedUser } from "@/lib/db/queries";
import { refreshTokenType } from "@/lib/session-claims";
import { authConfig } from "./auth.config";

export type UserType = "demo" | "subscriber";

declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
      type: UserType;
    } & DefaultSession["user"];
  }

  interface User {
    email?: string | null;
    id?: string;
    subscribedUntil?: Date | null;
    type: UserType;
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    id: string;
    /** Carried so `type` can be recomputed without a database read. */
    subscribedUntil?: string | null;
    type: UserType;
  }
}

export const {
  handlers: { GET, POST },
  auth,
  signIn,
  signOut,
} = NextAuth({
  ...authConfig,
  callbacks: {
    async jwt({ token, user, account, trigger, session: updated }) {
      /**
       * A changed avatar reaches the token here rather than by re-reading the
       * user row on every request. Only the picture is accepted from the
       * client: `id`, `type`, and `subscribedUntil` decide who may write to
       * the owner's database, and taking any of those from a caller-supplied
       * payload would let the browser grant itself a subscription.
       */
      if (trigger === "update") {
        const image = (updated as { image?: unknown } | undefined)?.image;

        token.picture = typeof image === "string" && image ? image : null;

        return refreshTokenType(token, new Date());
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
        token.email = row.email;
        token.id = row.id;
        // Carried on the token so the account menu can render the stored
        // avatar without a database read on every request. `update()` from
        // the settings form is what keeps it current between sign-ins.
        token.picture = row.image ?? null;
        token.subscribedUntil = row.subscribedUntil?.toISOString() ?? null;

        return refreshTokenType(token, new Date());
      }

      if (user) {
        token.id = user.id as string;
        // The date, not the derived type, is what gets carried. `type` used to
        // be written here once and never recomputed, so a lapsed subscription
        // kept subscriber entitlements — and a subscriber session is what may
        // write to the owner's database — until the token happened to expire.
        token.subscribedUntil = user.subscribedUntil?.toISOString() ?? null;
      }

      // Recomputed on every callback, so expiry is exact and costs no read.
      return refreshTokenType(token, new Date());
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.id;
        session.user.type = token.type;
        session.user.image = token.picture ?? null;
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
