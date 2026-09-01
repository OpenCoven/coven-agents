import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const threatModelUrl = new URL(
  "../docs/security/execution-threat-model.md",
  import.meta.url
);
const envExampleUrl = new URL("../.env.example", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);
const incidentUrl = new URL(
  "../docs/security/incident-response.md",
  import.meta.url
);
const keyRotationUrl = new URL(
  "../docs/security/key-rotation.md",
  import.meta.url
);
const securityPageUrl = new URL("../app/security/page.tsx", import.meta.url);
const loginPageUrl = new URL("../app/(auth)/login/page.tsx", import.meta.url);
const runtimeInspectorUrl = new URL(
  "../components/console/runtime-inspector.tsx",
  import.meta.url
);
const currentCredentialEnvironment = [
  "ABUSE_KEY_SECRET",
  "AI_GATEWAY_API_KEY",
  "AUTH_GITHUB_SECRET",
  "AUTH_SECRET",
  "BLOB_READ_WRITE_TOKEN",
  "CREDENTIAL_KEK",
  "CREDENTIAL_KEK_CURRENT_VERSION",
  "CREDENTIAL_KEK_V1",
  "CREDENTIAL_KEK_V2",
  "CRON_SECRET",
  "DAYTONA_API_KEY",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_STATE_SIGNING_SECRET",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "RUNNER_MANUAL_RECONCILE_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

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
    "packages/agent-contracts/src/evidence.ts",
    "lib/credentials/store.ts",
    "lib/credentials/runner-credential.ts",
    "lib/runner/runtime.ts",
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

test("public security claims describe the same-origin Daytona boundary", () => {
  const page = readFileSync(securityPageUrl, "utf8");
  const login = readFileSync(loginPageUrl, "utf8");

  assert.equal(
    page.includes(
      "Each agent executes in one tenant-scoped persistent Daytona sandbox."
    ),
    true
  );
  assert.equal(
    page.includes(
      "Browser requests reach Daytona only through the same-origin Next.js API."
    ),
    true
  );
  assert.equal(
    login.includes(
      "Agents run in isolated Daytona sandboxes — never on your machine."
    ),
    true
  );
});

test("the runtime inspector describes the current provider boundary", () => {
  const inspector = readFileSync(runtimeInspectorUrl, "utf8");

  assert.equal(
    inspector.includes("<span style={type_.meta}>Daytona sandbox</span>"),
    true
  );
  assert.equal(
    inspector.includes(
      "Each agent has one tenant-scoped persistent workspace. Runs use"
    ),
    true
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
    "CREDENTIAL_KEK_CURRENT_VERSION",
    "CREDENTIAL_KEK_V1",
    "CREDENTIAL_KEK_V2",
    "POSTGRES_URL",
    "AUTH_SECRET",
    "OPERATOR_DIAGNOSTIC_TOKEN",
    "RUNNER_MANUAL_RECONCILE_SECRET",
    "CRON_SECRET",
    "DAYTONA_API_KEY",
    "AUTH_GITHUB_SECRET",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_STATE_SIGNING_SECRET",
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

test("the environment example exposes the current credential allowlist", () => {
  const envExample = readFileSync(envExampleUrl, "utf8");
  const observed = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)]
    .map((match) => match[1] ?? "")
    .filter(
      (name) =>
        name.startsWith("CREDENTIAL_KEK") ||
        /(?:KEY|SECRET|TOKEN)(?:_|$)/u.test(name)
    )
    .sort();

  assert.deepEqual(observed, [...currentCredentialEnvironment]);
});

test("the runner diagnostic uses the separate operator credential", () => {
  const auth = readFileSync(
    new URL("../lib/runner/auth.ts", import.meta.url),
    "utf8"
  );

  assert.deepEqual(
    [
      ...new Set(
        [...auth.matchAll(/environment\.([A-Z][A-Z0-9_]*)/gu)].map(
          (match) => match[1] ?? ""
        )
      ),
    ].sort(),
    [
      "CRON_SECRET",
      "OPERATOR_DIAGNOSTIC_TOKEN",
      "RUNNER_MANUAL_RECONCILE_SECRET",
    ]
  );
});

test("the README points to the incident runbooks", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(
    readme,
    /\[Security incident response\]\(docs\/security\/incident-response\.md\)/
  );
});

test("the credential key runbook documents the current staged rewrap contract", () => {
  const runbook = readFileSync(keyRotationUrl, "utf8");

  for (const marker of [
    "CREDENTIAL_KEK_CURRENT_VERSION",
    "CREDENTIAL_KEK_V1",
    "CREDENTIAL_KEK_V2",
    "credentials:rewrap --from v1 --to v2",
    "credentials:rewrap verify --version v1",
    "zero `v1` rows",
    "opaque row",
    "Exit `0`",
    "Exit `2`",
    "Exit `1`",
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
  const avatarLibrary = readFileSync(
    new URL("../lib/avatar.ts", import.meta.url),
    "utf8"
  );

  assert.match(authSource, /token\.authVersion = row\.authVersion/);
  assert.match(authSource, /session\.user\.authVersion = token\.authVersion/);
  assert.match(authSource, /return refreshTokenType\(token, new Date\(\)\)/);
  assert.match(avatarSource, /refreshAvatarSession\(image, update\)/);
  assert.match(avatarLibrary, /const session = await update\(\{\}\)/);
  assert.doesNotMatch(avatarLibrary, /update\(\{\s*image\s*[:},]/);
});
