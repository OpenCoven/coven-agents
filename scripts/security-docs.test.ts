import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const threatModelUrl = new URL(
  "../docs/security/execution-threat-model.md",
  import.meta.url
);
const readmeUrl = new URL("../README.md", import.meta.url);

test("the execution threat model covers every required security surface", () => {
  assert.equal(existsSync(threatModelUrl), true);
  const threatModel = readFileSync(threatModelUrl, "utf8");

  for (const heading of [
    "# Execution Threat Model",
    "## Scope and security goals",
    "## Actors and assumptions",
    "## Assets",
    "## Trust boundaries",
    "## Threat register",
    "## Incident and recovery expectations",
    "## Verification and review",
  ]) {
    assert.match(threatModel, new RegExp(heading));
  }

  for (const reference of [
    "worker/src/routes.ts",
    "packages/agent-contracts/src/evidence.ts",
    "lib/credentials/store.ts",
    "coven-agents-cloud.4",
    "coven-agents-security.3",
  ]) {
    assert.match(threatModel, new RegExp(reference.replaceAll(".", "\\.")));
  }
});

test("the README links reviewers to the living threat model", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(
    readme,
    /\[Execution threat model\]\(docs\/security\/execution-threat-model\.md\)/
  );
});
