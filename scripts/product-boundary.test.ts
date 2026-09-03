import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MONTHLY_MINUTE_CAP } from "@/lib/billing/limits";

const repositoryRoot = new URL("../", import.meta.url);
const repositoryPath = fileURLToPath(repositoryRoot);
const adrUrl = new URL(
  "docs/architecture/adr-001-product-authority-boundary.md",
  repositoryRoot
);
const daytonaAdrUrl = new URL(
  "docs/architecture/adr-002-daytona-execution-boundary.md",
  repositoryRoot
);
const cutoverAttestationUrl = new URL(
  "docs/operations/daytona-cutover-attestation.md",
  repositoryRoot
);
const readmeUrl = new URL("README.md", repositoryRoot);
const roadmapUrl = new URL("ROADMAP.md", repositoryRoot);
const releaseReadinessUrl = new URL(
  "docs/roadmap/release-readiness.md",
  repositoryRoot
);
const deliveryGovernanceUrl = new URL(
  "docs/roadmap/delivery-governance.md",
  repositoryRoot
);
const historicalTombstoneUrl = new URL(
  "docs/superpowers/README.md",
  repositoryRoot
);
const historicalUiAuditUrl = new URL(
  "docs/roadmap/ui-functionality-audit-2026-08-26.md",
  repositoryRoot
);
const subscriptionPolicyUrl = new URL(
  "docs/product/subscription-billing-policy.md",
  repositoryRoot
);
const manifestPaths = [
  "package.json",
  "packages/agent-contracts/package.json",
  "packages/harness/package.json",
] as const;
const allowedWorkspacePackages = new Set([
  "@opencoven/agent-contracts",
  "@opencoven/harness",
]);
const applicationRouteFiles = [
  "app/(auth)/api/auth/[...nextauth]/route.ts",
  "app/(chat)/api/chat/[id]/stream/route.ts",
  "app/(chat)/api/chat/route.ts",
  "app/(chat)/api/document/route.ts",
  "app/(chat)/api/files/upload/route.ts",
  "app/(chat)/api/history/route.ts",
  "app/(chat)/api/messages/route.ts",
  "app/(chat)/api/models/route.ts",
  "app/(chat)/api/suggestions/route.ts",
  "app/(chat)/api/vote/route.ts",
  "app/api/account/avatar/route.ts",
  "app/api/admin/route.ts",
  "app/api/agents/[id]/route.ts",
  "app/api/agents/[id]/runs/route.ts",
  "app/api/agents/route.ts",
  "app/api/analytics/route.ts",
  "app/api/checkout/route.ts",
  "app/api/credentials/device/route.ts",
  "app/api/credentials/route.ts",
  "app/api/diagnostics/sandbox/route.ts",
  "app/api/github/callback/route.ts",
  "app/api/github/connection/route.ts",
  "app/api/github/install/route.ts",
  "app/api/harnesses/route.ts",
  "app/api/health/route.ts",
  "app/api/internal/github-tool/route.ts",
  "app/api/internal/runner-reconcile/route.ts",
  "app/api/internal/runner-resource-inventory/route.ts",
  "app/api/internal/runner-resource-repair/route.ts",
  "app/api/internal/stripe-reconcile/route.ts",
  "app/api/runs/[id]/events/route.ts",
  "app/api/runs/[id]/route.ts",
  "app/api/runs/[id]/stop/route.ts",
  "app/api/skills/[id]/route.ts",
  "app/api/skills/route.ts",
  "app/api/stripe/webhook/route.ts",
  "app/api/subscription/route.ts",
  "app/api/team-runs/[id]/approve/route.ts",
  "app/api/team-runs/[id]/route.ts",
  "app/api/team-runs/[id]/stop/route.ts",
  "app/api/teams/[id]/route.ts",
  "app/api/teams/[id]/runs/route.ts",
  "app/api/teams/route.ts",
  "app/api/tenant/prewarm/route.ts",
  "app/api/usage/route.ts",
] as const;
const agentBoundaryFiles = [
  "lib/agents/browser-transport.test.ts",
  "lib/agents/browser-transport.ts",
  "lib/agents/client.test.ts",
  "lib/agents/client.ts",
  "lib/agents/connection-status.test.ts",
  "lib/agents/connection-status.ts",
  "lib/agents/formations.test.ts",
  "lib/agents/formations.ts",
] as const;
const contractSourceFiles = [
  "packages/agent-contracts/src/demo-transcript.test.ts",
  "packages/agent-contracts/src/evidence-safety.test.ts",
  "packages/agent-contracts/src/evidence.ts",
  "packages/agent-contracts/src/export-fixture.test.ts",
  "packages/agent-contracts/src/export-fixture.ts",
  "packages/agent-contracts/src/identity.test.ts",
  "packages/agent-contracts/src/identity.ts",
  "packages/agent-contracts/src/index.test.ts",
  "packages/agent-contracts/src/index.ts",
  "packages/agent-contracts/src/team.test.ts",
] as const;
const credentialSourceFiles = [
  "lib/credentials/aad-policy.test.ts",
  "lib/credentials/aad-policy.ts",
  "lib/credentials/authorize.test.ts",
  "lib/credentials/authorize.ts",
  "lib/credentials/client.test.ts",
  "lib/credentials/client.ts",
  "lib/credentials/device-flow-attempt.test.ts",
  "lib/credentials/device-flow-attempt.ts",
  "lib/credentials/device-flow-binding.test.ts",
  "lib/credentials/device-flow-binding.ts",
  "lib/credentials/device-flow-client.test.ts",
  "lib/credentials/device-flow-client.ts",
  "lib/credentials/device-poll-commit.test.ts",
  "lib/credentials/device-poll-commit.ts",
  "lib/credentials/device-poll.test.ts",
  "lib/credentials/device-poll.ts",
  "lib/credentials/envelope.test.ts",
  "lib/credentials/envelope.ts",
  "lib/credentials/github-device.test.ts",
  "lib/credentials/github-device.ts",
  "lib/credentials/kek.ts",
  "lib/credentials/key-ring.test.ts",
  "lib/credentials/key-ring.ts",
  "lib/credentials/leases.test.ts",
  "lib/credentials/leases.ts",
  "lib/credentials/runner-credential.test.ts",
  "lib/credentials/runner-credential.ts",
  "lib/credentials/scope.ts",
  "lib/credentials/shape.test.ts",
  "lib/credentials/shape.ts",
  "lib/credentials/store-core.ts",
  "lib/credentials/store.test.ts",
  "lib/credentials/store.ts",
  "lib/credentials/validate.test.ts",
  "lib/credentials/validate.ts",
] as const;
const agentIdSourceExpression = [
  "$",
  "{",
  "encodeURIComponent(agentId)",
  "}",
].join("");
const runIdSourceExpression = ["$", "{", "encodeURIComponent(runId)", "}"].join(
  ""
);
const browserTransportRoutes = [
  "/api/agents",
  `/api/agents/${agentIdSourceExpression}`,
  `/api/agents/${agentIdSourceExpression}/runs`,
  "/api/harnesses",
  "/api/health",
  `/api/runs/${runIdSourceExpression}`,
  `/api/runs/${runIdSourceExpression}/events`,
  `/api/runs/${runIdSourceExpression}/stop`,
  "/api/tenant/prewarm",
] as const;
const browserTransportHeaderNames = [
  "accept",
  "content-type",
  "idempotency-key",
  "last-event-id",
] as const;
const browserTransportImports = [
  "@/lib/application-path",
  "@opencoven/agent-contracts",
  "@opencoven/harness",
  "zod",
] as const;
const environmentKeys = [
  "ABUSE_CONTROL",
  "ABUSE_KEY_SECRET",
  "ADMIN_EMAILS",
  "AI_GATEWAY_API_KEY",
  "APP_ORIGIN",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_SECRET",
  "AUTH_URL",
  "BETA_ALLOWLIST",
  "BETA_MODE",
  "BLOB_READ_WRITE_TOKEN",
  "CREDENTIAL_AAD_WRITES_ENABLED",
  "CREDENTIAL_KEK",
  "CREDENTIAL_KEK_CURRENT_VERSION",
  "CREDENTIAL_KEK_V1",
  "CREDENTIAL_KEK_V2",
  "CRON_SECRET",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_AUTO_ARCHIVE_MINUTES",
  "DAYTONA_AUTO_STOP_MINUTES",
  "DAYTONA_DOMAIN_ALLOW_LIST",
  "DAYTONA_SANDBOX_CPU_CORES",
  "DAYTONA_SANDBOX_DISK_GIB",
  "DAYTONA_SANDBOX_MEMORY_GIB",
  "DAYTONA_SNAPSHOT",
  "DAYTONA_TARGET",
  "DEMO_RECORDER_ACCOUNT_EMAIL",
  "DEMO_RECORDING_CREDENTIAL",
  "DEMO_RECORDING_TIMEOUT_MS",
  "GLOBAL_DAILY_RUN_CAP",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_SLUG",
  "GITHUB_STATE_SIGNING_SECRET",
  "GITHUB_TEAMS_ENABLED",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "POSTGRES_URL",
  "REDIS_URL",
  "RELEASE_AUDIENCE",
  "RUN_ADMISSION_CONSECUTIVE_MAX",
  "RUN_ADMISSION_DEPLOYMENT_ACTIVE_MAX",
  "RUN_ADMISSION_MODE",
  "RUN_ADMISSION_TENANT_ACTIVE_MAX",
  "RUN_ADMISSION_TENANT_QUEUE_MAX",
  "RUNNER_MANUAL_RECONCILE_SECRET",
  "STRIPE_PRICE_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUBSCRIPTION_CHECKOUT_ENABLED",
] as const;
const productionDependencies = [
  "@ai-sdk/otel",
  "@ai-sdk/provider",
  "@ai-sdk/react",
  "@codemirror/lang-python",
  "@codemirror/state",
  "@codemirror/theme-one-dark",
  "@codemirror/view",
  "@create-markdown/core",
  "@create-markdown/preview",
  "@daytona/sdk",
  "@next/env",
  "@opencoven/agent-contracts",
  "@opencoven/harness",
  "@opentelemetry/api",
  "@opentelemetry/api-logs",
  "@radix-ui/react-use-controllable-state",
  "@streamdown/cjk",
  "@streamdown/code",
  "@streamdown/math",
  "@streamdown/mermaid",
  "@vercel/analytics",
  "@vercel/blob",
  "@vercel/functions",
  "@vercel/otel",
  "ai",
  "botid",
  "class-variance-authority",
  "classnames",
  "clsx",
  "cmdk",
  "codemirror",
  "date-fns",
  "diff-match-patch",
  "dotenv",
  "drizzle-orm",
  "fast-deep-equal",
  "framer-motion",
  "katex",
  "lucide-react",
  "motion",
  "nanoid",
  "next",
  "next-auth",
  "next-themes",
  "orderedmap",
  "papaparse",
  "postgres",
  "prosemirror-example-setup",
  "prosemirror-inputrules",
  "prosemirror-markdown",
  "prosemirror-model",
  "prosemirror-schema-basic",
  "prosemirror-schema-list",
  "prosemirror-state",
  "prosemirror-view",
  "radix-ui",
  "react",
  "react-data-grid",
  "react-dom",
  "redis",
  "resumable-stream",
  "sanitize-html",
  "server-only",
  "shiki",
  "sonner",
  "streamdown",
  "stripe",
  "swr",
  "tailwind-merge",
  "tailwindcss-animate",
  "use-stick-to-bottom",
  "usehooks-ts",
  "zod",
] as const;
const developmentDependencies = [
  "@biomejs/biome",
  "@github/copilot",
  "@playwright/test",
  "@tailwindcss/postcss",
  "@tailwindcss/typography",
  "@types/node",
  "@types/papaparse",
  "@types/react",
  "@types/react-dom",
  "@types/sanitize-html",
  "babel-plugin-react-compiler",
  "drizzle-kit",
  "husky",
  "lint-staged",
  "postcss",
  "tailwindcss",
  "tsx",
  "typescript",
  "typescript5",
  "ultracite",
] as const;
const scriptNames = [
  "account",
  "beads:seed",
  "beads:sync",
  "build",
  "check",
  "credentials:rewrap",
  "daytona:snapshot",
  "db:check",
  "db:generate",
  "db:migrate",
  "db:pull",
  "db:push",
  "db:studio",
  "db:up",
  "demo:record",
  "dev",
  "fix",
  "hygiene",
  "planning:check",
  "prepare",
  "readiness:check",
  "roadmap:status",
  "secret:scan",
  "secret:scan:all",
  "secret:scan:history",
  "staging:certify",
  "start",
  "subscription",
  "test",
  "test:e2e:hermetic",
  "test:unit",
  "typecheck",
  "validate:platform-residue",
  "validate:platform-residue:index",
  "validate:release",
  "validate:runtime",
] as const;

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  scripts?: Record<string, string>;
};

function readManifest(path: string): PackageManifest {
  return JSON.parse(
    readFileSync(new URL(path, repositoryRoot), "utf8")
  ) as PackageManifest;
}

function filesUnder(directory: string): string[] {
  const root = join(repositoryPath, directory);
  const files: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else {
        files.push(relative(repositoryPath, absolute));
      }
    }
  };
  visit(root);
  return files.sort();
}

function importedSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(
      /(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu
    ),
  ]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .sort();
}

test("the accepted ADR assigns every OpenCoven authority boundary", () => {
  const adr = readFileSync(adrUrl, "utf8");

  for (const heading of [
    "# ADR-001: Bound Coven Agents to product execution",
    "## Decision",
    "## Authority ownership",
    "## Integration rules",
    "## Consequences",
    "## Enforcement and review",
  ]) {
    assert.match(adr, new RegExp(heading));
  }

  for (const owner of [
    "OpenCoven/familiar-contract",
    "OpenCoven/coven",
    "OpenCoven/coven-threads",
    "OpenCoven/psyche",
    "OpenCoven/coven-runtimes",
    "packages/agent-contracts",
  ]) {
    assert.match(adr, new RegExp(owner.replaceAll("/", "\\/")));
  }
});

test("the README points contributors to the product authority boundary", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(
    readme,
    /\[Product authority boundary\]\(docs\/architecture\/adr-001-product-authority-boundary\.md\)/
  );
});

test("the accepted Daytona ADR records the current execution boundary", () => {
  const adr = readFileSync(daytonaAdrUrl, "utf8");

  for (const heading of [
    "# ADR-002: Daytona execution boundary",
    "## Decision",
    "## Provider adapter and rollback criteria",
    "## Backend discriminator migration",
    "## Consequences",
    "## Enforcement",
  ]) {
    assert.match(adr, new RegExp(heading));
  }

  for (const boundary of [
    "Daytona is the sole execution provider",
    "Browser APIs are relative and same-origin",
    "Authority is server-derived",
    "Credentials and dispatch stay server-only",
    "PostgreSQL owns execution truth",
    "Starts are idempotent",
    "SSE is cursor-safe",
    "Recovery is bounded",
  ]) {
    assert.match(adr, new RegExp(boundary));
  }
});

test("credential materialization remains attempt-scoped inside persistent Daytona sandboxes", () => {
  const adr = readFileSync(daytonaAdrUrl, "utf8");
  const threatModel = readFileSync(
    new URL("docs/security/execution-threat-model.md", repositoryRoot),
    "utf8"
  );
  const attestation = readFileSync(cutoverAttestationUrl, "utf8");

  for (const policy of [
    /one tenant-scoped persistent Daytona sandbox/i,
    /Daytona Secrets are not used/i,
    /exactly one\s+environment entry/i,
    /deterministic\s+`\(run, attempt\)` credential path/i,
    /Replacement, deletion, and entitlement races/i,
    /Cleanup ambiguity/i,
  ]) {
    assert.match(adr, policy);
  }
  assert.doesNotMatch(
    adr,
    /credential plaintext never crosses the server boundary/i
  );
  assert.match(
    threatModel,
    /server-to-authorized-sandbox attempt staging transport/
  );
  assert.match(threatModel, /session `404` or\s+`410`/);
  assert.match(adr, /complete process tree/i);
  assert.match(attestation, /repository policy ratification/i);
  assert.match(
    attestation,
    /Earlier wording that environment injection requires an ephemeral per-run\s+sandbox is superseded/
  );
  assert.match(attestation, /deliberately detached descendant/i);
});

test("the cutover attestation separates repository and production evidence", () => {
  const attestation = readFileSync(cutoverAttestationUrl, "utf8");

  for (const heading of [
    "# Daytona Cutover Attestation and Runbook",
    "## Verified repository evidence",
    "## Production cutover and retirement evidence",
    "## Production evidence and remaining release exercises",
    "## Resource inventory and revocation",
    "## Rollback",
    "## Observation window",
    "## Approval record",
  ]) {
    assert.match(attestation, new RegExp(heading));
  }

  assert.match(attestation, /superseded resource deletion\s+are complete/is);
  assert.match(
    attestation,
    /full subscriber lifecycle exercise remains\s+approval-gated/is
  );
  assert.match(attestation, /PR #128/);
  assert.match(attestation, /PR #133/);
  assert.match(attestation, /PR #134/);
  assert.match(attestation, /1bec409b399651d8a115e4518a0f444e9753a728/);
  assert.match(attestation, /a8bb0a82efb6ffb7f754d03519f0d381e72fb88e/);
  assert.match(attestation, /1,377 tests with zero failures/);
  assert.match(attestation, /28 of 28 cases/);
  assert.match(attestation, /application and end-to-end test trees/);
  assert.match(attestation, /pnpm validate:platform-residue/);
  assert.match(attestation, /pnpm validate:platform-residue:index/);
  assert.match(attestation, /worktree.*untracked/is);
  assert.match(attestation, /index.*would-be committed/is);
  assert.match(attestation, /scanner source.*rule inventory/is);
  assert.match(attestation, /generated optional-peer metadata/is);
});

test("the living subscription policy records current billing authorities", () => {
  const policy = readFileSync(subscriptionPolicyUrl, "utf8");

  for (const heading of [
    "# Subscription and Billing Policy",
    "## Product policy",
    "## Entitlement authority and timing",
    "## Checkout responsibilities",
    "## Webhook responsibilities",
    "## Automatic bounded Stripe reconciliation",
    "## Usage cap and run accounting",
    "## Failure and recovery",
    "## Verification",
  ]) {
    assert.match(policy, new RegExp(heading));
  }

  for (const decision of [
    "MONTHLY_MINUTE_CAP = 300",
    "GRACE_PERIOD_DAYS = 3",
    "subscription_cycle",
    "At most one active subscription",
    "lib/billing/limits.ts",
    "lib/billing/checkout.ts",
    "lib/billing/webhook.ts",
    "app/api/checkout/route.ts",
    "app/api/stripe/webhook/route.ts",
    "GET /api/internal/stripe-reconcile",
    "lib/credentials/runner-credential.ts",
    "StripeReconciliation",
    "SubscriptionOverrideAudit",
    "MAX_SUBSCRIPTION_OVERRIDE_DAYS = 3650",
    "--reference-stdin",
    "authorized operator override",
    "pending",
    "acknowledged",
    "resolved",
  ]) {
    assert.equal(policy.includes(decision), true, decision);
  }

  assert.match(policy, /not.*production certification/is);
  assert.match(policy, /not Stripe evidence/is);
  assert.match(policy, /positive-repair sweep/is);
  assert.match(policy, /StripeReconciliationRun/);
  assert.match(policy, /database time/is);
  assert.match(policy, /exact snapshot/is);
  assert.match(policy, /never lists Customers globally/is);
  assert.match(policy, /no (user|Customer|Subscription).*stored/is);
  assert.match(policy, /retention.*operator/is);
});

test("the subscriber offer renders the authoritative run cap without duplicating it", () => {
  const source = readFileSync(
    new URL("components/billing/subscription-card.tsx", repositoryRoot),
    "utf8"
  );

  assert.match(
    source,
    /import \{ MONTHLY_MINUTE_CAP \} from "@\/lib\/billing\/limits";/
  );
  assert.equal(source.includes(String(MONTHLY_MINUTE_CAP)), false);
});

test("the README links the living subscription policy", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(
    readme,
    /\[Subscription and billing policy\]\(docs\/product\/subscription-billing-policy\.md\)/
  );
});

test("active roadmap links point to the durable Daytona records", () => {
  const roadmap = readFileSync(roadmapUrl, "utf8");

  for (const path of [
    "docs/architecture/adr-002-daytona-execution-boundary.md",
    "docs/operations/daytona-cutover-attestation.md",
    "docs/roadmap/daytona-cutover-audit-2026-08-29.md",
  ]) {
    assert.match(roadmap, new RegExp(path.replaceAll("/", "\\/")));
  }
});

test("mixed-content historical removals require a sanitized per-document tombstone", () => {
  const governance = readFileSync(deliveryGovernanceUrl, "utf8");

  for (const requirement of [
    "mixed-content historical document",
    "maps every deleted document to specific current documents",
    "preserve every decision that remains applicable",
    "Git history preserves each original",
    "every active link is updated",
    "private or sensitive detail",
  ]) {
    assert.equal(governance.includes(requirement), true, requirement);
  }
});

test("the historical tombstone maps every removed document to specific current guidance", () => {
  const tombstone = readFileSync(historicalTombstoneUrl, "utf8");
  const mappings = new Map<string, readonly string[]>([
    [
      "docs/superpowers/plans/2026-08-22-git-lifecycle-automation.md",
      ["../roadmap/delivery-governance.md", "../roadmap/release-readiness.md"],
    ],
    [
      "docs/superpowers/plans/2026-08-23-beads-project-board.md",
      ["../beads-project-sync.md", "../roadmap/delivery-governance.md"],
    ],
    [
      "docs/superpowers/plans/2026-08-24-demo-replay.md",
      [
        "../../README.md",
        "../roadmap/current-state.md",
        "../security/guest-access.md",
      ],
    ],
    [
      "docs/superpowers/plans/2026-08-24-subscriptions.md",
      [
        "../../README.md",
        "../product/subscription-billing-policy.md",
        "../security/guest-access.md",
        "../roadmap/release-readiness.md",
      ],
    ],
    [
      "docs/superpowers/plans/2026-08-24-tenant-identity-and-credential-isolation.md",
      [
        "../architecture/adr-001-product-authority-boundary.md",
        "../security/execution-threat-model.md",
        "../security/key-rotation.md",
        "../security/incident-response.md",
      ],
    ],
    [
      "docs/superpowers/plans/2026-08-25-abuse-resilience-and-blast-radius-hardening.md",
      [
        "../security/execution-threat-model.md",
        "../security/incident-response.md",
        "../roadmap/implementation-sequence.md",
        "../roadmap/release-readiness.md",
      ],
    ],
    [
      "docs/superpowers/plans/2026-08-25-repository-roadmap.md",
      [
        "../../ROADMAP.md",
        "../roadmap/implementation-sequence.md",
        "../roadmap/delivery-governance.md",
        "../roadmap/verification-matrix.md",
        "../roadmap/release-readiness.md",
      ],
    ],
    [
      "docs/superpowers/specs/2026-08-20-coven-agents-design.md",
      [
        "../architecture/adr-001-product-authority-boundary.md",
        "../architecture/adr-002-daytona-execution-boundary.md",
        "../roadmap/current-state.md",
      ],
    ],
    [
      "docs/superpowers/specs/2026-08-22-git-lifecycle-automation-design.md",
      ["../roadmap/delivery-governance.md", "../roadmap/release-readiness.md"],
    ],
    [
      "docs/superpowers/specs/2026-08-23-beads-project-board-design.md",
      ["../beads-project-sync.md", "../roadmap/delivery-governance.md"],
    ],
    [
      "docs/superpowers/specs/2026-08-24-demo-replay-design.md",
      [
        "../../README.md",
        "../roadmap/current-state.md",
        "../security/guest-access.md",
      ],
    ],
    [
      "docs/superpowers/specs/2026-08-24-subscriptions-design.md",
      [
        "../../README.md",
        "../product/subscription-billing-policy.md",
        "../security/guest-access.md",
        "../roadmap/release-readiness.md",
      ],
    ],
    [
      "docs/superpowers/specs/2026-08-24-tenant-identity-and-credential-isolation-design.md",
      [
        "../architecture/adr-001-product-authority-boundary.md",
        "../security/execution-threat-model.md",
        "../security/key-rotation.md",
        "../security/incident-response.md",
      ],
    ],
    [
      "docs/superpowers/specs/2026-08-25-repository-roadmap-design.md",
      [
        "../../ROADMAP.md",
        "../roadmap/implementation-sequence.md",
        "../roadmap/delivery-governance.md",
        "../roadmap/verification-matrix.md",
        "../roadmap/release-readiness.md",
      ],
    ],
  ]);

  assert.match(
    tombstone,
    /\| Removed path \| Subject \| Superseding current documents \| Preserved lessons \|/
  );
  for (const [path, documents] of mappings) {
    const row = tombstone
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes(`\`${path}\``));
    assert.ok(row, `${path} must have its own tombstone row`);
    for (const document of documents) {
      assert.equal(
        row.includes(`](${document})`),
        true,
        `${path}: ${document}`
      );
    }
  }

  for (const path of [
    "docs/superpowers/plans/2026-08-24-demo-replay.md",
    "docs/superpowers/specs/2026-08-24-demo-replay-design.md",
  ]) {
    const row = tombstone
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes(`\`${path}\``));
    assert.ok(row, `${path} must have its own tombstone row`);
    assert.match(row, /IS_DEMO/);
    assert.match(row, /OpenCoven\/demo-workspace/);
  }

  for (const path of [
    "docs/superpowers/plans/2026-08-24-subscriptions.md",
    "docs/superpowers/specs/2026-08-24-subscriptions-design.md",
  ]) {
    const row = tombstone
      .split("\n")
      .find((line) => line.startsWith("|") && line.includes(`\`${path}\``));
    assert.ok(row, `${path} must have its own tombstone row`);
    assert.match(row, /750/);
    assert.match(row, /three-day renewal-only grace/);
    assert.match(row, /one active subscription/);
    assert.match(row, /signature-verified/);
    assert.match(row, /idempotent/);
  }
});

test("the prior UI audit retains its evidence and explicit correction", () => {
  const audit = readFileSync(historicalUiAuditUrl, "utf8");

  assert.match(audit, /Correction note - 2026-08-29/);
  assert.match(audit, /17 of 17 local browser contract cases passed/);
  assert.match(audit, /390 x 844/);
  assert.match(audit, /collapse\/expand control worked/);
  assert.match(audit, /10 sanitized events/);
  assert.match(audit, /captured on 2026-08-27/);
  assert.match(audit, /a8c197639c599c67132e73b376859dc4d6d48124/);
  assert.match(
    audit,
    /repository-local and was never production certification/
  );
  assert.match(audit, /disposition remained\s+\*\*no-go\*\*/);
  assert.match(audit, /\[Daytona cutover audit\]/);
  assert.match(audit, /\[release-readiness runbook\]/);
});

test("release readiness requires exact signed deployment attestations", () => {
  const readiness = readFileSync(releaseReadinessUrl, "utf8");

  assert.match(readiness, /test manifest version 1/);
  assert.match(readiness, /ephemeral evidence cannot satisfy/);
  assert.match(readiness, /Ed25519 signature/);
  assert.match(readiness, /complete release-decision digest/);
  assert.match(readiness, /trusted reviewer-key file/);
  assert.match(readiness, /independently supplied deployment environment/);
  assert.match(readiness, /rollback\s+certification and schema-compatibility/);
  assert.match(readiness, /rejects a rollback target equal to the\s+candidate/);
  assert.match(readiness, /older than seven days/);
});

test("repo-local OpenCoven packages stay private workspace dependencies", () => {
  const observed = new Set<string>();

  for (const path of manifestPaths) {
    const manifest = readManifest(path);
    for (const dependencies of [
      manifest.dependencies,
      manifest.devDependencies,
      manifest.optionalDependencies,
      manifest.peerDependencies,
    ]) {
      for (const [name, version] of Object.entries(dependencies ?? {})) {
        if (!name.startsWith("@opencoven/")) {
          continue;
        }

        assert.equal(
          allowedWorkspacePackages.has(name),
          true,
          `${path} introduces ${name}; update ADR-001 before adding an OpenCoven authority dependency`
        );
        assert.equal(
          version,
          "workspace:*",
          `${path} must consume ${name} from this workspace`
        );
        observed.add(name);
      }
    }
  }

  assert.deepEqual(observed, allowedWorkspacePackages);
  assert.equal(
    readFileSync(new URL("pnpm-workspace.yaml", repositoryRoot), "utf8"),
    "packages:\n  - packages/*\n\nautoInstallPeers: false\n"
  );
  assert.deepEqual(
    filesUnder("packages")
      .filter((path) => path.endsWith("/package.json"))
      .sort(),
    ["packages/agent-contracts/package.json", "packages/harness/package.json"]
  );

  for (const path of [
    "packages/agent-contracts/package.json",
    "packages/harness/package.json",
  ]) {
    assert.equal(readManifest(path).private, true);
  }
});

test("application routes and product adapters match the current inventory", () => {
  assert.deepEqual(
    filesUnder("app").filter((path) => path.endsWith("/route.ts")),
    [...applicationRouteFiles]
  );
  assert.deepEqual(filesUnder("lib/agents"), [...agentBoundaryFiles]);
  assert.deepEqual(filesUnder("packages/agent-contracts/src"), [
    ...contractSourceFiles,
  ]);
  assert.deepEqual(filesUnder("lib/credentials"), [...credentialSourceFiles]);
});

test("browser execution uses only current same-origin routes and headers", () => {
  const source = readFileSync(
    new URL("lib/agents/browser-transport.ts", repositoryRoot),
    "utf8"
  );
  const routes = [
    ...new Set(
      [...source.matchAll(/["`]((?:\/api\/)[^"`]+)["`]/gu)].map(
        (match) => match[1] ?? ""
      )
    ),
  ].sort();
  const headerBlock =
    source.match(/headers:\s*\{([\s\S]*?)\n\s*\},\n\s*method:/u)?.[1] ?? "";
  const headerNames = [
    ...headerBlock.matchAll(/["']?([a-z][a-z-]*)["']?\s*:/gu),
  ]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .sort();

  assert.deepEqual(routes, [...browserTransportRoutes]);
  assert.deepEqual(headerNames, [...browserTransportHeaderNames]);
  assert.deepEqual(importedSpecifiers(source), [...browserTransportImports]);
});

test("the cookieless GitHub tool route is an exact pre-session proxy exemption", () => {
  const betaSource = readFileSync(
    new URL("lib/beta.ts", repositoryRoot),
    "utf8"
  );
  const proxySource = readFileSync(new URL("proxy.ts", repositoryRoot), "utf8");
  const exemption = "isCookielessGitHubToolRoute(pathname, base)";
  const exemptionIndex = proxySource.indexOf(exemption);
  const sessionIndex = proxySource.indexOf("await getToken(");

  assert.match(betaSource, /"\/api\/internal\/github-tool"/u);
  assert.doesNotMatch(
    betaSource,
    /startsWith\([^)]*\/api\/internal\/github-tool/u
  );
  assert.ok(exemptionIndex >= 0);
  assert.ok(sessionIndex > exemptionIndex);
});

test("the cookieless GitHub tool remains bearer-only behind exact IP admission", () => {
  const routeSource = readFileSync(
    new URL("app/api/internal/github-tool/route.ts", repositoryRoot),
    "utf8"
  );
  const dependencySource = readFileSync(
    new URL("lib/github/tool-route-dependencies.ts", repositoryRoot),
    "utf8"
  );
  const httpSource = readFileSync(
    new URL("lib/github/http.ts", repositoryRoot),
    "utf8"
  );

  assert.match(routeSource, /ipAddress\(request\)/u);
  assert.match(httpSource, /route: "github_tool"/u);
  assert.match(httpSource, /\^Bearer /u);
  assert.doesNotMatch(
    `${routeSource}\n${dependencySource}\n${httpSource}`,
    /authorizeSubscriber|@\/app\/\(auth\)|cookie.*author/iu
  );
});

test("package dependencies and scripts match the current application contract", () => {
  const manifest = readManifest("package.json");

  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
    ...productionDependencies,
  ]);
  assert.deepEqual(Object.keys(manifest.devDependencies ?? {}).sort(), [
    ...developmentDependencies,
  ]);
  assert.deepEqual(Object.keys(manifest.scripts ?? {}).sort(), [
    ...scriptNames,
  ]);
});

test("the required local check gate includes retired-platform residue validation", () => {
  const manifest = readManifest("package.json");

  assert.equal(
    manifest.scripts?.check,
    "pnpm validate:platform-residue && ultracite check && pnpm planning:check"
  );
});

test("the development server uses the documented localhost origin", () => {
  const manifest = readManifest("package.json");
  const readme = readFileSync(readmeUrl, "utf8");

  assert.equal(
    manifest.scripts?.dev,
    "next dev --turbo --hostname localhost --port 3036"
  );
  assert.match(readme, /Open <http:\/\/localhost:3036\/agents>\./u);
});

test("documented environment settings match the current application contract", () => {
  const envExample = readFileSync(
    new URL(".env.example", repositoryRoot),
    "utf8"
  );
  const observed = [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean)
    .sort();

  assert.deepEqual(observed, [...environmentKeys].sort());
});

test("the README describes persistent per-agent Daytona isolation accurately", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(readme, /one tenant-scoped persistent Daytona sandbox/i);
  assert.match(readme, /Runs reuse that sandbox/i);
  assert.match(readme, /short-lived process session/i);
  assert.match(readme, /mode-`0600` credential file/i);
  assert.match(
    readme,
    /deleting a run record does not delete[\s\S]*sandbox or its workspace/i
  );
  assert.doesNotMatch(readme, /per-run Daytona sandbox/i);
});

test("the README preserves both demo replay deployment gates", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(readme, /IS_DEMO.*explicitly.*1/is);
  assert.match(readme, /OpenCoven\/demo-workspace/);
});

test("connection status exposes the current application state contract", () => {
  const source = readFileSync(
    new URL("lib/agents/connection-status.ts", repositoryRoot),
    "utf8"
  );

  for (const state of [
    "connected",
    "connecting",
    "rate_limited",
    "signed_out",
    "subscription_required",
    "unavailable",
  ]) {
    assert.match(source, new RegExp(`(?:[|:]\\s*)?["']${state}["']`));
  }
});

test("server-only credential custody remains part of the runner boundary", () => {
  for (const path of [
    "lib/credentials/key-ring.ts",
    "lib/credentials/leases.ts",
    "lib/credentials/runner-credential.ts",
    "lib/credentials/store.ts",
  ]) {
    assert.equal(existsSync(new URL(path, repositoryRoot)), true);
  }

  const runnerCredential = readFileSync(
    new URL("lib/credentials/runner-credential.ts", repositoryRoot),
    "utf8"
  );
  const runnerAuth = readFileSync(
    new URL("lib/runner/auth.ts", repositoryRoot),
    "utf8"
  );
  assert.match(runnerCredential, /^import "server-only";/m);
  assert.match(runnerAuth, /^import "server-only";/m);
});

test("subscription checkout secrets remain behind a server-only boundary", () => {
  const billingConfig = readFileSync(
    new URL("lib/billing/config.ts", repositoryRoot),
    "utf8"
  );
  const billingConfigCore = readFileSync(
    new URL("lib/billing/config-core.ts", repositoryRoot),
    "utf8"
  );
  const runtimeValidation = readFileSync(
    new URL("scripts/runtime-config-validation.ts", repositoryRoot),
    "utf8"
  );
  const subscriptionRoute = readFileSync(
    new URL("app/api/subscription/route.ts", repositoryRoot),
    "utf8"
  );

  assert.match(billingConfig, /^import "server-only";/m);
  assert.doesNotMatch(billingConfigCore, /server-only/);
  assert.doesNotMatch(billingConfigCore, /\b(?:apiKey|webhookSecret)\b/);
  assert.match(runtimeValidation, /billing\/config-core/);
  assert.doesNotMatch(runtimeValidation, /billing\/config["']/);
  assert.match(subscriptionRoute, /from "@\/lib\/billing\/config"/);
  assert.match(
    subscriptionRoute,
    /subscriptionCheckoutEnabled\(\s*process\.env/
  );
  assert.doesNotMatch(subscriptionRoute, /billing\/config-core/);
});

test("agent contracts expose the current tenant identity primitives", () => {
  const identity = readFileSync(
    new URL("packages/agent-contracts/src/identity.ts", repositoryRoot),
    "utf8"
  );
  const credentialStore = readFileSync(
    new URL("lib/credentials/store.ts", repositoryRoot),
    "utf8"
  );
  const credentialStoreCore = readFileSync(
    new URL("lib/credentials/store-core.ts", repositoryRoot),
    "utf8"
  );

  for (const contract of [
    "base64UrlEncode",
    "base64UrlDecode",
    "TENANT_ID_PATTERN",
  ]) {
    assert.match(identity, new RegExp(contract));
  }
  for (const source of [credentialStore, credentialStoreCore]) {
    assert.match(source, /readCredentialForTenantWithoutRefresh/u);
  }
});
