import { isAllowedIdentity, readBetaGate } from "../beta";

/**
 * The open beta campaign: a bounded grant of run minutes to anyone who signs
 * in with GitHub.
 *
 * A campaign participant is a real account with a real tenant. What separates
 * them from a paying customer is the *source* of their entitlement, not their
 * session type — so this module never touches `subscribedUntil`. Reusing that
 * column would make a participant indistinguishable from a payer in
 * `subscription-status`, `admin/directory` and Stripe reconciliation, and the
 * reconciler would eventually see a subscription date with no Stripe
 * subscription behind it and have to guess which one was wrong.
 *
 * Five numbers bound the campaign's cost, and all of them are read here so
 * that no two callers can disagree about what was promised:
 *
 * - `minutes`          what one account may spend in total
 * - `runMinutes`       what one run may reserve, and therefore how long it runs
 * - `maxAccounts`      how many accounts may ever enroll
 * - `minAccountAgeDays` how old the GitHub account must be to enroll
 * - `grantDays`        how long the minutes remain spendable
 *
 * Worst-case exposure is `maxAccounts * minutes` of run time plus the idle
 * sandbox tail each run leaves behind, which is the number to reason about
 * when setting the cap — not `minutes` alone.
 */

const CAMPAIGN_NUMBERS = [
  "BETA_CAMPAIGN_GRANT_DAYS",
  "BETA_CAMPAIGN_MAX_ACCOUNTS",
  "BETA_CAMPAIGN_MINUTES",
  "BETA_CAMPAIGN_MIN_ACCOUNT_AGE_DAYS",
  "BETA_CAMPAIGN_RUN_MINUTES",
] as const;

type CampaignNumber = (typeof CAMPAIGN_NUMBERS)[number];

export type CampaignEnvironment = Partial<
  Record<CampaignNumber | "BETA_CAMPAIGN_ENABLED", string | undefined>
> &
  Record<string, string | undefined>;

export type CampaignPolicy = Readonly<{
  pilotEndsAtMs?: number;
  enabled: boolean;
  grantDays: number;
  maxAccounts: number;
  minAccountAgeDays: number;
  minutes: number;
  runMinutes: number;
}>;

export type CampaignGrant = Readonly<{
  campaignExpiresAt?: Date | null;
  campaignGrantedAt?: Date | null;
}>;

/**
 * The billing period every campaign reservation is filed under.
 *
 * `reserveRun` sums a tenant's usage with `periodMonth = <this>`, so a single
 * fixed date turns the monthly bucket into a lifetime one at no schema cost:
 * every campaign run an account ever makes lands in the same bucket and counts
 * against the same 20 minutes.
 *
 * Deliberately a global constant rather than each account's own grant date. If
 * the period key were per-account, re-issuing a grant would move the key and
 * silently reset usage to zero — turning an operator's "let me re-grant that"
 * into an unbounded refill. A fixed key means a re-grant extends the deadline
 * and nothing else.
 *
 * The exact instant is arbitrary and must never change once a campaign has
 * run: moving it would orphan every reservation already filed under the old
 * value, which reads as a full refund of everyone's minutes.
 */
export const CAMPAIGN_PERIOD_EPOCH = new Date("2026-01-01T00:00:00.000Z");

const DISABLED: CampaignPolicy = Object.freeze({
  enabled: false,
  grantDays: 0,
  maxAccounts: 0,
  minAccountAgeDays: 0,
  minutes: 0,
  runMinutes: 0,
});

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function positiveInteger(value: string | undefined): number | null {
  const trimmed = value?.trim() ?? "";
  if (!/^[1-9]\d*$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Reads the campaign from the environment, failing closed.
 *
 * Enabling requires `BETA_CAMPAIGN_ENABLED` to be exactly `on`, following the
 * `BETA_MODE` tradition: truthiness would read the string `"false"` as enabled.
 *
 * Any missing or malformed number disables the whole campaign rather than
 * substituting a default. A default here is a number nobody chose being used
 * to give away compute — a typo in `BETA_CAMPAIGN_MAX_ACCOUNTS` should stop
 * enrollment, not admit everyone. `validateCampaignConfig` is what makes that
 * typo loud at boot instead of merely safe.
 */
export function campaignEnabled(env: CampaignEnvironment): boolean {
  return (
    env.BETA_CAMPAIGN_ENABLED === "on" ||
    env.BETA_CAMPAIGN_ENABLED === "invite-only"
  );
}

export function campaignEnrollmentPolicy(
  env: CampaignEnvironment,
  verifiedEmail: string
): CampaignPolicy {
  if (
    env.BETA_CAMPAIGN_ENABLED === "invite-only" &&
    !isAllowedIdentity(readBetaGate(env), verifiedEmail)
  ) {
    return DISABLED;
  }
  return readCampaignPolicy(env);
}

function pilotDeadline(env: CampaignEnvironment): number | undefined {
  const raw = env.BETA_CAMPAIGN_ENDS_AT ?? "";
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && new Date(ms).toISOString() === raw
    ? ms
    : undefined;
}

export function readCampaignPolicy(env: CampaignEnvironment): CampaignPolicy {
  if (!campaignEnabled(env)) {
    return DISABLED;
  }

  const pilotEndsAtMs =
    env.BETA_CAMPAIGN_ENABLED === "invite-only"
      ? pilotDeadline(env)
      : undefined;
  if (
    env.BETA_CAMPAIGN_ENABLED === "invite-only" &&
    pilotEndsAtMs === undefined
  ) {
    return DISABLED;
  }

  const grantDays = positiveInteger(env.BETA_CAMPAIGN_GRANT_DAYS);
  const maxAccounts = positiveInteger(env.BETA_CAMPAIGN_MAX_ACCOUNTS);
  const minAccountAgeDays = positiveInteger(
    env.BETA_CAMPAIGN_MIN_ACCOUNT_AGE_DAYS
  );
  const minutes = positiveInteger(env.BETA_CAMPAIGN_MINUTES);
  const runMinutes = positiveInteger(env.BETA_CAMPAIGN_RUN_MINUTES);

  if (
    grantDays === null ||
    maxAccounts === null ||
    minAccountAgeDays === null ||
    minutes === null ||
    runMinutes === null ||
    runMinutes > minutes
  ) {
    return DISABLED;
  }

  return Object.freeze({
    ...(pilotEndsAtMs === undefined ? {} : { pilotEndsAtMs }),
    enabled: true,
    grantDays,
    maxAccounts,
    minAccountAgeDays,
    minutes,
    runMinutes,
  });
}

/**
 * Throws on a campaign that is switched on but misconfigured.
 *
 * `readCampaignPolicy` fails closed silently because it runs inside the auth
 * callback, where throwing would break sign-in for everyone rather than just
 * withholding the campaign. This runs at boot and at deploy validation, where
 * a loud failure is exactly what is wanted.
 *
 * `runMinutes > minutes` is rejected because it promises a run length the
 * grant cannot fund: admission would refuse the very first run, and the
 * account would see "20 minutes" next to a button that never works.
 */
export function validateCampaignConfig(env: CampaignEnvironment): void {
  if (!campaignEnabled(env)) {
    return;
  }

  if (
    env.BETA_CAMPAIGN_ENABLED === "invite-only" &&
    pilotDeadline(env) === undefined
  ) {
    throw new Error(
      "BETA_CAMPAIGN_ENDS_AT must be a UTC ISO timestamp with milliseconds for an invite-only campaign."
    );
  }
  for (const name of CAMPAIGN_NUMBERS) {
    if (positiveInteger(env[name]) === null) {
      throw new Error(
        `${name} must be a positive integer when the beta campaign is on.`
      );
    }
  }

  const minutes = positiveInteger(env.BETA_CAMPAIGN_MINUTES) as number;
  const runMinutes = positiveInteger(env.BETA_CAMPAIGN_RUN_MINUTES) as number;
  if (runMinutes > minutes) {
    throw new Error(
      "BETA_CAMPAIGN_RUN_MINUTES must not exceed BETA_CAMPAIGN_MINUTES, " +
        "because a run that cannot be funded by the grant can never be admitted."
    );
  }
}

/**
 * When a grant issued now should stop being spendable.
 */
export function campaignExpiryFrom(policy: CampaignPolicy, now: Date): Date {
  return new Date(
    Math.min(
      now.getTime() + policy.grantDays * MILLISECONDS_PER_DAY,
      policy.pilotEndsAtMs ?? Number.POSITIVE_INFINITY
    )
  );
}

/**
 * Whether this account currently holds spendable campaign minutes.
 *
 * Reads only the stored grant, never the policy flag. A grant is a promise
 * already made: switching the campaign off must stop *new* enrollment without
 * confiscating minutes from the people already holding them, and a config typo
 * must never silently revoke an entitlement someone is mid-run against.
 *
 * Strictly greater, matching `isSubscribedAt`: a grant that expired this
 * instant has expired.
 */
export function campaignGrantActiveAt(
  user: CampaignGrant | null | undefined,
  now: Date
): boolean {
  const granted = user?.campaignGrantedAt;
  const expires = user?.campaignExpiresAt;
  if (!(granted instanceof Date && expires instanceof Date)) {
    return false;
  }
  if (Number.isNaN(granted.getTime()) || Number.isNaN(expires.getTime())) {
    return false;
  }
  return expires.getTime() > now.getTime();
}

/**
 * Whether a GitHub account is old enough to enroll.
 *
 * The campaign is open to anyone with a GitHub account, which makes minting
 * fresh GitHub accounts the cheapest way to farm free compute. Account age is
 * the one signal GitHub gives us that a farmer cannot backdate.
 *
 * An unknown or unparseable creation date is refused rather than admitted:
 * this is the check standing between an open campaign and an unbounded bill,
 * so it fails closed like every other gate here.
 */
export function githubAccountOldEnough(
  policy: CampaignPolicy,
  createdAt: Date | null | undefined,
  now: Date
): boolean {
  if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
    return false;
  }
  const age = now.getTime() - createdAt.getTime();
  return age >= policy.minAccountAgeDays * MILLISECONDS_PER_DAY;
}
