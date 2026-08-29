import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("route imports leave the production Daytona graph behind an async seam", () => {
  const dependencies = source("./route-dependencies.ts");

  assert.doesNotMatch(dependencies, /from\s+["']\.\/production["']/);
  assert.match(dependencies, /import\(["']\.\/production["']\)/);
  assert.match(dependencies, /createOperatorService:\s*async/);
  assert.match(dependencies, /createService:\s*async/);
});

test("warming routes declare the duration required by after and synchronous work", () => {
  assert.match(
    source("../../app/api/agents/route.ts"),
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
