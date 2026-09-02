import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("internal GitHub tool route exposes only the capability-authenticated POST wrapper", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const exported = [
    ...source.matchAll(
      /export (?:async )?function (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gu
    ),
  ].map((match) => match[1]);
  assert.deepEqual(exported, ["POST"]);
  assert.match(source, /ipAddress\(request\) \?\? null/u);
  assert.match(
    source,
    /productionGitHubToolHandler\(\)\(request,\s*ipAddress\(request\) \?\? null\)/u
  );
  assert.doesNotMatch(source, /auth\(|session|cookie|COPILOT_GITHUB_TOKEN/iu);
});

test("production GitHub tool composition uses app installation authority and the operator database only", async () => {
  const source = await readFile(
    new URL(
      "../../../../lib/github/tool-route-dependencies.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(source, /createGitHubAppClient/u);
  assert.match(source, /createGitHubGatewayStore/u);
  assert.match(source, /databaseFor\(GITHUB_TOOL_OPERATOR\)/u);
  assert.match(source, /createGitHubToolHttpHandler/u);
  assert.match(source, /enforceAbusePolicy/u);
  assert.match(source, /refreshGitHubConnectionAuthority/u);
  assert.match(
    source,
    /retainsProjectAuthorityProof\(context\.capability\.allowedCapabilities\)/u
  );
  assert.match(
    source,
    /if \(\s+retainsProjectAuthorityProof\(context\.capability\.allowedCapabilities\)\s+\) \{\s+return;\s+\}/u
  );
  assert.doesNotMatch(
    source,
    /COPILOT_GITHUB_TOKEN|AUTH_GITHUB_SECRET|authorizeSubscriber|authenticate:|@\/app\/\(auth\)/u
  );
});
