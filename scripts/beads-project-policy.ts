import type { Bead } from "./beads-project-model";

export const MARKER_PREFIX = "<!-- coven-agents-bead-sync:v1 id=";

export type DesiredProjectItem = {
  beadId: string;
  body: string;
  fields: Record<string, string>;
  title: string;
};

type SafeField = "acceptance" | "description" | "title";

const SAFE_TEXT_LIMITS: Record<SafeField, number> = {
  acceptance: 3000,
  description: 2000,
  title: 120,
};

const CLOSING_PUNCTUATION = /[)"'`>\]}.,;:!?]+$/;
const OPENING_PUNCTUATION = /^[("'`<[{]+/;

const SENSITIVE_PATTERNS: ReadonlyArray<{
  category: string;
  pattern: RegExp;
}> = [
  {
    category: "pem private key",
    pattern: /-----BEGIN [^-]*PRIVATE KEY-----/i,
  },
  {
    category: "bearer header",
    pattern: /authorization\s*:\s*bearer\s+\S+/i,
  },
  {
    category: "github token",
    pattern: /\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/i,
  },
  {
    category: "provider token",
    pattern: /\b(?:sk-[A-Za-z0-9_-]+|xox[a-z]-[A-Za-z0-9-]+)/i,
  },
  {
    category: "env assignment",
    pattern: /\b[A-Z][A-Z0-9_]*\s*=\s*[^\s]+/,
  },
];

function unsafeError(field: string, category: string): never {
  throw new Error(`${field}: unsafe ${category}`);
}

function tokenize(value: string): string[] {
  return value.match(/[^\s]+/g) ?? [];
}

function stripToken(token: string): string {
  return token
    .replace(OPENING_PUNCTUATION, "")
    .replace(CLOSING_PUNCTUATION, "");
}

function getUnsafeCategory(
  field: SafeField,
  value: string
): string | undefined {
  if (value.length > SAFE_TEXT_LIMITS[field]) {
    return "length";
  }

  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) {
      return category;
    }
  }

  for (const token of tokenize(value)) {
    const normalized = stripToken(token);
    if (
      normalized.startsWith("/Users/") ||
      normalized.startsWith("/home/") ||
      /^[A-Za-z]:\\Users\\/.test(normalized)
    ) {
      return "absolute path";
    }
  }

  return undefined;
}

export function validateSafeText(field: SafeField, value: string): void {
  if (value.length > SAFE_TEXT_LIMITS[field]) {
    throw new Error(`${field} exceeds ${SAFE_TEXT_LIMITS[field]} characters`);
  }

  const category = getUnsafeCategory(field, value);

  if (category) {
    unsafeError(field, category);
  }
}

function projectStatusFor(bead: Bead): string {
  if (bead.status === "closed") {
    return "Done";
  }

  if (bead.metadata.projectStatus === "In review") {
    return "In review";
  }

  if (bead.status === "in_progress") {
    return "In Progress";
  }

  return "Todo";
}

function priorityLabel(priority: Bead["priority"]): string {
  return `P${priority}`;
}

function isClosed(bead: Bead | undefined): boolean {
  return bead?.status === "closed";
}

function activeDependencies(bead: Bead, all: Map<string, Bead>): string[] {
  const blockers = new Set<string>();

  for (const dependency of bead.dependencies) {
    if (dependency.type !== "blocks") {
      continue;
    }

    const blocker = all.get(dependency.depends_on_id);
    if (!isClosed(blocker)) {
      blockers.add(dependency.depends_on_id);
    }
  }

  return [...blockers].sort();
}

function renderLines(lines: string[]): string {
  return lines.join("\n");
}

export function projectBead(
  bead: Bead,
  all: Map<string, Bead>
): DesiredProjectItem {
  validateSafeText("title", bead.title);
  validateSafeText("description", bead.description);
  validateSafeText("acceptance", bead.acceptance_criteria);

  const blockers = activeDependencies(bead, all);
  const blocked =
    bead.status === "blocked" || blockers.length > 0 ? "Yes" : "No";
  const parent = bead.parent ? `\`${bead.parent}\`` : "None";
  const dependencies =
    blockers.length > 0
      ? blockers.map((dependency) => `\`${dependency}\``).join(", ")
      : "None";
  const body = renderLines([
    `${MARKER_PREFIX}${bead.id} -->`,
    "",
    "## Objective",
    "",
    bead.description,
    "",
    "## Acceptance criteria",
    "",
    bead.acceptance_criteria,
    "",
    "## Tracking",
    "",
    `- Bead: \`${bead.id}\``,
    `- Parent: ${parent}`,
    `- Active dependencies: ${dependencies}`,
  ]);

  return {
    beadId: bead.id,
    body,
    fields: {
      "Bead ID": bead.id,
      Blocked: blocked,
      Priority: priorityLabel(bead.priority),
      Runner: bead.metadata.runner,
      Size: bead.metadata.size,
      Status: projectStatusFor(bead),
      Type: bead.issue_type,
      Workstream: bead.metadata.workstream,
    },
    title: bead.title,
  };
}
