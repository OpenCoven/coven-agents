import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const threatModelUrl = new URL(
  "../docs/security/execution-threat-model.md",
  import.meta.url
);
const readmeUrl = new URL("../README.md", import.meta.url);
const incidentUrl = new URL(
  "../docs/security/incident-response.md",
  import.meta.url
);
const keyRotationUrl = new URL(
  "../docs/security/key-rotation.md",
  import.meta.url
);

test("the execution threat model covers every required security surface", () => {
  assert.equal(existsSync(threatModelUrl), true);
  const threatModel = readFileSync(threatModelUrl, "utf8");

  for (const heading of [
    "# Execution Threat Model",
    "## Scope and security goals",
    "## Actors and assumptions",
    "## Assets",
    "## Trust boundaries",
    "## Threat register",
    "## Incident and recovery expectations",
    "## Verification and review",
  ]) {
    assert.match(threatModel, new RegExp(heading));
  }

  for (const reference of [
    "worker/src/routes.ts",
    "packages/agent-contracts/src/evidence.ts",
    "lib/credentials/store.ts",
    "coven-agents-cloud.4",
    "coven-agents-security.3",
  ]) {
    assert.match(threatModel, new RegExp(reference.replaceAll(".", "\\.")));
  }
});

test("the README links reviewers to the living threat model", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(
    readme,
    /\[Execution threat model\]\(docs\/security\/execution-threat-model\.md\)/
  );
});

test("the incident runbooks name every secret that exists", () => {
  /**
   * A runbook that omits a credential is worse than no runbook: it reads as
   * complete, so the missing one is not rotated during an incident. Asserted
   * against the real inventory rather than a prose summary.
   */
  assert.equal(existsSync(incidentUrl), true);
  const runbooks = readFileSync(incidentUrl, "utf8");

  for (const secret of [
    "CREDENTIAL_KEK",
    "POSTGRES_URL",
    "AUTH_SECRET",
    "RUNNER_SIGNING_KEY",
    "RUNNER_VERIFY_KEY",
    "AGENT_CONTROL_TOKEN",
    "RUNNER_SERVICE_TOKEN",
    "AUTH_GITHUB_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ]) {
    assert.match(runbooks, new RegExp(secret), `${secret} has no runbook`);
  }

  for (const section of [
    "## Severity",
    "## Credential inventory",
    "## First fifteen minutes",
    "## Runbooks",
    "## Scenario: a secret reached git",
  ]) {
    assert.match(runbooks, new RegExp(section));
  }
});

test("the runbooks state the two facts that break a rotation", () => {
  const runbooks = readFileSync(incidentUrl, "utf8");

  // Both were learned the hard way, and both silently produce a rotation that
  // looks done and is not.
  assert.match(runbooks, /Sensitive variables are write-only/);
  assert.match(runbooks, /redeploy` reuses the existing build/);

  // Rotating the KEK is not recoverable, so the consequence has to be stated
  // where someone will read it before running the command, not after.
  assert.match(runbooks, /destroys access to every stored credential/);

  /**
   * Marking a public variable Sensitive protects nothing -- the value is in
   * every browser's bundle -- while making it unreadable to the people
   * entitled to see it, so changing its visibility means deleting the only
   * copy anyone could still read.
   */
  assert.match(runbooks, /NEXT_PUBLIC_\*` must never be Sensitive/);
  assert.match(runbooks, /--no-sensitive/);

  /**
   * Both directions of the visibility flag, because `vercel env add` gets it
   * wrong either way when it is omitted: a server-side secret lands readable,
   * and a public variable is refused. Learned by rotating for real.
   */
  assert.match(runbooks, /`--sensitive` is required, not decorative/);

  // Setting a variable does not change the running deployment. A rotation that
  // skips this looks complete and has not taken effect.
  assert.match(runbooks, /A redeploy is what makes the new value live/);

  // A copied network trace carries every request header, including the token.
  assert.match(runbooks, /copied network trace is a credential disclosure/);
});

test("the README points to the incident runbooks", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(
    readme,
    /\[Security incident response\]\(docs\/security\/incident-response\.md\)/
  );
});

test("the runner key runbook documents bounded rotation and rollback", () => {
  assert.equal(existsSync(keyRotationUrl), true);
  const runbook = readFileSync(keyRotationUrl, "utf8");

  for (const marker of [
    "RUNNER_SIGNING_KEY_ID",
    "RUNNER_VERIFY_KEY_ID",
    "RUNNER_VERIFY_PREVIOUS_LAST_SIGNED_AT",
    "RUNNER_VERIFY_PREVIOUS_RETIRE_AT",
    "15 minutes plus",
    "Rollback",
    "never commit or log",
  ]) {
    assert.match(runbook, new RegExp(marker.replaceAll("*", "\\*")));
  }
});

test("auth callbacks and the client update preserve server-owned identity", () => {
  const authSource = readFileSync(
    new URL("../app/(auth)/auth.ts", import.meta.url),
    "utf8"
  );
  const avatarSource = readFileSync(
    new URL("../components/account/avatar-settings.tsx", import.meta.url),
    "utf8"
  );

  assert.match(authSource, /token\.authVersion = row\.authVersion/);
  assert.match(authSource, /session\.user\.authVersion = token\.authVersion/);
  assert.match(authSource, /return refreshTokenType\(token, new Date\(\)\)/);
  assert.match(avatarSource, /await update\(\{ image \}\)/);
});
