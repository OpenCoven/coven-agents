import assert from "node:assert/strict";
import test from "node:test";
import {
  findDeploymentDocumentationViolations,
  isVercelDeploymentDisableConfig,
  VERCEL_DEPLOYMENT_CONFIG_PATHS,
  VERCEL_DEPLOYMENT_DISABLE_CONFIG,
  VERCEL_DEPLOYMENT_DOCUMENTATION_PATH,
  VERCEL_DEPLOYMENT_REQUIRED_HEADINGS,
} from "./deployment-documentation-policy";

const deploymentConfigEntries = [
  {
    content: '{"crons": [{"path": "/api/internal/runner-reconcile"}]}\n',
    path: "vercel.json",
  },
  {
    content: '{"products": [{"type": "blob"}]}\n',
    path: "vercel-template.json",
  },
] as const;

const disabledDeploymentConfig = `${JSON.stringify(
  VERCEL_DEPLOYMENT_DISABLE_CONFIG
)}\n`;

test("passes when Vercel deployment configuration is absent", () => {
  assert.deepEqual(
    findDeploymentDocumentationViolations([
      { content: "Current Daytona execution.\n", path: "README.md" },
    ]),
    []
  );
});

test("allows only the deny-only Vercel Git deployment control", () => {
  assert.equal(isVercelDeploymentDisableConfig(disabledDeploymentConfig), true);
  assert.deepEqual(
    findDeploymentDocumentationViolations([
      { content: disabledDeploymentConfig, path: "vercel.json" },
    ]),
    []
  );

  const extraDeploymentBehavior = JSON.stringify({
    ...VERCEL_DEPLOYMENT_DISABLE_CONFIG,
    framework: "nextjs",
  });
  assert.equal(isVercelDeploymentDisableConfig(extraDeploymentBehavior), false);
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

test("allows documented Vercel deployment configuration", () => {
  const documentation = `${VERCEL_DEPLOYMENT_REQUIRED_HEADINGS.join("\n\n")}\n`;

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
