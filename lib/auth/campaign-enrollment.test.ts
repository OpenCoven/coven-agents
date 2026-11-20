import assert from "node:assert/strict";
import test from "node:test";
import { readCampaignPolicy } from "@/lib/billing/campaign";
import type { CampaignEnrollment } from "@/lib/db/queries";
import {
  type CampaignEnrollmentDependencies,
  type EnrollableUser,
  enrollInCampaignIfEligible,
} from "./campaign-enrollment";

const POLICY = readCampaignPolicy({
  BETA_CAMPAIGN_ENABLED: "on",
  BETA_CAMPAIGN_GRANT_DAYS: "14",
  BETA_CAMPAIGN_MAX_ACCOUNTS: "500",
  BETA_CAMPAIGN_MIN_ACCOUNT_AGE_DAYS: "30",
  BETA_CAMPAIGN_MINUTES: "20",
  BETA_CAMPAIGN_RUN_MINUTES: "5",
});

const NOW = new Date("2026-09-06T00:00:00.000Z");
const OLD_ENOUGH = new Date("2026-01-01T00:00:00.000Z");
const TOO_YOUNG = new Date("2026-09-01T00:00:00.000Z");

const FRESH: EnrollableUser = {
  campaignExpiresAt: null,
  campaignGrantedAt: null,
  id: "11111111-1111-4111-8111-111111111111",
  subscribedUntil: null,
};

function dependencies(
  overrides: Partial<CampaignEnrollmentDependencies> = {}
): CampaignEnrollmentDependencies & { enrolled: unknown[] } {
  const enrolled: unknown[] = [];
  return {
    enroll: (input) => {
      enrolled.push(input);
      return Promise.resolve({
        kind: "enrolled",
        user: {
          ...FRESH,
          campaignExpiresAt: input.expiresAt,
          campaignGrantedAt: input.grantedAt,
        },
      } as CampaignEnrollment);
    },
    enrolled,
    fetchAccountCreatedAt: () => Promise.resolve(OLD_ENOUGH),
    ...overrides,
  };
}

test("an eligible sign-in is granted minutes with the configured expiry", async () => {
  const deps = dependencies();
  const outcome = await enrollInCampaignIfEligible(
    { accessToken: "t", now: NOW, policy: POLICY, user: FRESH },
    deps
  );
  assert.equal(outcome.kind, "enrolled");
  assert.deepEqual(deps.enrolled, [
    {
      expiresAt: new Date("2026-09-20T00:00:00.000Z"),
      grantedAt: NOW,
      maxAccounts: 500,
      userId: FRESH.id,
    },
  ]);
});

test("a disabled campaign does no work at all", async () => {
  const deps = dependencies({
    fetchAccountCreatedAt: () => {
      throw new Error("must not call GitHub when the campaign is off");
    },
  });
  const outcome = await enrollInCampaignIfEligible(
    {
      accessToken: "t",
      now: NOW,
      policy: readCampaignPolicy({}),
      user: FRESH,
    },
    deps
  );
  assert.equal(outcome.kind, "disabled");
  assert.deepEqual(deps.enrolled, []);
});

test("an already enrolled account is never re-granted", async () => {
  // An expired grant is still a grant: re-granting on expiry would turn the
  // campaign into an unlimited refill on a timer.
  const deps = dependencies({
    fetchAccountCreatedAt: () => {
      throw new Error("must not call GitHub for an enrolled account");
    },
  });
  const outcome = await enrollInCampaignIfEligible(
    {
      accessToken: "t",
      now: NOW,
      policy: POLICY,
      user: {
        ...FRESH,
        campaignExpiresAt: new Date("2026-08-01T00:00:00.000Z"),
        campaignGrantedAt: new Date("2026-07-18T00:00:00.000Z"),
      },
    },
    deps
  );
  assert.equal(outcome.kind, "already_enrolled");
  assert.deepEqual(deps.enrolled, []);
});

test("a paying subscriber does not consume a campaign slot", async () => {
  const deps = dependencies();
  const outcome = await enrollInCampaignIfEligible(
    {
      accessToken: "t",
      now: NOW,
      policy: POLICY,
      user: {
        ...FRESH,
        subscribedUntil: new Date("2026-10-01T00:00:00.000Z"),
      },
    },
    deps
  );
  assert.equal(outcome.kind, "subscriber");
  assert.deepEqual(deps.enrolled, []);
});

test("a GitHub account below the age floor is refused before any write", async () => {
  const deps = dependencies({
    fetchAccountCreatedAt: () => Promise.resolve(TOO_YOUNG),
  });
  const outcome = await enrollInCampaignIfEligible(
    { accessToken: "t", now: NOW, policy: POLICY, user: FRESH },
    deps
  );
  assert.equal(outcome.kind, "account_too_young");
  assert.deepEqual(deps.enrolled, []);
});

test("an unreadable account age is refused rather than admitted", async () => {
  const deps = dependencies({
    fetchAccountCreatedAt: () => Promise.resolve(null),
  });
  const outcome = await enrollInCampaignIfEligible(
    { accessToken: "t", now: NOW, policy: POLICY, user: FRESH },
    deps
  );
  assert.equal(outcome.kind, "account_too_young");
  assert.deepEqual(deps.enrolled, []);
});

test("a full campaign reports itself full", async () => {
  const deps = dependencies({
    enroll: () =>
      Promise.resolve({ kind: "campaign_full" } as CampaignEnrollment),
  });
  const outcome = await enrollInCampaignIfEligible(
    { accessToken: "t", now: NOW, policy: POLICY, user: FRESH },
    deps
  );
  assert.equal(outcome.kind, "campaign_full");
});

test("a failing GitHub call or database never breaks the sign-in", async () => {
  // Missing out on free minutes is strictly better than being unable to log in.
  const outcomes = await Promise.all(
    [
      dependencies({
        fetchAccountCreatedAt: () => Promise.reject(new Error("github down")),
      }),
      dependencies({
        enroll: () => Promise.reject(new Error("database down")),
      }),
    ].map((deps) =>
      enrollInCampaignIfEligible(
        { accessToken: "t", now: NOW, policy: POLICY, user: FRESH },
        deps
      )
    )
  );
  for (const outcome of outcomes) {
    assert.equal(outcome.kind, "unavailable");
  }
});

test("the shared invite window includes its opening instant and excludes its deadline", async () => {
  const end = NOW.getTime() + 86_400_000;
  const policy = { ...POLICY, grantDays: 1, pilotEndsAtMs: end };
  await Promise.all(
    [NOW.getTime() - 1, NOW.getTime(), end - 1, end].map(async (instant) => {
      const deps = dependencies();
      const result = await enrollInCampaignIfEligible(
        { accessToken: undefined, now: new Date(instant), policy, user: FRESH },
        deps
      );
      if (instant >= NOW.getTime() && instant < end) {
        assert.equal(result.kind, "enrolled");
        assert.equal(result.user.campaignExpiresAt?.getTime(), end);
      } else {
        assert.equal(result.kind, "disabled");
        assert.deepEqual(deps.enrolled, []);
      }
    })
  );
});
