import { redirect } from "next/navigation";

/**
 * There is nothing to register.
 *
 * A GitHub sign-in creates the account on first use, so a separate sign-up
 * step would be a form with nothing to submit.
 */
export default function Page() {
  redirect("/login");
}
