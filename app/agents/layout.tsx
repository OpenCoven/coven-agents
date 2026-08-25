import { SessionProvider } from "next-auth/react";

/**
 * Session context for the console.
 *
 * `SessionProvider` was moved off the root layout so the demo route can render
 * with no session at all, and it was added back to the `(auth)` and `(chat)`
 * groups — but `/agents` is neither, so it was left without one. Nothing
 * noticed until the console needed to know who was signed in.
 *
 * Mounted per route group rather than at the root for the same reason it was
 * removed: the demo must stay session-free.
 */
export default function AgentsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider
      basePath={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/auth`}
    >
      {children}
    </SessionProvider>
  );
}
