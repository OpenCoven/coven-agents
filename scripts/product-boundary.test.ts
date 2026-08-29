import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const adrUrl = new URL(
  "docs/architecture/adr-001-product-authority-boundary.md",
  repositoryRoot
);
const readmeUrl = new URL("README.md", repositoryRoot);
const manifestPaths = [
  "package.json",
  "packages/agent-contracts/package.json",
  "packages/harness/package.json",
] as const;
const allowedWorkspacePackages = new Set([
  "@opencoven/agent-contracts",
  "@opencoven/harness",
]);

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name?: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
};

function readManifest(path: string): PackageManifest {
  return JSON.parse(
    readFileSync(new URL(path, repositoryRoot), "utf8")
  ) as PackageManifest;
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

  for (const path of [
    "packages/agent-contracts/package.json",
    "packages/harness/package.json",
  ]) {
    assert.equal(
      readManifest(path).private,
      true,
      `${path} is a product-internal adapter, not a canonical ecosystem package`
    );
  }
});

test("the same-origin app has no Cloudflare runtime or cross-service runner boundary", () => {
  for (const path of [
    "app/api/runner-connection/route.ts",
    "app/api/runner-token/route.ts",
    "app/api/internal/credential",
    "app/api/internal/runner-authority",
    "lib/agents/connection-access.ts",
    "lib/agents/identity.ts",
    "lib/agents/key-ring.ts",
    "lib/agents/provision.ts",
    "lib/agents/runner-token.ts",
    "lib/auth/internal-service.ts",
    "lib/auth/runner-authority.ts",
    "lib/credentials/lending.ts",
    "worker",
  ]) {
    assert.equal(
      existsSync(new URL(path, repositoryRoot)),
      false,
      `${path} must remain deleted`
    );
  }

  const envExample = readFileSync(
    new URL(".env.example", repositoryRoot),
    "utf8"
  );
  assert.doesNotMatch(envExample, /^NEXT_PUBLIC_CLOUD_RUNNER_URL=/m);
  assert.doesNotMatch(envExample, /^AGENT_CONTROL_TOKEN=/m);
  assert.doesNotMatch(envExample, /^CREDENTIAL_LEGACY_LENDING_ENABLED=/m);
  assert.doesNotMatch(envExample, /^RUNNER_SERVICE_TOKEN=/m);
  assert.doesNotMatch(envExample, /^RUNNER_SIGNING_KEY=/m);
  assert.doesNotMatch(envExample, /^RUNNER_VERIFY_/m);
  assert.doesNotMatch(envExample, /^RUN_SCOPED_IDENTITY_WRITES_ENABLED=/m);
  assert.doesNotMatch(envExample, /browser bundle drain/i);

  for (const path of [
    "components/console/run-console.tsx",
    "lib/agents/browser-transport.ts",
    "lib/agents/client.ts",
  ]) {
    const source = readFileSync(new URL(path, repositoryRoot), "utf8");
    assert.doesNotMatch(source, /\/api\/runner-(?:connection|token)/);
    assert.doesNotMatch(source, /x-runner-token|authorization:\s*Bearer/i);
    assert.doesNotMatch(
      source,
      /https?:\/\/|localStorage|sessionStorage|NEXT_PUBLIC_CLOUD_RUNNER_URL|7331/
    );
  }

  const authSource = readFileSync(
    new URL("app/(auth)/auth.ts", repositoryRoot),
    "utf8"
  );
  assert.doesNotMatch(authSource, /prewarmTenantSandbox|from "next\/server"/);
  assert.equal(
    existsSync(new URL("lib/agents/prewarm.server.ts", repositoryRoot)),
    false
  );
  assert.equal(
    existsSync(new URL("lib/agents/prewarm.server.test.ts", repositoryRoot)),
    false
  );

  const manifest = readManifest("package.json");
  assert.equal(manifest.dependencies?.["@cloudflare/sandbox"], undefined);
  assert.equal(manifest.dependencies?.agents, undefined);
  assert.equal(manifest.devDependencies?.wrangler, undefined);

  const { scripts } = JSON.parse(
    readFileSync(new URL("package.json", repositoryRoot), "utf8")
  ) as { scripts?: Record<string, string> };
  assert.equal(scripts?.["dev:cloud"], undefined);
  assert.doesNotMatch(scripts?.["test:unit"] ?? "", /cloud-runner|worker/u);

  const workspace = readFileSync(
    new URL("pnpm-workspace.yaml", repositoryRoot),
    "utf8"
  );
  assert.doesNotMatch(workspace, /^\s*-\s*worker\s*$/m);
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

test("connection status contains only provider-neutral application states", () => {
  const source = readFileSync(
    new URL("lib/agents/connection-status.ts", repositoryRoot),
    "utf8"
  );

  assert.doesNotMatch(source, /readConnectionResponse|provisioned/);
  assert.doesNotMatch(source, /\btoken:\s*string/);
});

test("server-only credential custody remains after Worker removal", () => {
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
  for (const source of [runnerCredential, runnerAuth]) {
    assert.doesNotMatch(
      source,
      /AGENT_CONTROL_TOKEN|RUNNER_SERVICE_TOKEN|RUNNER_VERIFY_|worker\//u
    );
  }
});

test("retired runner identity and credential-read compatibility surfaces are absent", () => {
  assert.equal(
    existsSync(
      new URL("packages/agent-contracts/src/verify-token.ts", repositoryRoot)
    ),
    false
  );

  const contracts = readFileSync(
    new URL("packages/agent-contracts/src/index.ts", repositoryRoot),
    "utf8"
  );
  const identity = readFileSync(
    new URL("packages/agent-contracts/src/identity.ts", repositoryRoot),
    "utf8"
  );
  const entitlements = readFileSync(
    new URL("lib/ai/entitlements.ts", repositoryRoot),
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

  for (const source of [contracts, identity]) {
    assert.doesNotMatch(
      source,
      /RunnerClaims|RunnerRunScope|runnerClaimsSchema|runnerRunScopeSchema|verifyRunnerToken|TOKEN_(?:ALGORITHM|CLOCK_SKEW_SECONDS|LIFETIME_SECONDS)|MAX_RUNNER_(?:PAYLOAD|TOKEN)|KEY_ID_PATTERN|splitToken/u
    );
  }
  assert.match(identity, /base64UrlEncode/);
  assert.match(identity, /base64UrlDecode/);
  assert.match(identity, /TENANT_ID_PATTERN/);
  assert.doesNotMatch(entitlements, /RunnerClaims/);
  for (const source of [credentialStore, credentialStoreCore]) {
    assert.doesNotMatch(source, /readCredentialForTenant\s*\(/u);
    assert.match(source, /readCredentialForTenantWithoutRefresh/u);
  }
});
