/**
 * Who may open the Warden admin surface.
 *
 * An allowlist of exact email addresses from `ADMIN_EMAILS`, in the
 * `BETA_ALLOWLIST` tradition: unset or empty means nobody, because an admin
 * door that opens itself on a missing variable is not a door. Matching is
 * exact on the normalized address — a substring test would admit
 * `admin@example.com.attacker.test`.
 *
 * Callers must answer a non-admin with 404, never 403: the admin surface's
 * existence is itself information.
 */
export function isAdminEmail(
  email: string | null | undefined,
  allowlist: string | undefined = process.env.ADMIN_EMAILS
): boolean {
  if (!email) {
    return false;
  }
  const normalized = email.trim().toLowerCase();
  return (allowlist ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(normalized);
}
