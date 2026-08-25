import { compare } from "bcrypt-ts";
import NextAuth, { type DefaultSession } from "next-auth";
import type { DefaultJWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { fetchGithubEmail } from "@/lib/auth/github-email-fetch";
import { DUMMY_PASSWORD } from "@/lib/constants";
import { findOrCreateFederatedUser, getUser } from "@/lib/db/queries";
import { refreshTokenType } from "@/lib/session-claims";
import { userTypeFor } from "@/lib/subscription";
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
    async jwt({ token, user, account }) {
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
      }

      return session;
    },
  },
  providers: [
    /**
     * Present only when configured, so a deployment without GitHub
     * credentials keeps working on the password form instead of failing to
     * construct the auth config at boot.
     */
    ...(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET
      ? [
          GitHub({
            authorization: {
              // Identity only. No repository scope is requested: agents
              // authenticate with credentials the tenant supplies separately.
              params: { scope: "read:user user:email" },
            },
          }),
        ]
      : []),
    Credentials({
      async authorize(credentials) {
        const email = String(credentials.email ?? "");
        const password = String(credentials.password ?? "");
        const users = await getUser(email);

        if (users.length === 0) {
          await compare(password, DUMMY_PASSWORD);
          return null;
        }

        const [user] = users;

        if (!user.password) {
          await compare(password, DUMMY_PASSWORD);
          return null;
        }

        const passwordsMatch = await compare(password, user.password);

        if (!passwordsMatch) {
          return null;
        }

        // The type is derived from the stored row, not hardcoded. This is the
        // decision that says who may reach the owner's database, so it lives
        // in a tested pure function rather than inline here.
        return { ...user, type: userTypeFor(user, new Date()) };
      },
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
    }),
  ],
});
