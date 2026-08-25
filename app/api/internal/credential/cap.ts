import { MONTHLY_RUN_CAP } from "@/lib/billing/limits";

export type CapVerdict =
  | { cap: number; kind: "refused"; resetsAt: string | null; used: number }
  | { kind: "allowed" };

/**
 * Decides whether another run fits inside the period's cap.
 *
 * A pure function rather than logic inside the handler, because this decides
 * whether a paying customer can work and route-handler logic is unreachable by
 * a unit test.
 *
 * Fails closed on an unknown period: an error reading usage is not permission
 * to exceed the cap, and allowing on error is how a cap quietly stops
 * existing.
 */
export function capVerdict(input: {
  resetsAt: Date | null;
  used: number;
}): CapVerdict {
  if (!input.resetsAt) {
    return {
      cap: MONTHLY_RUN_CAP,
      kind: "refused",
      resetsAt: null,
      used: input.used,
    };
  }

  if (input.used >= MONTHLY_RUN_CAP) {
    return {
      cap: MONTHLY_RUN_CAP,
      kind: "refused",
      resetsAt: input.resetsAt.toISOString(),
      used: input.used,
    };
  }

  return { kind: "allowed" };
}
