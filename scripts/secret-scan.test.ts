import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isForbiddenDotenvPath,
  looksLikeRealSecret,
  MAX_FILE_BYTES,
  renderFindings,
  scanRepository,
  scanText,
} from "./secret-scan";

/**
 * Shaped like the real thing: base64 of random bytes. Written out rather than
 * generated so the test is deterministic, and deliberately not a real value.
 */
const RANDOM_BASE64 = "Qk9HVVNfa2V5XzdmM2EyYjFjOGQ0ZTVmNmE=";
const RANDOM_HEX = "9f3a2b1c8d4e5f6a7b8c9d0e1f2a3b4c";

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

test("a secret with no vendor prefix is still caught, by its name", () => {
  /**
   * The gap this closes. Every vendor pattern keys on a prefix, and this
   * project's own secrets have none -- AUTH_SECRET, CREDENTIAL_KEK, and
   * RUNNER_SIGNING_KEY are raw base64. The most damaging values in the
   * repository were the ones the scanner could not see.
   */
  for (const name of [
    "AUTH_SECRET",
    "CREDENTIAL_KEK",
    "RUNNER_SIGNING_KEY",
    "AGENT_CONTROL_TOKEN",
    "RUNNER_SERVICE_TOKEN",
    "STRIPE_WEBHOOK_SECRET",
    "AUTH_GITHUB_SECRET",
    "PGPASSWORD",
  ]) {
    const findings = scanText(".env", `${name}=${RANDOM_BASE64}`);

    assert.equal(findings.length, 1, `${name} was not caught`);
    assert.match(findings[0].category, new RegExp(name));
  }
});

test("a connection string is caught by its inline password", () => {
  // The password is inside the URL, so advice about "keeping the password out
  // of the file" misses it entirely.
  const findings = scanText(
    "config.ts",
    `const url = "postgres://owner:${RANDOM_HEX}@ep-x.aws.neon.tech/neondb";`
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0].category, /inline password/);
});

test("placeholders and references are not mistaken for secrets", () => {
  // `.env.example` is the one file whose job is to name every secret. Crying
  // wolf on it would train everyone to bypass the scanner.
  for (const value of [
    "****",
    "",
    "replace-with-a-long-random-token",
    "your-secret-here",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal text is the input under test.
    "${SOME_VAR}",
    "process.env.AUTH_SECRET",
    "recordingCredential",
    "RECORDING_CREDENTIAL",
    "runner-control-sensitive",
    "opencoven-runner-cloud",
    "short",
    "aaaaaaaaaaaaaaaaaaaa",
  ]) {
    assert.equal(
      looksLikeRealSecret(value),
      false,
      `${JSON.stringify(value)} was treated as a real secret`
    );
  }
});

test("real generated values are recognized", () => {
  for (const value of [
    RANDOM_BASE64,
    RANDOM_HEX,
    "whsec_9f3a2b1c8d4e5f6a7b8c",
  ]) {
    assert.equal(looksLikeRealSecret(value), true, value);
  }
});

test("no dotenv file may be committed except the documented examples", () => {
  /**
   * `.gitignore` lists `.env.production.local` but not `.env.production`, and
   * `git add -f` ignores it either way. A rule enforced only by `.gitignore`
   * is one anyone can step around without noticing.
   */
  for (const candidate of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.development.local",
    "worker/.dev.env",
    "nested/dir/.env.staging",
  ]) {
    assert.equal(isForbiddenDotenvPath(candidate), true, candidate);
  }

  for (const candidate of [
    ".env.example",
    ".env.sample",
    ".env.template",
    "docs/.env.example",
    "lib/environment.ts",
  ]) {
    assert.equal(isForbiddenDotenvPath(candidate), false, candidate);
  }
});

test("a committed dotenv file is refused before its contents are read", () => {
  // Reported by path: the file is refused for being what it is, so the scanner
  // never needs to decide whether the values inside look real.
  const cwd = repository();
  writeFileSync(path.join(cwd, ".env.production"), "HARMLESS=1\n");
  git(cwd, ["add", "-f", ".env.production"]);

  const findings = scanRepository({ cwd, mode: "staged" });

  assert.equal(findings.length, 1);
  assert.match(findings[0].category, /dotenv/);
});

test("pre-push scans the range it is about to push", () => {
  /**
   * The last line of defence. `pre-commit` can be skipped with `--no-verify`,
   * and a secret committed and then deleted in a later commit never shows up in
   * a net diff while still being pushed -- so the hook scans the objects the
   * push introduces, not the working tree.
   *
   * Ordered after the signature check only because both must pass; neither is
   * optional.
   */
  const root = path.join(import.meta.dirname, "..");
  const hook = readFileSync(path.join(root, ".husky/pre-push"), "utf8");
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  ) as { scripts?: Record<string, string> };

  assert.match(hook, /secret-scan\.ts --range "\$range"/);
  assert.equal(
    manifest.scripts?.["secret:scan:history"],
    "tsx scripts/secret-scan.ts --history"
  );
});

test("a range scan sees a secret that a later commit deleted", () => {
  /**
   * The case a net diff misses entirely. Committing a credential and removing
   * it in the next commit leaves `base..head` clean, while the blob is still
   * in the objects being pushed -- and once pushed, deleting it changes
   * nothing, because it is already on someone else's disk.
   */
  const cwd = repository();
  writeFileSync(path.join(cwd, "seed.txt"), "nothing here\n");
  git(cwd, ["add", "seed.txt"]);
  git(cwd, ["commit", "--no-gpg-sign", "-m", "seed"]);
  const base = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
  }).trim();

  writeFileSync(path.join(cwd, "leak.txt"), `token = "${githubToken()}"\n`);
  git(cwd, ["add", "leak.txt"]);
  git(cwd, ["commit", "--no-gpg-sign", "-m", "oops"]);

  execFileSync("git", ["rm", "--quiet", "leak.txt"], { cwd });
  git(cwd, ["commit", "--no-gpg-sign", "-m", "remove it"]);

  const range = `${base}..HEAD`;
  assert.equal(
    scanRepository({ cwd, mode: "tracked" }).length,
    0,
    "the working tree is clean, which is exactly why tracked mode is not enough"
  );
  assert.ok(
    scanRepository({ cwd, mode: "history", range }).length > 0,
    "the deleted blob is still in the range being pushed"
  );
});
