import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workerRoot = fileURLToPath(new URL("..", import.meta.url));
const secretTemplate = readFileSync(`${workerRoot}/.dev.vars.example`, "utf8");
const generatedTypes = readFileSync(
  `${workerRoot}/worker-configuration.d.ts`,
  "utf8"
);
const configuration = JSON.parse(
  readFileSync(`${workerRoot}/wrangler.jsonc`, "utf8")
) as { vars?: Record<string, unknown> };

function keys(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/u)?.[1])
    .filter((key): key is string => key !== undefined)
    .sort();
}

test("keeps the secret template, Worker configuration, and generated Env aligned", () => {
  const secretKeys = keys(secretTemplate);
  const generatedKeys = keys(
    generatedTypes.replace(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*[^;]+;$/gmu, "$1=")
  );

  assert.deepEqual(secretKeys, ["AGENT_CONTROL_TOKEN", "OPENAI_API_KEY"]);
  for (const key of secretKeys) {
    assert.equal(key in (configuration.vars ?? {}), false);
    assert.equal(generatedKeys.includes(key), true, `missing Env.${key}`);
  }
});
