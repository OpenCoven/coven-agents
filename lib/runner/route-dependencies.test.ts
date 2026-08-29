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

test("the reconciliation route supports Vercel Cron GET and a one-minute schedule", () => {
  assert.match(
    source("../../app/api/internal/runner-reconcile/route.ts"),
    /export function GET/
  );
  const vercel = JSON.parse(source("../../vercel.json")) as {
    crons?: { path: string; schedule: string }[];
  };
  assert.deepEqual(vercel.crons, [
    { path: "/api/internal/runner-reconcile", schedule: "* * * * *" },
  ]);
});
