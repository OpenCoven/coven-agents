import {
  type CampaignPolicy,
  campaignExpiryFrom,
  githubAccountOldEnough,
} from "@/lib/billing/campaign";
import type { CampaignEnrollment } from "@/lib/db/queries";
import { isSubscribedAt } from "@/lib/subscription";

export type EnrollableUser = {
  campaignExpiresAt: Date | null;
  campaignGrantedAt: Date | null;
  id: string;
  subscribedUntil: Date | null;
};

export type CampaignEnrollmentOutcome =
  | { kind: "account_too_young" }
  | { kind: "already_enrolled"; user: EnrollableUser }
  | { kind: "campaign_full" }
  | { kind: "disabled" }
  | { kind: "enrolled"; user: EnrollableUser }
  | { kind: "subscriber" }
  | { kind: "unavailable" };

export type CampaignEnrollmentDependencies = {
  enroll: (input: {
    expiresAt: Date;
    grantedAt: Date;
    maxAccounts: number;
    userId: string;
  }) => Promise<CampaignEnrollment>;
  fetchAccountCreatedAt: (
    accessToken: string | undefined
  ) => Promise<Date | null>;
};

/**
 * Decides whether this sign-in earns campaign minutes, and grants them.
 *
 * Extracted from the Auth.js `jwt` callback rather than written inside it,
 * because logic inside a framework callback is unreachable by a unit test —
 * the same mistake as the hardcoded subscriber plan that passed every test
 * until it was pulled out.
 *
 * The checks are ordered by cost, cheapest first, so the network call only
 * happens for a sign-in that could actually enroll:
 *
 * 1. campaign off — no work at all
 * 2. already enrolled, or paying — answered by the row already in hand
 * 3. account age — one GitHub API call
 * 4. the global cap — one short database transaction
 *
 * An active subscriber is skipped rather than enrolled. Granting them minutes
 * they cannot use ahead of the 300 they already bought would consume a slot in
 * a capped campaign to no one's benefit.
 *
 * Every failure returns an outcome rather than throwing. This runs on the
 * sign-in path, where an exception is a person who cannot log in; missing out
 * on free minutes is the strictly better failure.
 */
export async function enrollInCampaignIfEligible(
  input: {
    accessToken: string | undefined;
    now: Date;
    policy: CampaignPolicy;
    user: EnrollableUser;
  },
  dependencies: CampaignEnrollmentDependencies
): Promise<CampaignEnrollmentOutcome> {
  if (!input.policy.enabled) {
    return { kind: "disabled" };
  }
  if (input.policy.pilotEndsAtMs !== undefined) {
    const endsAt = input.policy.pilotEndsAtMs;
    const startsAt = endsAt - input.policy.grantDays * 86_400_000;
    if (input.now.getTime() < startsAt || input.now.getTime() >= endsAt) {
      return { kind: "disabled" };
    }
  }
  if (input.user.campaignGrantedAt) {
    return { kind: "already_enrolled", user: input.user };
  }
  if (isSubscribedAt(input.user, input.now)) {
    return { kind: "subscriber" };
  }

  let createdAt: Date | null;
  try {
    createdAt = await dependencies.fetchAccountCreatedAt(input.accessToken);
  } catch {
    return { kind: "unavailable" };
  }
  if (!githubAccountOldEnough(input.policy, createdAt, input.now)) {
    return { kind: "account_too_young" };
  }

  let enrollment: CampaignEnrollment;
  try {
    enrollment = await dependencies.enroll({
      expiresAt: campaignExpiryFrom(input.policy, input.now),
      grantedAt: input.now,
      maxAccounts: input.policy.maxAccounts,
      userId: input.user.id,
    });
  } catch {
    return { kind: "unavailable" };
  }

  if (enrollment.kind === "campaign_full") {
    return { kind: "campaign_full" };
  }
  return { kind: enrollment.kind, user: enrollment.user };
}
