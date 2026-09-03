import { MONTHLY_MINUTE_CAP } from "@/lib/billing/limits";

/**
 * `cap` is the bucket every subscriber gets; `allowance` adds the pack
 * minutes this account still holds. Meters draw against `allowance`, so a
 * paid top-up is visible the moment it is credited.
 */
export function usageResponsePayload(input: {
  globalAdmissionClosed: boolean;
  resetsAt: Date | null;
  tenantDailyRemaining: number;
  tenantMonthlyRemaining: number;
  tenantPackMinutes?: number;
}) {
  const packMinutes = Math.max(0, input.tenantPackMinutes ?? 0);
  const allowance = MONTHLY_MINUTE_CAP + packMinutes;
  return {
    allowance,
    cap: MONTHLY_MINUTE_CAP,
    dailyRemaining: input.tenantDailyRemaining,
    globalAdmissionClosed: input.globalAdmissionClosed,
    monthlyRemaining: input.tenantMonthlyRemaining,
    packMinutes,
    resetsAt: input.resetsAt?.toISOString() ?? null,
    unit: "minutes",
    used: Math.max(0, allowance - input.tenantMonthlyRemaining),
  };
}
