import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MAX_FILE_BYTES,
  renderFindings,
  scanRepository,
  scanText,
} from "./secret-scan";

function githubToken() {
  return `ghp_${"A".repeat(36)}`;
}

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repository() {
  const cwd = mkdtempSync(path.join(tmpdir(), "coven-secret-scan-"));
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.email", "scanner@example.test"]);
  git(cwd, ["config", "user.name", "Secret scanner"]);
  return cwd;
}

test("blocks a recognized credential shape and allows a near miss", () => {
  const secret = githubToken();

  const findings = scanText("config.ts", `const value = "${secret}";`);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "GitHub token");
  assert.deepEqual(scanText("config.ts", 'const value = "ghp_example";'), []);
});

test("reports location and category without printing the secret", () => {
  const secret = githubToken();
  const rendered = renderFindings(
    scanText("config.ts", `first line\nconst value = "${secret}";`)
  );

  assert.match(rendered, /config\.ts:2/);
  assert.match(rendered, /GitHub token/);
  assert.doesNotMatch(rendered, new RegExp(secret));
});

test("secret-shaped filenames are blocked without echoing the filename", () => {
  const cwd = repository();
  const secret = githubToken();
  const filename = `${secret}.txt`;
  writeFileSync(path.join(cwd, filename), "ordinary content\n");
  git(cwd, ["add", filename]);

  const findings = scanRepository({ cwd, mode: "staged" });
  const rendered = renderFindings(findings);

  assert.equal(findings[0]?.category, "secret-shaped filename");
  assert.doesNotMatch(rendered, new RegExp(secret));
  assert.match(rendered, /\[sensitive path\]/);
});

test("reported paths cannot inject terminal control characters", () => {
  const rendered = renderFindings([
    {
      category: "GitHub token",
      line: 1,
      path: "safe\nforged\u001b[31m.ts",
    },
  ]);

  assert.match(rendered, /safe\?forged\?\[31m\.ts:1/);
  assert.equal(rendered.includes(String.fromCharCode(27)), false);
});

test("an explicit reviewed-fixture marker allows only the following line", () => {
  const secret = githubToken();
  const marked = [
    "// secret-scan: allow-next-line -- synthetic redaction fixture",
    `const fixture = "${secret}";`,
    `const leaked = "${secret}";`,
  ].join("\n");

  const findings = scanText("fixture.test.ts", marked);

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.line, 3);
  assert.equal(
    scanText(
      "fixture.test.ts",
      ["// secret-scan: allow-next-line", `const value = "${secret}";`].join(
        "\n"
      )
    ).length,
    1
  );
});

test("staged mode reads the index rather than unstaged working-tree content", () => {
  const cwd = repository();
  const filename = path.join(cwd, "config.ts");
  writeFileSync(filename, 'export const value = "safe";\n');
  git(cwd, ["add", "config.ts"]);
  writeFileSync(filename, `export const value = "${githubToken()}";\n`);

  assert.deepEqual(scanRepository({ cwd, mode: "staged" }), []);

  git(cwd, ["add", "config.ts"]);
  const findings = scanRepository({ cwd, mode: "staged" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.path, "config.ts");
});

test("oversized staged files fail closed without loading their content", () => {
  const cwd = repository();
  writeFileSync(path.join(cwd, "large.txt"), "x".repeat(MAX_FILE_BYTES + 1));
  git(cwd, ["add", "large.txt"]);

  const findings = scanRepository({ cwd, mode: "staged" });

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "file exceeds scan limit");
});

test("pre-commit and CI invoke the staged and tracked scanners", () => {
  const root = path.join(import.meta.dirname, "..");
  const hook = readFileSync(path.join(root, ".husky/pre-commit"), "utf8");
  const workflow = readFileSync(
    path.join(root, ".github/workflows/ci.yml"),
    "utf8"
  );
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  ) as { scripts?: Record<string, string> };

  assert.equal(
    manifest.scripts?.["secret:scan"],
    "tsx scripts/secret-scan.ts --staged"
  );
  assert.equal(
    manifest.scripts?.["secret:scan:all"],
    "tsx scripts/secret-scan.ts --tracked"
  );
  assert.ok(
    hook.indexOf("corepack pnpm secret:scan") <
      hook.indexOf("corepack pnpm exec lint-staged")
  );
  assert.match(workflow, /name: Secret scan[\s\S]*run: pnpm secret:scan:all/);
});
