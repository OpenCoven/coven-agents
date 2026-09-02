import { MONTHLY_MINUTE_CAP } from "@/lib/billing/limits";

export function usageResponsePayload(input: {
  globalAdmissionClosed: boolean;
  resetsAt: Date | null;
  tenantDailyRemaining: number;
  tenantMonthlyRemaining: number;
}) {
  return {
    cap: MONTHLY_MINUTE_CAP,
    dailyRemaining: input.tenantDailyRemaining,
    globalAdmissionClosed: input.globalAdmissionClosed,
    monthlyRemaining: input.tenantMonthlyRemaining,
    resetsAt: input.resetsAt?.toISOString() ?? null,
    unit: "minutes",
    used: Math.max(0, MONTHLY_MINUTE_CAP - input.tenantMonthlyRemaining),
  };
}
