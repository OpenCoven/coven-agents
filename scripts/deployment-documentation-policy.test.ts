import assert from "node:assert/strict";
import test from "node:test";
import {
  findDeploymentDocumentationViolations,
  VERCEL_DEPLOYMENT_CONFIG_PATHS,
  VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
  VERCEL_DEPLOYMENT_REQUIRED_HEADINGS,
} from "./deployment-documentation-policy";

const deploymentConfigEntries = VERCEL_DEPLOYMENT_CONFIG_PATHS.map((path) => ({
  content: "{}\n",
  path,
}));

test("passes when Vercel deployment configuration is absent", () => {
  assert.deepEqual(
    findDeploymentDocumentationViolations([
      { content: "Current Daytona execution.\n", path: "README.md" },
    ]),
    []
  );
});

test("rejects Vercel deployment configuration without its runbook", () => {
  assert.deepEqual(
    findDeploymentDocumentationViolations(deploymentConfigEntries),
    [
      {
        configPaths: [...VERCEL_DEPLOYMENT_CONFIG_PATHS],
        documentationPath: VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
        missingHeadings: [...VERCEL_DEPLOYMENT_REQUIRED_HEADINGS],
        reason: "missing-documentation",
      },
    ]
  );
});

test("rejects an incomplete Vercel deployment runbook", () => {
  assert.deepEqual(
    findDeploymentDocumentationViolations([
      ...deploymentConfigEntries,
      {
        content: "# Vercel deployment\n\n## Ownership\n",
        path: VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
      },
    ]),
    [
      {
        configPaths: [...VERCEL_DEPLOYMENT_CONFIG_PATHS],
        documentationPath: VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
        missingHeadings: VERCEL_DEPLOYMENT_REQUIRED_HEADINGS.slice(2),
        reason: "incomplete-documentation",
      },
    ]
  );
});

test("allows Vercel deployment configuration with a complete runbook", () => {
  const documentation = `${VERCEL_DEPLOYMENT_REQUIRED_HEADINGS.join(
    "\n\n"
  )}\n`;

  assert.deepEqual(
    findDeploymentDocumentationViolations([
      ...deploymentConfigEntries,
      {
        content: documentation,
        path: VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
      },
    ]),
    []
  );
});
