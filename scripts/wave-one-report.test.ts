import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const reportUrl = new URL(
  "../docs/roadmap/wave-1-delivery.md",
  import.meta.url
);
const readmeUrl = new URL("../README.md", import.meta.url);

test("the Wave 1 report records delivery evidence and residual risks", () => {
  const report = readFileSync(reportUrl, "utf8");

  for (const heading of [
    "# Wave 1 Delivery Report",
    "## Delivered outcomes",
    "## Verification evidence",
    "## Residual risks",
    "## Wave 2 priority",
  ]) {
    assert.match(report, new RegExp(heading));
  }

  for (const delivered of [
    "coven-agents-product.1",
    "coven-agents-product.3",
    "coven-agents-security.1",
    "coven-agents-security.5",
    "PR #92",
    "PR #93",
    "PR #94",
  ]) {
    assert.match(report, new RegExp(delivered.replaceAll(".", "\\.")));
  }

  for (const residual of [
    "coven-agents-security.2",
    "coven-agents-security.3",
    "coven-agents-security.4",
    "coven-agents-cloud.4",
    "coven-agents-local.2",
  ]) {
    assert.match(report, new RegExp(residual.replaceAll(".", "\\.")));
  }
});

test("the README links the published Wave 1 result", () => {
  const readme = readFileSync(readmeUrl, "utf8");

  assert.match(
    readme,
    /\[Wave 1 delivery report\]\(docs\/roadmap\/wave-1-delivery\.md\)/
  );
});
