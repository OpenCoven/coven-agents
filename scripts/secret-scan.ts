import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export type SecretFinding = {
  category: string;
  line: number;
  path: string;
};

type ScanMode = "staged" | "tracked" | "history";
type ScanRequest = { cwd?: string; mode: ScanMode; range?: string };

const SECRET_PATTERNS: ReadonlyArray<{
  category: string;
  pattern: RegExp;
}> = [
  {
    category: "private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  },
  {
    category: "GitHub token",
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/u,
  },
  {
    category: "OpenAI key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    category: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/u,
  },
  {
    category: "AWS access key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/u,
  },
  {
    category: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  },
  {
    category: "Stripe key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
  },
  {
    category: "GitLab token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    category: "package registry token",
    pattern: /\b(?:npm_|pypi-)[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    category: "Hugging Face token",
    pattern: /\bhf_[A-Za-z0-9]{20,}\b/u,
  },
  {
    category: "DigitalOcean token",
    pattern: /\bdop_v1_[A-Za-z0-9]{20,}\b/u,
  },
  {
    category: "Google OAuth token",
    pattern: /\bya29\.[A-Za-z0-9._-]{20,}\b/u,
  },
];

/**
 * Every pattern above keys on a vendor prefix, which is exactly why none of
 * them can see this project's own secrets: `AUTH_SECRET`, the versioned
 * `CREDENTIAL_KEK_V1`/`CREDENTIAL_KEK_V2` ring,
 * `RUNNER_SIGNING_KEY`, and `AGENT_CONTROL_TOKEN` are raw base64 or hex with
 * no marker at all. The most damaging values in the repository were the ones
 * the scanner was structurally unable to detect.
 *
 * These rules key on the *name* instead. Matched generically rather than from
 * a list, so a secret added next year is covered without anyone remembering to
 * extend this. The separate credential-KEK rule below excludes the
 * `CREDENTIAL_KEK_CURRENT_VERSION` selector because it is not secret material.
 */
const SENSITIVE_NAME =
  /\b([A-Z][A-Z\d]*(?:_[A-Z\d]+)*_(?:SECRET|TOKEN|PASSWORD|PASSWD|KEY|KEK|CREDENTIAL)|PGPASSWORD|AUTH_SECRET)\s*[=:]\s*["'`]?([^\s"'`,;]+)/u;

/**
 * Credential KEKs are versioned by convention rather than by a fixed allowlist.
 * The current-version selector is configuration, not secret material, so it is
 * deliberately excluded while every other valid suffix remains covered.
 */
const CREDENTIAL_KEK_NAME =
  /(?:\b(CREDENTIAL_KEK(?:_[A-Z0-9_]+)?)\b|["'](CREDENTIAL_KEK(?:_[A-Z0-9_]+)?)["'])\s*[=:]\s*["'`]?([^\s"'`,;}]+)/u;

/**
 * A connection string carries its password inline, so the usual advice to keep
 * "the password" out of a file misses it entirely.
 */
const CREDENTIALED_URL =
  /\b(?:postgres|postgresql|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?)::?\/\/[^\s:@/]+:([^\s@/]+)@/u;

/**
 * Values that mean "fill this in". `.env.example` uses `****`, and refusing to
 * distinguish these would make the scanner cry wolf on the one file whose job
 * is to name every secret.
 */
const PLACEHOLDER =
  /^(?:\*+|x+|\.+|-+|_+|<.*>|\$\{.*\}|%.*%|(?:replace|your|my|the|some|example|sample|placeholder|changeme|change-me|dummy|fake|test|todo|tbd|none|null|undefined|redacted|hidden|secret|password|token|key)\b.*)$/iu;

/** Below this, a value cannot hold enough entropy to be a real credential. */
const MIN_SECRET_LENGTH = 16;
/** A real random value uses most of its alphabet; `aaaaaaaaaaaaaaaa` does not. */
const MIN_DISTINCT_CHARACTERS = 8;

/**
 * Words joined by `-` or `_`: `runner-control-sensitive`, `access-key-value`,
 * `opencoven-runner-cloud`. Every false positive this rule produced on the
 * existing repository had exactly this shape -- test fixtures and identifiers,
 * all of them deliberately fake.
 *
 * A generated credential is base64, hex, or a vendor-prefixed blob, and does
 * not come out looking like English. The gap is a passphrase-style secret
 * ("correct-horse-battery-staple"), which this would wave through; nothing in
 * this system issues one, and the vendor patterns above are unaffected either
 * way.
 */
const WORD_SHAPED = /^[a-z]+(?:[-_][a-z]+)+$/u;

export function looksLikeRealSecret(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH || PLACEHOLDER.test(value)) {
    return false;
  }

  if (WORD_SHAPED.test(value)) {
    return false;
  }

  // An interpolation or a lookup is a reference to a secret, not a copy of one.
  if (/process\.env|import\.meta\.env|\$\(|`\$\{/u.test(value)) {
    return false;
  }

  /**
   * So is a bare identifier: `DEMO_RECORDING_CREDENTIAL: recordingCredential`
   * names a variable, it does not embed a value.
   *
   * Distinguished by having no digit. A generated credential is base64, hex,
   * or url-safe random, and the chance that 16 or more such characters contain
   * no digit at all is negligible -- whereas an identifier almost never does.
   */
  if (/^[A-Za-z_$][A-Za-z_$]*$/u.test(value)) {
    return false;
  }
  if (
    /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+$/u.test(value)
  ) {
    return false;
  }

  return new Set(value).size >= MIN_DISTINCT_CHARACTERS;
}

/**
 * Dotenv files hold real values by definition, so the safe rule is that none
 * of them is ever committed. `.gitignore` already lists most, but it covers
 * `.env.production.local` and not `.env.production`, and `git add -f` ignores
 * it regardless -- a rule enforced only by `.gitignore` is a rule anyone can
 * step around without noticing.
 */
const DOTENV_PATH =
  /(?:^|\/)(?:\.env(?:\.[^/]*)?|[^/]*\.env|\.dev\.vars(?:\.[^/]*)?)$/u;
const DOTENV_ALLOWED =
  /(?:^|\/)(?:\.env|\.dev\.vars)\.(?:example|sample|template|defaults)$/u;

export function isForbiddenDotenvPath(path: string): boolean {
  return DOTENV_PATH.test(path) && !DOTENV_ALLOWED.test(path);
}

const ALLOW_NEXT_LINE = /secret-scan:\s*allow-next-line\s+--\s+\S.*$/u;

function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => pattern.test(value));
}

/**
 * The name-based and URL-based findings for one line.
 *
 * Separate from `SECRET_PATTERNS` because both need to inspect the captured
 * value before deciding, and a bare `RegExp.test` cannot.
 */
function namedFindings(line: string): string[] {
  const found: string[] = [];

  const assignment = SENSITIVE_NAME.exec(line);
  if (assignment && looksLikeRealSecret(assignment[2])) {
    found.push(`value assigned to ${assignment[1]}`);
  }

  // Match every key on the line. A fresh global regex keeps `matchAll` from
  // inheriting mutable `lastIndex` state across calls.
  for (const credentialKek of line.matchAll(
    new RegExp(CREDENTIAL_KEK_NAME.source, "gu")
  )) {
    const credentialKekName = credentialKek[1] ?? credentialKek[2];
    if (
      credentialKekName !== "CREDENTIAL_KEK_CURRENT_VERSION" &&
      credentialKekName !== assignment?.[1] &&
      looksLikeRealSecret(credentialKek[3])
    ) {
      found.push(`value assigned to ${credentialKekName}`);
    }
  }

  const url = CREDENTIALED_URL.exec(line);
  if (url && looksLikeRealSecret(url[1])) {
    found.push("connection string with an inline password");
  }

  return found;
}

function sanitizePath(path: string): string {
  if (containsSecret(path)) {
    return "[sensitive path]";
  }
  return Array.from(path, (character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127 ? "?" : character;
  }).join("");
}

function git(
  cwd: string,
  args: string[],
  encoding?: BufferEncoding,
  input?: string
) {
  return execFileSync("git", args, {
    cwd,
    encoding,
    input,
    // Sized for an object listing, not a file. The previous 1 MB ceiling was
    // chosen for reading one blob and silently applied to the listings too.
    maxBuffer: MAX_TOTAL_BYTES,
    // Git's own stderr is suppressed: this walks objects speculatively, and an
    // inherited stream turns every expected miss into console noise that hides
    // the findings underneath it.
    stdio: input === undefined ? ["ignore", "pipe", "ignore"] : undefined,
  });
}

function candidatePaths(cwd: string, mode: ScanMode): string[] {
  const args =
    mode === "staged"
      ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
      : ["ls-files", "-z"];
  const output = git(cwd, args, "utf8") as string;
  return output.split("\0").filter(Boolean);
}

/**
 * Every blob ever committed on any branch, deduplicated, with its path.
 *
 * `--tracked` answers "is a secret in the tree now", which is the wrong
 * question after a leak: the damaging case is a value committed and then
 * removed, still reachable in history and still pushed. Rotation is always the
 * first response, but knowing whether something was ever committed is what
 * decides whether history has to be rewritten too.
 *
 * Types come from one `--batch-check` pass rather than a `cat-file` per
 * object. `rev-list --objects` yields trees and commits alongside blobs, and
 * asking for each one's type separately meant a process per object.
 */
function historyBlobs(
  cwd: string,
  selector: readonly string[]
): Array<{ path: string; sha: string }> {
  // The range decides what is looked at, and it decides it FIRST.
  //
  // This used to stat every object in the repository and only then narrow to
  // the range, so a one-commit pre-push scan did the same full-repository walk
  // as a full history audit. It reported the right findings and took long
  // enough that pushes piled up behind it -- a hook slow enough to resent is a
  // hook people skip, and this one was slow enough to look hung.
  const named = git(
    cwd,
    ["rev-list", "--objects", ...selector],
    "utf8"
  ) as string;

  const pathBySha = new Map<string, string>();
  for (const line of named.split("\n")) {
    const space = line.indexOf(" ");
    if (space === -1) {
      continue;
    }
    const sha = line.slice(0, space);
    const path = line.slice(space + 1);
    // `rev-list --objects` emits commits and trees too. A line with no path is
    // one of those; the type check below drops whatever else slips through.
    if (path && !pathBySha.has(sha)) {
      pathBySha.set(sha, path);
    }
  }

  if (pathBySha.size === 0) {
    return [];
  }

  // One `cat-file` for the candidates, fed over stdin: one process for the
  // whole range rather than one per object, and nothing outside the range.
  const checked = git(
    cwd,
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    "utf8",
    `${Array.from(pathBySha.keys()).join("\n")}\n`
  ) as string;

  const blobs: Array<{ path: string; sha: string }> = [];
  for (const line of checked.split("\n")) {
    const [sha, type, size] = line.split(" ");
    if (type !== "blob" || Number(size) > MAX_FILE_BYTES) {
      continue;
    }
    const path = pathBySha.get(sha);
    if (path) {
      blobs.push({ path, sha });
    }
  }

  return blobs;
}

function scanHistory(
  cwd: string,
  selector: readonly string[]
): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const { path, sha } of historyBlobs(cwd, selector)) {
    if (isForbiddenDotenvPath(path)) {
      findings.push({
        category: "dotenv file present in history",
        line: 1,
        path,
      });
      continue;
    }

    let content: Buffer;
    try {
      content = git(cwd, ["cat-file", "blob", sha]) as Buffer;
    } catch {
      continue;
    }

    if (content.includes(0)) {
      continue;
    }

    findings.push(...scanText(path, content.toString("utf8")));
  }

  return findings;
}

function stagedSize(cwd: string, path: string): number {
  const raw = git(cwd, ["cat-file", "-s", `:${path}`], "utf8") as string;
  const size = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Git returned an invalid staged size for ${path}.`);
  }
  return size;
}

function stagedContent(cwd: string, path: string): Buffer {
  return git(cwd, ["show", `:${path}`]) as Buffer;
}

export function scanText(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let allowLine = -1;
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (ALLOW_NEXT_LINE.test(line)) {
      allowLine = index + 1;
      continue;
    }
    if (index === allowLine) {
      continue;
    }
    for (const { category, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ category, line: index + 1, path });
      }
    }
    for (const category of namedFindings(line)) {
      findings.push({ category, line: index + 1, path });
    }
  }
  return findings;
}

export function scanRepository({
  cwd = process.cwd(),
  mode,
  range,
}: ScanRequest): SecretFinding[] {
  if (mode === "history") {
    /**
     * A range scans only the objects the push introduces, which is both fast
     * enough for a hook and stricter than a net diff: a secret committed and
     * then deleted in a later commit never appears in `base..head` as a change,
     * but the blob is still there and is still about to be pushed.
     */
    return scanHistory(cwd, range ? [range] : ["--all"]);
  }

  const findings: SecretFinding[] = [];
  let totalBytes = 0;

  for (const path of candidatePaths(cwd, mode)) {
    if (containsSecret(path)) {
      findings.push({
        category: "secret-shaped filename",
        line: 1,
        path,
      });
      continue;
    }

    if (isForbiddenDotenvPath(path)) {
      findings.push({
        category: "dotenv file must never be committed",
        line: 1,
        path,
      });
      continue;
    }

    const size = stagedSize(cwd, path);
    totalBytes += size;

    if (size > MAX_FILE_BYTES) {
      findings.push({ category: "file exceeds scan limit", line: 1, path });
      continue;
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      findings.push({
        category: "staged content exceeds total scan limit",
        line: 1,
        path,
      });
      break;
    }

    const content = stagedContent(cwd, path);
    if (content.includes(0)) {
      continue;
    }
    findings.push(...scanText(path, content.toString("utf8")));
  }

  return findings;
}

export function renderFindings(findings: readonly SecretFinding[]): string {
  const locations = findings
    .map(({ category, line, path }) => {
      const safePath = sanitizePath(path);
      return `- ${safePath}:${line} — ${category}`;
    })
    .join("\n");
  return [
    "Secret scan blocked this change.",
    locations,
    "Move credentials to local environment storage or a secret manager, then replace or unstage the value.",
    "Secret values are never printed.",
  ].join("\n");
}

function main() {
  const [, , flag] = process.argv;
  const modes: Record<string, ScanMode> = {
    "--history": "history",
    "--range": "history",
    "--staged": "staged",
    "--tracked": "tracked",
  };
  const mode = flag ? modes[flag] : undefined;
  const range = flag === "--range" ? process.argv[3] : undefined;

  if (flag === "--range" && !range) {
    process.stderr.write("Usage: secret-scan.ts --range <rev-range>\n");
    process.exitCode = 2;
    return;
  }
  if (!mode) {
    process.stderr.write(
      "Usage: secret-scan.ts --staged|--tracked|--history|--range <rev-range>\n"
    );
    process.exitCode = 2;
    return;
  }

  try {
    const findings = scanRepository({ mode, range });
    if (findings.length > 0) {
      process.stderr.write(`${renderFindings(findings)}\n`);
      process.exitCode = 1;
    }
  } catch {
    process.stderr.write(
      "Secret scan could not inspect the requested Git content; refusing to continue.\n"
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
