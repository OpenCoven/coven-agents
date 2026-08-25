import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const adrUrl = new URL(
  "docs/architecture/adr-001-product-authority-boundary.md",
  repositoryRoot
);
const readmeUrl = new URL("README.md", repositoryRoot);
const manifestPaths = [
  "package.json",
  "local-runner/package.json",
  "packages/agent-contracts/package.json",
  "packages/harness/package.json",
  "worker/package.json",
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
