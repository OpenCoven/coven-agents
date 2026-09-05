import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("route imports leave core runtime and diagnostics behind separate async seams", () => {
  const dependencies = source("./route-dependencies.ts");

  assert.doesNotMatch(dependencies, /from\s+["']\.\/production["']/);
  assert.doesNotMatch(dependencies, /import\(["']\.\/production["']\)/);
  assert.doesNotMatch(dependencies, /from\s+["']@\/app\/\(auth\)\/auth["']/);
  assert.doesNotMatch(
    dependencies,
    /from\s+["']@\/lib\/auth\/subscriber-authorization\.server["']/
  );
  assert.match(dependencies, /import\(["']@\/app\/\(auth\)\/auth["']\)/);
  assert.match(
    dependencies,
    /import\(\s*["']@\/lib\/auth\/subscriber-authorization\.server["']\s*\)/
  );
  assert.match(dependencies, /import\(["']\.\/runtime["']\)/);
  assert.match(dependencies, /import\(["']\.\/diagnostics["']\)/);
  assert.match(dependencies, /diagnoseSandbox:\s*async/);
  assert.match(dependencies, /createOperatorService:\s*async/);
  assert.match(dependencies, /createService:\s*async/);
  assert.match(
    dependencies,
    /appOrigin:\s*\(\)\s*=>\s*configuredApplicationOrigin\(process\.env\)/
  );
});

test("importing route dependencies constructs no database or Daytona client", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      'await import("./lib/runner/route-dependencies.ts");',
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DAYTONA_API_KEY: "",
        DAYTONA_SNAPSHOT: "",
        POSTGRES_URL: "not a postgres url",
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
});

test("warming routes declare the duration required by after and synchronous work", () => {
  assert.match(
    source("../../app/api/agents/route.ts"),
    /maxDuration\s*=\s*300/
  );
  assert.match(
    source("../../app/api/agents/[id]/route.ts"),
    /maxDuration\s*=\s*300/
  );
  assert.match(
    source("../../app/api/tenant/prewarm/route.ts"),
    /maxDuration\s*=\s*300/
  );
});

test("the reconciliation route supports GET invocation", () => {
  assert.match(
    source("../../app/api/internal/runner-reconcile/route.ts"),
    /export function GET/
  );
  assert.match(
    source("../../app/api/internal/runner-resource-inventory/route.ts"),
    /export function GET/
  );
});

test("Vercel schedules reconciliation, and the runbook covers it", () => {
  const vercel = JSON.parse(source("../../vercel.json")) as {
    crons?: { path: string; schedule: string }[];
    git?: { deploymentEnabled?: boolean };
  };

  // The runner sweep is what advances an unattended team run and recovers an
  // expired dispatch. Without it both wait for a person to open a page.
  const runner = vercel.crons?.find(
    (entry) => entry.path === "/api/internal/runner-reconcile"
  );
  assert.ok(runner, "the runner reconcile route must be scheduled");
  assert.equal(runner.schedule, "* * * * *");

  // Scheduling it does not re-enable Git deployments, which stay denied.
  assert.equal(vercel.git?.deploymentEnabled, false);

  // Any vercel.json beyond the deny-only control must ship with the runbook,
  // which names every scheduled job. scripts/deployment-documentation-policy
  // enforces the pairing; this asserts the jobs are actually described.
  const runbook = source("../../docs/runbooks/vercel-deployment.md");
  for (const entry of vercel.crons ?? []) {
    assert.match(runbook, new RegExp(entry.path.replaceAll("/", "\\/")));
  }
});
