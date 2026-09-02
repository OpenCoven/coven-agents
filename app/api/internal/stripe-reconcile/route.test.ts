import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("Stripe reconciliation exposes only the scheduled GET surface", () => {
  assert.match(source, /export const maxDuration = 300/);
  assert.match(source, /export function GET\(request: Request\)/);
  assert.doesNotMatch(source, /export function POST\(/);
  assert.match(source, /cronReconcileSecretFromEnvironment/);
  assert.doesNotMatch(source, /RUNNER_MANUAL_RECONCILE_SECRET/);
  assert.match(source, /ipAddress\(request\) \?\? null/);
});
