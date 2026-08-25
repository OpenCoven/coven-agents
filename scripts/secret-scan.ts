import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

export type SecretFinding = {
  category: string;
  line: number;
  path: string;
};

type ScanMode = "staged" | "tracked";

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

const ALLOW_NEXT_LINE = /secret-scan:\s*allow-next-line\s+--\s+\S.*$/u;

function containsSecret(value: string): boolean {
  return SECRET_PATTERNS.some(({ pattern }) => pattern.test(value));
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

function git(cwd: string, args: string[], encoding?: BufferEncoding) {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: MAX_FILE_BYTES + 1024,
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
  }
  return findings;
}

export function scanRepository({
  cwd = process.cwd(),
  mode,
}: {
  cwd?: string;
  mode: ScanMode;
}): SecretFinding[] {
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
  const mode =
    flag === "--staged" ? "staged" : flag === "--tracked" ? "tracked" : null;
  if (!mode) {
    process.stderr.write("Usage: secret-scan.ts --staged|--tracked\n");
    process.exitCode = 2;
    return;
  }

  try {
    const findings = scanRepository({ mode });
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
