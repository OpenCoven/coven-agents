import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  LOCKFILE_OPTIONAL_PEER_MARKER,
  PLATFORM_RESIDUE_SCANNER_PATH,
  type PlatformScanMode,
  parsePlatformScanMode,
  RETIRED_INTEGRATION_MARKERS,
  scanRepository,
  scanTrackedEntries,
} from "./platform-residue-scan";

const [primaryMarker] = RETIRED_INTEGRATION_MARKERS;
const filenameMarker = RETIRED_INTEGRATION_MARKERS.find((marker) =>
  marker.endsWith(".dev")
);

assert.ok(primaryMarker);
assert.ok(filenameMarker);

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function repository(t: test.TestContext): string {
  const cwd = mkdtempSync(join(process.cwd(), ".platform-residue-test-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  git(cwd, ["init", "--quiet"]);
  git(cwd, ["config", "user.email", "scanner@example.invalid"]);
  git(cwd, ["config", "user.name", "Scanner Test"]);
  git(cwd, ["config", "commit.gpgSign", "false"]);
  writeFileSync(join(cwd, "README.md"), "Current Daytona execution.\n");
  git(cwd, ["add", "README.md"]);
  git(cwd, ["commit", "--quiet", "-m", "initial"]);
  return cwd;
}

function repositoryFindings(cwd: string, mode: PlatformScanMode) {
  return scanRepository(cwd, mode);
}

test("detects retired integration markers case-insensitively in content", () => {
  const findings = scanTrackedEntries([
    {
      content: `Retired provider: ${primaryMarker.toUpperCase()}\n`,
      path: "docs/provider.md",
    },
  ]);

  assert.deepEqual(findings, [
    {
      kind: "content",
      line: 1,
      marker: primaryMarker,
      path: "docs/provider.md",
    },
  ]);
});

test("detects retired integration markers in tracked filenames", () => {
  const findings = scanTrackedEntries([
    {
      content: "Current content.\n",
      path: `docs/${filenameMarker}/notes.md`,
    },
  ]);

  assert.deepEqual(findings, [
    {
      kind: "filename",
      line: 0,
      marker: filenameMarker,
      path: `docs/${filenameMarker}/notes.md`,
    },
  ]);
});

test("self-excludes the scanner rule inventory", () => {
  const findings = scanTrackedEntries([
    {
      content: RETIRED_INTEGRATION_MARKERS.join("\n"),
      path: PLATFORM_RESIDUE_SCANNER_PATH,
    },
  ]);

  assert.deepEqual(findings, []);
});

test("does not report current Daytona platform text", () => {
  const findings = scanTrackedEntries([
    {
      content:
        "Daytona provides one tenant-scoped persistent sandbox per agent.\n",
      path: "docs/architecture/daytona.md",
    },
  ]);

  assert.deepEqual(findings, []);
});

test("allows only the generated drizzle optional-peer lockfile metadata", () => {
  const allowed = [
    "lockfileVersion: '9.0'",
    "",
    "packages:",
    "",
    "  drizzle-orm@0.45.2:",
    "    peerDependencies:",
    `      '${LOCKFILE_OPTIONAL_PEER_MARKER}': '>=4'`,
    "    peerDependenciesMeta:",
    `      '${LOCKFILE_OPTIONAL_PEER_MARKER}':`,
    "        optional: true",
    "",
  ].join("\n");

  assert.deepEqual(
    scanTrackedEntries([{ content: allowed, path: "pnpm-lock.yaml" }]),
    []
  );

  const importerDependency = [
    "importers:",
    "  .:",
    "    dependencies:",
    `      ${LOCKFILE_OPTIONAL_PEER_MARKER}:`,
    "        version: 1.0.0",
  ].join("\n");

  assert.equal(
    scanTrackedEntries([
      { content: importerDependency, path: "pnpm-lock.yaml" },
    ]).length,
    1
  );
});

test("worktree mode includes non-ignored untracked files", (t) => {
  const cwd = repository(t);
  writeFileSync(join(cwd, "untracked.md"), primaryMarker.toUpperCase());

  const expected = [
    {
      kind: "content",
      line: 1,
      marker: primaryMarker,
      path: "untracked.md",
    },
  ] as const;
  assert.deepEqual(repositoryFindings(cwd, "worktree"), expected);
  assert.deepEqual(scanRepository(cwd), expected);
  assert.deepEqual(repositoryFindings(cwd, "index"), []);
});

test("command modes default to worktree and reject ambiguous arguments", () => {
  assert.equal(parsePlatformScanMode([]), "worktree");
  assert.equal(parsePlatformScanMode(["--worktree"]), "worktree");
  assert.equal(parsePlatformScanMode(["--index"]), "index");
  assert.throws(() => parsePlatformScanMode(["--tracked"]), /Usage:/);
  assert.throws(
    () => parsePlatformScanMode(["--worktree", "--index"]),
    /Usage:/
  );
});

test("index mode reads staged content instead of cleaned worktree content", (t) => {
  const cwd = repository(t);
  const path = join(cwd, "README.md");
  writeFileSync(path, `retired: ${primaryMarker}\n`);
  git(cwd, ["add", "README.md"]);
  writeFileSync(path, "Current Daytona execution.\n");

  assert.deepEqual(repositoryFindings(cwd, "worktree"), []);
  assert.deepEqual(repositoryFindings(cwd, "index"), [
    {
      kind: "content",
      line: 1,
      marker: primaryMarker,
      path: "README.md",
    },
  ]);
});

test("worktree mode reads dirty content instead of the staged clean blob", (t) => {
  const cwd = repository(t);
  const path = join(cwd, "README.md");
  writeFileSync(path, "Current Daytona execution after staging.\n");
  git(cwd, ["add", "README.md"]);
  writeFileSync(path, `dirty: ${primaryMarker.toUpperCase()}\n`);

  assert.deepEqual(repositoryFindings(cwd, "index"), []);
  assert.deepEqual(repositoryFindings(cwd, "worktree"), [
    {
      kind: "content",
      line: 1,
      marker: primaryMarker,
      path: "README.md",
    },
  ]);
});

test("staged deletion disappears and staged rename uses the destination path", (t) => {
  const cwd = repository(t);
  mkdirSync(join(cwd, "docs"), { recursive: true });
  writeFileSync(join(cwd, "delete-me.md"), primaryMarker);
  writeFileSync(join(cwd, "rename-me.md"), "Current text.\n");
  git(cwd, ["add", "delete-me.md", "rename-me.md"]);
  git(cwd, ["commit", "--quiet", "-m", "add rename fixtures"]);

  git(cwd, ["rm", "--quiet", "delete-me.md"]);
  const destination = `docs/${filenameMarker.toUpperCase()}/notes.md`;
  mkdirSync(join(cwd, `docs/${filenameMarker.toUpperCase()}`), {
    recursive: true,
  });
  git(cwd, ["mv", "rename-me.md", destination]);

  for (const mode of ["worktree", "index"] as const) {
    const observed = repositoryFindings(cwd, mode);
    assert.deepEqual(observed, [
      {
        kind: "filename",
        line: 0,
        marker: filenameMarker,
        path: destination,
      },
    ]);
    assert.equal(
      observed.some((finding) => finding.path === "delete-me.md"),
      false
    );
    assert.equal(
      observed.some((finding) => finding.path === "rename-me.md"),
      false
    );
  }
});

test("NUL-delimited inventory preserves unusual paths and case-insensitive content", (t) => {
  const cwd = repository(t);
  const path = "line\nbreak.md";
  writeFileSync(join(cwd, path), primaryMarker.toUpperCase());

  assert.deepEqual(repositoryFindings(cwd, "worktree"), [
    {
      kind: "content",
      line: 1,
      marker: primaryMarker,
      path,
    },
  ]);
});

test("binary content is skipped while its filename remains eligible", (t) => {
  const cwd = repository(t);
  const path = "binary.dat";
  writeFileSync(
    join(cwd, path),
    Buffer.concat([
      Buffer.from([0, 1, 2, 3]),
      Buffer.from(primaryMarker.toUpperCase()),
    ])
  );
  git(cwd, ["add", path]);

  assert.deepEqual(repositoryFindings(cwd, "worktree"), []);
  assert.deepEqual(repositoryFindings(cwd, "index"), []);
});

test("current Daytona text passes in both repository modes", (t) => {
  const cwd = repository(t);
  writeFileSync(
    join(cwd, "architecture.md"),
    "Daytona provides one tenant-scoped persistent sandbox per agent.\n"
  );
  git(cwd, ["add", "architecture.md"]);

  assert.deepEqual(repositoryFindings(cwd, "worktree"), []);
  assert.deepEqual(repositoryFindings(cwd, "index"), []);
});
