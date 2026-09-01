import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const PLANNING_REGISTRY_PATH = "docs/roadmap/README.md";

export const PLANNING_LIFECYCLES = [
  "Current",
  "Proposed",
  "Historical",
  "Superseded",
] as const;

export const PLANNING_AUTHORITIES = [
  "Beads-derived aggregate",
  "Non-authoritative proposal",
  "Operating policy",
  "Repository evidence",
] as const;

export const PLANNING_ROLES = [
  "Decision log",
  "Evidence",
  "Governance",
  "Proposal",
  "Readiness",
  "Registry",
  "Sequence",
  "State",
  "Strategy",
  "Tombstone",
  "Verification",
] as const;

export type PlanningDocument = {
  authority: string;
  currentGuidance: string[];
  lastReviewed: string;
  lifecycle: (typeof PLANNING_LIFECYCLES)[number] | string;
  path: string;
  registryTarget: string | undefined;
  role: (typeof PLANNING_ROLES)[number] | string;
};

export type PlanningDocumentPolicyInput = {
  registryMarkdown: string;
  trackedPaths: readonly string[];
};

export type PlanningDocumentViolation = {
  path: string;
  reason:
    | "broken-current-guidance"
    | "duplicate-path"
    | "invalid-authority"
    | "invalid-last-reviewed"
    | "invalid-lifecycle"
    | "invalid-registry-link"
    | "invalid-role"
    | "missing-current-guidance"
    | "missing-tracked-file"
    | "noncurrent-current-guidance"
    | "unindexed-planning-document";
};

const START_MARKER = "<!-- coven-agents-planning-registry:v1:start -->";
const END_MARKER = "<!-- coven-agents-planning-registry:v1:end -->";

function isValidReviewDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) {
    return false;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= (daysInMonth[month - 1] ?? 0);
}

function registryBlock(markdown: string): string {
  const start = markdown.indexOf(START_MARKER);
  const end = markdown.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Planning registry markers are invalid");
  }

  return markdown.slice(start + START_MARKER.length, end);
}

function normalizeGuidancePath(href: string): string | undefined {
  if (
    href.startsWith("#") ||
    href.startsWith("https://") ||
    href.startsWith("http://")
  ) {
    return undefined;
  }

  const [path] = href.split(/[?#]/u, 1);
  if (path === undefined || path.length === 0) {
    return undefined;
  }

  if (path.startsWith("/")) {
    return posix.normalize(path.slice(1));
  }

  return posix.normalize(
    posix.join(posix.dirname(PLANNING_REGISTRY_PATH), path)
  );
}

function guidancePaths(cell: string): string[] {
  const paths: string[] = [];
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/gu;

  for (const match of cell.matchAll(linkPattern)) {
    const [, href] = match;
    if (href === undefined) {
      continue;
    }

    const normalized = normalizeGuidancePath(href);
    if (normalized !== undefined) {
      paths.push(normalized);
    }
  }

  return paths;
}

export function parsePlanningRegistry(markdown: string): PlanningDocument[] {
  const lines = registryBlock(markdown)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"));

  return lines.slice(2).map((line) => {
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (cells.length !== 6) {
      throw new Error("Planning registry row must contain six columns");
    }

    const [pathCell, role, lifecycle, authority, lastReviewed, guidance] =
      cells;
    if (
      pathCell === undefined ||
      role === undefined ||
      lifecycle === undefined ||
      authority === undefined ||
      lastReviewed === undefined ||
      guidance === undefined
    ) {
      throw new Error("Planning registry row is incomplete");
    }

    const registryLink = /^\[`([^`]+)`\]\(([^)]+)\)$/u.exec(pathCell);
    const path = registryLink?.[1] ?? pathCell;
    const registryTarget =
      registryLink?.[2] === undefined
        ? undefined
        : normalizeGuidancePath(registryLink[2]);

    return {
      authority,
      currentGuidance: guidancePaths(guidance),
      lastReviewed,
      lifecycle,
      path,
      registryTarget,
      role,
    };
  });
}

function isRequiredPlanningPath(path: string): boolean {
  return (
    path === "POLISH.md" ||
    path === "ROADMAP.md" ||
    path === "docs/beads-project-sync.md" ||
    /^docs\/operations\/.+\.md$/u.test(path) ||
    /^docs\/roadmap\/.+\.md$/u.test(path) ||
    /^docs\/proposals\/.+\.md$/u.test(path) ||
    path === "docs/superpowers/README.md"
  );
}

export function findPlanningDocumentViolations(
  input: PlanningDocumentPolicyInput
): PlanningDocumentViolation[] {
  const documents = parsePlanningRegistry(input.registryMarkdown);
  const trackedPaths = new Set(input.trackedPaths);
  const indexedPaths = new Set<string>();
  const documentsByPath = new Map<string, PlanningDocument>();
  const violations: PlanningDocumentViolation[] = [];

  for (const document of documents) {
    if (!documentsByPath.has(document.path)) {
      documentsByPath.set(document.path, document);
    }
  }

  for (const document of documents) {
    if (indexedPaths.has(document.path)) {
      violations.push({
        path: document.path,
        reason: "duplicate-path",
      });
      continue;
    }

    indexedPaths.add(document.path);

    if (!PLANNING_ROLES.some((role) => role === document.role)) {
      violations.push({
        path: document.path,
        reason: "invalid-role",
      });
    }

    if (
      !PLANNING_LIFECYCLES.some((lifecycle) => lifecycle === document.lifecycle)
    ) {
      violations.push({
        path: document.path,
        reason: "invalid-lifecycle",
      });
    }

    if (
      !PLANNING_AUTHORITIES.some(
        (authority) => authority === document.authority
      )
    ) {
      violations.push({
        path: document.path,
        reason: "invalid-authority",
      });
    }

    if (!isValidReviewDate(document.lastReviewed)) {
      violations.push({
        path: document.path,
        reason: "invalid-last-reviewed",
      });
    }

    if (!trackedPaths.has(document.path)) {
      violations.push({
        path: document.path,
        reason: "missing-tracked-file",
      });
    }

    if (document.registryTarget !== document.path) {
      violations.push({
        path: document.path,
        reason: "invalid-registry-link",
      });
    }

    if (
      (document.lifecycle === "Historical" ||
        document.lifecycle === "Superseded") &&
      document.currentGuidance.length === 0
    ) {
      violations.push({
        path: document.path,
        reason: "missing-current-guidance",
      });
    }

    const guidanceTargets = document.currentGuidance.map((path) => ({
      document: documentsByPath.get(path),
      path,
      tracked: trackedPaths.has(path),
    }));

    for (const guidancePath of document.currentGuidance) {
      if (!trackedPaths.has(guidancePath)) {
        violations.push({
          path: guidancePath,
          reason: "broken-current-guidance",
        });
      }
    }

    if (
      (document.lifecycle === "Historical" ||
        document.lifecycle === "Superseded") &&
      guidanceTargets.length > 0 &&
      guidanceTargets.every((target) => target.tracked) &&
      !guidanceTargets.some(
        (target) =>
          target.path !== document.path &&
          target.document?.lifecycle === "Current"
      )
    ) {
      violations.push({
        path: document.path,
        reason: "noncurrent-current-guidance",
      });
    }
  }

  for (const path of input.trackedPaths) {
    if (isRequiredPlanningPath(path) && !indexedPaths.has(path)) {
      violations.push({
        path,
        reason: "unindexed-planning-document",
      });
    }
  }

  return violations;
}

function trackedRepositoryPaths(cwd: string): string[] {
  return execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path.length > 0 && existsSync(resolve(cwd, path)));
}

export function scanPlanningDocuments(
  cwd = process.cwd()
): PlanningDocumentViolation[] {
  const registryPath = resolve(cwd, PLANNING_REGISTRY_PATH);
  return findPlanningDocumentViolations({
    registryMarkdown: readFileSync(registryPath, "utf8"),
    trackedPaths: trackedRepositoryPaths(cwd),
  });
}

function main(): number {
  const violations = scanPlanningDocuments();
  if (violations.length > 0) {
    for (const violation of violations) {
      process.stderr.write(
        `Planning document policy violation: ${violation.reason} (${violation.path})\n`
      );
    }
    return 1;
  }

  process.stdout.write("Planning document policy passed.\n");
  return 0;
}

const [, entrypoint] = process.argv;
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = main();
}
