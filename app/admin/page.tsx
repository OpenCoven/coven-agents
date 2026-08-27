import { notFound } from "next/navigation";
import { auth } from "@/app/(auth)/auth";
import { Warden } from "@/components/admin/warden";
import { isAdminEmail } from "@/lib/admin/access";

/**
 * The Warden admin surface. 404 for everyone who is not on `ADMIN_EMAILS` —
 * never 403, because the door's existence is itself information.
 *
 * `instant = false` because the gate reads the session cookie: the page is
 * dynamic by nature, and caching a cookie-dependent 404-or-console decision
 * would be exactly wrong here.
 */
export const instant = false;

export default async function AdminPage() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    notFound();
  }
  return <Warden operator={session?.user?.email ?? ""} />;
}
