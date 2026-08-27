import type { RunnerClaims } from "@opencoven/agent-contracts";
import { tenantForUser } from "@/lib/session";
import { isSubscribedAt } from "@/lib/subscription";
import { authVersionMatches } from "./session-revocation";

export type RunnerAuthorityInput = Pick<
  RunnerClaims,
  "authVersion" | "plan" | "sub" | "tenant"
>;

export type RunnerAuthorityUser = {
  authVersion: number | null;
  id: string;
  subscribedUntil: Date | null;
};

export type RunnerAuthorityDecision =
  | { kind: "allowed" }
  | { kind: "subscription_required" }
  | { kind: "unauthorized" };

/**
 * Compares a signed runner claim with the current product authority.
 *
 * The Worker cannot query the application database, so the internal authority
 * endpoint verifies the original signed token and derives this input before
 * looking up the owner. This function deliberately returns only an access
 * decision: neither the Worker nor its caller needs account details to decide
 * whether a request may continue.
 */
export function decideRunnerAuthority(
  input: RunnerAuthorityInput,
  owner: RunnerAuthorityUser | null,
  now: Date
): RunnerAuthorityDecision {
  let derivedTenant: string;
  try {
    derivedTenant = tenantForUser(input.sub);
  } catch {
    return { kind: "unauthorized" };
  }

  if (
    !owner ||
    owner.id !== input.sub ||
    input.tenant !== derivedTenant ||
    !authVersionMatches(owner.authVersion, input.authVersion)
  ) {
    return { kind: "unauthorized" };
  }

  if (input.plan !== "subscriber" || !isSubscribedAt(owner, now)) {
    return { kind: "subscription_required" };
  }

  return { kind: "allowed" };
}
