import { compare } from "bcrypt-ts";
import NextAuth, { type DefaultSession } from "next-auth";
import type { DefaultJWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { DUMMY_PASSWORD } from "@/lib/constants";
import { getUser } from "@/lib/db/queries";
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
    jwt({ token, user }) {
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
