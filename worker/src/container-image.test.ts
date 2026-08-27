import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfileUrl = new URL("../Dockerfile", import.meta.url);
const packageUrl = new URL("../package.json", import.meta.url);

test("the Sandbox container image matches the Worker SDK version", () => {
  const packageJson = JSON.parse(readFileSync(packageUrl, "utf8")) as {
    dependencies: Record<string, string>;
  };
  const sdkVersion = packageJson.dependencies["@cloudflare/sandbox"];
  const dockerfile = readFileSync(dockerfileUrl, "utf8");

  assert.match(
    dockerfile,
    new RegExp(
      `^FROM docker\\.io/cloudflare/sandbox:${sdkVersion.replaceAll(".", "\\.")}$`,
      "m"
    ),
    `worker/Dockerfile must use cloudflare/sandbox:${sdkVersion}`
  );
});
