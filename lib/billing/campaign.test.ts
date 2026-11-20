import assert from "node:assert/strict";
import test from "node:test";
import {
  CAMPAIGN_PERIOD_EPOCH,
  campaignEnrollmentPolicy,
  campaignExpiryFrom,
  campaignGrantActiveAt,
  githubAccountOldEnough,
  readCampaignPolicy,
  validateCampaignConfig,
} from "./campaign";

const CONFIGURED = {
  BETA_CAMPAIGN_ENABLED: "on",
  BETA_CAMPAIGN_GRANT_DAYS: "14",
  BETA_CAMPAIGN_MAX_ACCOUNTS: "500",
  BETA_CAMPAIGN_MIN_ACCOUNT_AGE_DAYS: "30",
  BETA_CAMPAIGN_MINUTES: "20",
  BETA_CAMPAIGN_RUN_MINUTES: "5",
};

test("a fully configured campaign reads back exactly what was configured", () => {
  assert.deepEqual(readCampaignPolicy(CONFIGURED), {
    enabled: true,
    grantDays: 14,
    maxAccounts: 500,
    minAccountAgeDays: 30,
    minutes: 20,
    runMinutes: 5,
  });
});

test("the campaign is off unless the flag is exactly 'on'", () => {
  for (const flag of [undefined, "", "off", "true", "1", "ON", "false"]) {
    const policy = readCampaignPolicy({
      ...CONFIGURED,
      BETA_CAMPAIGN_ENABLED: flag,
    });
    assert.equal(policy.enabled, false, `flag ${JSON.stringify(flag)}`);
  }
});

test("any malformed number disables the campaign rather than defaulting", () => {
  const names = [
    "BETA_CAMPAIGN_GRANT_DAYS",
    "BETA_CAMPAIGN_MAX_ACCOUNTS",
    "BETA_CAMPAIGN_MINUTES",
    "BETA_CAMPAIGN_MIN_ACCOUNT_AGE_DAYS",
    "BETA_CAMPAIGN_RUN_MINUTES",
  ] as const;
  for (const name of names) {
    for (const bad of [undefined, "", " ", "0", "-5", "5.5", "twenty", "1e3"]) {
      const policy = readCampaignPolicy({ ...CONFIGURED, [name]: bad });
      assert.equal(
        policy.enabled,
        false,
        `${name}=${JSON.stringify(bad)} must disable the campaign`
      );
    }
  }
});

test("a run longer than the whole grant is refused as a configuration", () => {
  // Admission would refuse the first run, leaving the account staring at a
  // minute balance next to a button that can never work.
  const policy = readCampaignPolicy({
    ...CONFIGURED,
    BETA_CAMPAIGN_MINUTES: "5",
    BETA_CAMPAIGN_RUN_MINUTES: "20",
  });
  assert.equal(policy.enabled, false);
  assert.throws(
    () =>
      validateCampaignConfig({
        ...CONFIGURED,
        BETA_CAMPAIGN_MINUTES: "5",
        BETA_CAMPAIGN_RUN_MINUTES: "20",
      }),
    /must not exceed/
  );
});

test("validation is silent when the campaign is off and loud when it is on", () => {
  assert.doesNotThrow(() => validateCampaignConfig({}));
  assert.doesNotThrow(() =>
    validateCampaignConfig({ BETA_CAMPAIGN_ENABLED: "off" })
  );
  assert.doesNotThrow(() => validateCampaignConfig(CONFIGURED));
  assert.throws(
    () =>
      validateCampaignConfig({
        ...CONFIGURED,
        BETA_CAMPAIGN_MAX_ACCOUNTS: undefined,
      }),
    /BETA_CAMPAIGN_MAX_ACCOUNTS must be a positive integer/
  );
});

test("a grant expires strictly, and an absent grant is never active", () => {
  const granted = new Date("2026-09-01T00:00:00.000Z");
  const expires = new Date("2026-09-15T00:00:00.000Z");
  const grant = { campaignExpiresAt: expires, campaignGrantedAt: granted };

  assert.equal(
    campaignGrantActiveAt(grant, new Date("2026-09-14T23:59:59.000Z")),
    true
  );
  // Strictly greater: a grant that expired this instant has expired.
  assert.equal(campaignGrantActiveAt(grant, expires), false);
  assert.equal(
    campaignGrantActiveAt(grant, new Date("2026-09-16T00:00:00.000Z")),
    false
  );

  assert.equal(campaignGrantActiveAt(null, granted), false);
  assert.equal(campaignGrantActiveAt(undefined, granted), false);
  assert.equal(
    campaignGrantActiveAt(
      { campaignExpiresAt: null, campaignGrantedAt: null },
      granted
    ),
    false
  );
  assert.equal(
    campaignGrantActiveAt(
      { campaignExpiresAt: new Date("nope"), campaignGrantedAt: granted },
      granted
    ),
    false
  );
});

test("expiry is the grant window measured from the moment of the grant", () => {
  assert.deepEqual(
    campaignExpiryFrom(
      readCampaignPolicy(CONFIGURED),
      new Date("2026-09-01T12:00:00.000Z")
    ),
    new Date("2026-09-15T12:00:00.000Z")
  );
});

test("a GitHub account younger than the floor cannot enroll", () => {
  const policy = readCampaignPolicy(CONFIGURED);
  const now = new Date("2026-09-06T00:00:00.000Z");

  assert.equal(
    githubAccountOldEnough(policy, new Date("2026-08-07T00:00:00.000Z"), now),
    true,
    "30 days old exactly is old enough"
  );
  assert.equal(
    githubAccountOldEnough(policy, new Date("2026-08-08T00:00:00.000Z"), now),
    false,
    "29 days old is too young"
  );
});

test("an unknown account creation date fails closed", () => {
  const policy = readCampaignPolicy(CONFIGURED);
  const now = new Date("2026-09-06T00:00:00.000Z");
  assert.equal(githubAccountOldEnough(policy, null, now), false);
  assert.equal(githubAccountOldEnough(policy, undefined, now), false);
  assert.equal(githubAccountOldEnough(policy, new Date("nope"), now), false);
});

test("the campaign period epoch is a fixed instant", () => {
  // Moving this orphans every reservation already filed under the old value,
  // which reads as a full refund of everyone's minutes.
  assert.equal(CAMPAIGN_PERIOD_EPOCH.toISOString(), "2026-01-01T00:00:00.000Z");
});

test("invite-only grants require a listed verified address and retain their budget", () => {
  const env = {
    ...CONFIGURED,
    BETA_ALLOWLIST: "one@example.invalid,two@example.invalid",
    BETA_CAMPAIGN_ENABLED: "invite-only",
    BETA_CAMPAIGN_ENDS_AT: "2026-11-22T00:00:00.000Z",
    BETA_CAMPAIGN_MINUTES: "10",
    BETA_CAMPAIGN_RUN_MINUTES: "5",
  };
  const invited = campaignEnrollmentPolicy(env, "TWO@example.invalid");
  assert.equal(invited.enabled, true);
  assert.equal(invited.minutes, 10);
  assert.equal(invited.runMinutes, 5);
  assert.equal(
    campaignEnrollmentPolicy(env, "three@example.invalid").enabled,
    false
  );
  assert.equal(
    campaignEnrollmentPolicy(
      { ...env, BETA_ALLOWLIST: "" },
      "one@example.invalid"
    ).enabled,
    false
  );
});

test("invite-only enrollment requires a valid common deadline and clips late grants", () => {
  const env = {
    ...CONFIGURED,
    BETA_CAMPAIGN_ENABLED: "invite-only",
    BETA_CAMPAIGN_GRANT_DAYS: "1",
  };
  for (const value of [undefined, "invalid", "2026-02-31T00:00:00.000Z"]) {
    const config = { ...env, BETA_CAMPAIGN_ENDS_AT: value };
    assert.equal(readCampaignPolicy(config).enabled, false);
    assert.throws(
      () => validateCampaignConfig(config),
      /BETA_CAMPAIGN_ENDS_AT/
    );
  }
  const end = "2026-11-22T00:00:00.000Z";
  const policy = readCampaignPolicy({ ...env, BETA_CAMPAIGN_ENDS_AT: end });
  assert.equal(
    campaignExpiryFrom(policy, new Date("2026-11-21T23:55:00Z")).toISOString(),
    end
  );
});
