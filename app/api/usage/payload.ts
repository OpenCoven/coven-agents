import { MONTHLY_MINUTE_CAP } from "@/lib/billing/limits";

/**
 * `cap` is the bucket this account draws on; `allowance` adds the pack minutes
 * it still holds. Meters draw against `allowance`, so a paid top-up is visible
 * the moment it is credited.
 *
 * `cap` is a parameter rather than the subscriber constant because an open
 * beta account draws on its campaign grant instead — a smaller number, on a
 * different clock. Rendering everyone against 300 would tell a participant
 * they have 280 minutes left when they have 18, which is the precise kind of
 * confident wrong number this interface exists not to show.
 *
 * `source` lets the UI name what it is counting. "Resets" is true of a monthly
 * bucket and false of a campaign grant, which expires and does not come back.
 */
export function usageResponsePayload(input: {
  cap?: number;
  globalAdmissionClosed: boolean;
  resetsAt: Date | null;
  source?: "campaign" | "subscription";
  tenantDailyRemaining: number;
  tenantMonthlyRemaining: number;
  tenantPackMinutes?: number;
}) {
  const packMinutes = Math.max(0, input.tenantPackMinutes ?? 0);
  const cap = Math.max(0, input.cap ?? MONTHLY_MINUTE_CAP);
  const allowance = cap + packMinutes;
  return {
    allowance,
    cap,
    dailyRemaining: input.tenantDailyRemaining,
    globalAdmissionClosed: input.globalAdmissionClosed,
    monthlyRemaining: input.tenantMonthlyRemaining,
    packMinutes,
    resetsAt: input.resetsAt?.toISOString() ?? null,
    source: input.source ?? "subscription",
    unit: "minutes",
    used: Math.max(0, allowance - input.tenantMonthlyRemaining),
  };
}
