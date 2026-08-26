import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";

export function usageResponsePayload(input: {
  globalAdmissionClosed: boolean;
  resetsAt: Date | null;
  tenantDailyRemaining: number;
  tenantMonthlyRemaining: number;
}) {
  return {
    cap: MONTHLY_RUN_CAP,
    dailyRemaining: input.tenantDailyRemaining,
    globalAdmissionClosed: input.globalAdmissionClosed,
    monthlyRemaining: input.tenantMonthlyRemaining,
    resetsAt: input.resetsAt?.toISOString() ?? null,
    used: Math.max(0, MONTHLY_RUN_CAP - input.tenantMonthlyRemaining),
  };
}
