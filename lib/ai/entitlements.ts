import type { RunnerClaims } from "@opencoven/agent-contracts";

type Plan = RunnerClaims["plan"];

type Entitlements = {
  canRunHarness: boolean;
  maxMessagesPerHour: number;
};

export const entitlementsByPlan: Record<Plan, Entitlements> = {
  /**
   * An anonymous or unsubscribed visitor. No credential of their own exists
   * for them to run a harness with, so `canRunHarness` is `false` here too —
   * belt and braces, not the only place this is enforced, but it is the
   * entitlement a paywall would be built on and it must not default open.
   */
  demo: {
    canRunHarness: false,
    maxMessagesPerHour: 10,
  },
  /**
   * A paying tenant. Kept deliberately modest until billing exists to make it
   * meaningful — this entry exists because `Plan` gained `subscriber` and
   * the Record type refuses to be incomplete, which is the point of it.
   */
  subscriber: {
    canRunHarness: true,
    maxMessagesPerHour: 200,
  },
};
