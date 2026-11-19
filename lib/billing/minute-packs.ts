/**
 * Prepaid top-up packs: a fixed number of minutes for a one-time Stripe
 * payment. Packs extend the monthly bucket and never expire — a run drains
 * the bucket first and packs only once the bucket for the period is empty,
 * so paid minutes are never lost to a quiet month.
 *
 * The repository knows how many minutes each Price grants and nothing about
 * its amount; Stripe discloses the amount at Checkout, as with the plan.
 */
export type MinutePack = Readonly<{ minutes: number; priceId: string }>;

export const MINUTE_PACK_CHECKOUT_KIND = "minute_pack";
export const MINUTE_PACK_FLOW_VERSION = "1";
export const MAX_MINUTE_PACKS = 8;
export const MAX_MINUTE_PACK_MINUTES = 100_000;

const PACK_ENTRY = /^(price_[A-Za-z0-9]{1,60}):([1-9]\d{0,5})$/u;
const INVALID_MINUTE_PACKS =
  "MINUTE_PACK_PRICES must be a comma-separated list of price_<id>:<minutes> entries with unique prices and positive whole minutes.";

/**
 * Parses `MINUTE_PACK_PRICES`, e.g. `price_a:100,price_b:300,price_c:1000`.
 * Blank means packs are not offered. Anything malformed throws, because a
 * pack that credits the wrong minutes is a billing error, not a fallback.
 */
export function parseMinutePacks(configured: string | undefined): MinutePack[] {
  const value = configured?.trim() ?? "";
  if (!value) {
    return [];
  }
  const packs: MinutePack[] = [];
  const seen = new Set<string>();
  for (const entry of value.split(",")) {
    const match = PACK_ENTRY.exec(entry.trim());
    if (!match) {
      throw new Error(INVALID_MINUTE_PACKS);
    }
    const priceId = match[1] as string;
    const minutes = Number(match[2]);
    if (
      seen.has(priceId) ||
      !Number.isSafeInteger(minutes) ||
      minutes <= 0 ||
      minutes > MAX_MINUTE_PACK_MINUTES
    ) {
      throw new Error(INVALID_MINUTE_PACKS);
    }
    seen.add(priceId);
    packs.push({ minutes, priceId });
  }
  if (packs.length > MAX_MINUTE_PACKS) {
    throw new Error(INVALID_MINUTE_PACKS);
  }
  return packs.sort((a, b) => a.minutes - b.minutes);
}

export function minutePacksFromEnv(env: NodeJS.ProcessEnv): MinutePack[] {
  return parseMinutePacks(env.MINUTE_PACK_PRICES);
}

/**
 * The packs a page may offer, for callers that render rather than transact.
 * A malformed setting hides the top-up instead of failing the render: every
 * transacting caller still uses `minutePacksFromEnv` and turns the throw into
 * an explicit error, because selling from a configuration nobody can parse is
 * the one outcome worse than not offering it.
 */
export function offerableMinutePacksFromEnv(
  env: NodeJS.ProcessEnv
): MinutePack[] {
  try {
    return minutePacksFromEnv(env);
  } catch {
    // The setting itself is never logged: it is operator configuration, and
    // the name alone is enough to find it.
    console.error("MINUTE_PACK_PRICES is malformed; top-ups are hidden.");
    return [];
  }
}

export function minutePackForPrice(
  packs: readonly MinutePack[],
  priceId: string
): MinutePack | null {
  return packs.find((pack) => pack.priceId === priceId) ?? null;
}

/**
 * Pack minutes still available to a tenant right now.
 *
 * The historical parameter name is retained for callers. Reservation admission
 * passes recorded ledger allocations, never overflow recomputed from a cap.
 * Callers choose whether to include current-period holds in the subtraction.
 */
export function remainingPackMinutes(input: {
  priorPeriodOverflow: number;
  purchased: number;
}): number {
  if (
    !Number.isSafeInteger(input.purchased) ||
    !Number.isSafeInteger(input.priorPeriodOverflow) ||
    input.purchased < 0 ||
    input.priorPeriodOverflow < 0
  ) {
    throw new Error("Pack minute totals must be non-negative integers.");
  }
  return Math.max(0, input.purchased - input.priorPeriodOverflow);
}
