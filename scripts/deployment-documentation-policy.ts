#!/usr/bin/env tsx
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const VERCEL_DEPLOYMENT_DOCUMENTATION_PATH =
  "docs/runbooks/vercel-deployment.md";

export const VERCEL_DEPLOYMENT_CONFIG_PATHS = [
  "vercel.json",
  "vercel-template.json",
] as const;

export const VERCEL_DEPLOYMENT_REQUIRED_HEADINGS = [
  "# Vercel deployment",
  "## Ownership",
  "## External side effects",
  "## Environment and secrets",
  "## Scheduled jobs",
  "## Verification",
  "## Rollback",
] as const;

export type RepositoryTextEntry = {
  content: string;
  path: string;
};

export type DeploymentDocumentationViolation = {
  configPaths: string[];
  documentationPath: string;
  missingHeadings: string[];
  reason: "incomplete-documentation" | "missing-documentation";
};

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizedHeadingLines(content: string): Set<string> {
  return new Set(
    content
      .split(/\r?\n/u)
      .map((line) => line.trim().toLocaleLowerCase("en-US"))
  );
}

export function findDeploymentDocumentationViolations(
  entries: readonly RepositoryTextEntry[]
): DeploymentDocumentationViolation[] {
  const entriesByPath = new Map(
    entries.map((entry) => [normalizePath(entry.path), entry.content])
  );
  const configPaths = VERCEL_DEPLOYMENT_CONFIG_PATHS.filter((path) =>
    entriesByPath.has(path)
  );

  if (configPaths.length === 0) {
    return [];
  }

  const documentation = entriesByPath.get(
    VERCEL_DEPLOYMENT_DOCUMENTATION_PATH
  );
  if (documentation === undefined) {
    return [
      {
        configPaths: [...configPaths],
        documentationPath: VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
        missingHeadings: [...VERCEL_DEPLOYMENT_REQUIRED_HEADINGS],
        reason: "missing-documentation",
      },
    ];
  }

  const headings = normalizedHeadingLines(documentation);
  const missingHeadings = VERCEL_DEPLOYMENT_REQUIRED_HEADINGS.filter(
    (heading) => !headings.has(heading.toLocaleLowerCase("en-US"))
  );
  if (missingHeadings.length === 0) {
    return [];
  }

  return [
    {
      configPaths: [...configPaths],
      documentationPath: VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
      missingHeadings: [...missingHeadings],
      reason: "incomplete-documentation",
    },
  ];
}

function repositoryEntries(cwd: string): RepositoryTextEntry[] {
  return [
    ...VERCEL_DEPLOYMENT_CONFIG_PATHS,
    VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
  ]
    .filter((path) => existsSync(resolve(cwd, path)))
    .map((path) => ({
      content: readFileSync(resolve(cwd, path), "utf8"),
      path,
    }));
}

export function scanDeploymentDocumentationPolicy(
  cwd = process.cwd()
): DeploymentDocumentationViolation[] {
  return findDeploymentDocumentationViolations(repositoryEntries(cwd));
}

export function renderDeploymentDocumentationViolations(
  violations: readonly DeploymentDocumentationViolation[]
): string {
  return violations
    .map((violation) => {
      const configs = violation.configPaths.join(", ");
      if (violation.reason === "missing-documentation") {
        return `Undocumented Vercel deployment configuration (${configs}). Add ${violation.documentationPath} before restoring these files.`;
      }

      return `${violation.documentationPath} is incomplete for ${configs}. Missing headings: ${violation.missingHeadings.join(", ")}.`;
    })
    .join("\n");
}

function main(): number {
  const violations = scanDeploymentDocumentationPolicy();
  if (violations.length > 0) {
    process.stderr.write(
      `${renderDeploymentDocumentationViolations(violations)}\n`
    );
    return 1;
  }

  process.stdout.write(
    `Deployment documentation policy passed: Vercel deployment configuration is absent or backed by ${VERCEL_DEPLOYMENT_DOCUMENTATION_PATH}.\n`
  );
  return 0;
}

const [, entrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = main();
}
