/**
 * What the account menu should offer for a given session.
 *
 * Pure, because sign-in and sign-out were previously decided in two
 * components that disagreed: the chat sidebar said "Sign out" and returned to
 * `/`, the agents header said "Sign out" and returned to `/login`, and
 * `/account` offered neither. `/` then bounced through the console to the
 * gate, so signing out took three redirects to land where the other menu went
 * directly.
 *
 * One function, one answer, three surfaces.
 */
export type SessionMenu = {
  /** Where the primary action sends the visitor. */
  destination: string;
  /** The action's label. */
  label: string;
  /** Whether to show account settings and the signed-in address. */
  signedIn: boolean;
};

export function sessionMenu(input: {
  email: string | null | undefined;
}): SessionMenu {
  if (!input.email) {
    return { destination: "/login", label: "Sign in", signedIn: false };
  }

  // Straight to /login rather than "/", which redirects to the console, which
  // the beta gate then redirects to /login anyway. Three hops to reach the
  // page the other menu reached in one.
  return { destination: "/login", label: "Sign out", signedIn: true };
}
