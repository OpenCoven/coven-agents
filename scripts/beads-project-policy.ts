import { BEAD_ID_PATTERN, type Bead } from "./beads-project-model";

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
    category: "authorization header",
    pattern:
      /(?:^|[^A-Za-z0-9_])(?:authorization|proxy-authorization)\s*:\s*\S+/i,
  },
  {
    category: "api key header",
    pattern: /(?:^|[^A-Za-z0-9_])x-api-key\s*:\s*\S+/i,
  },
  {
    category: "cookie header",
    pattern: /(?:^|[^A-Za-z0-9_])(?:cookie|set-cookie)\s*:\s*\S+/i,
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

const LOG_PATTERNS: ReadonlyArray<{
  category: string;
  pattern: RegExp;
}> = [
  {
    category: "shell prompt",
    pattern: /^\$\s+\S+/,
  },
  {
    category: "stdout marker",
    pattern: /^stdout:\s*\S+/i,
  },
  {
    category: "stderr marker",
    pattern: /^stderr:\s*\S+/i,
  },
  {
    category: "timestamped log line",
    pattern:
      /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\s+/,
  },
  {
    category: "log level marker",
    pattern: /^\[(?:INFO|DEBUG|WARN|ERROR)\]\s+\S+/,
  },
  {
    category: "login output",
    pattern: /^Logged in to\s+\S+/i,
  },
];

const PROTECTED_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|[^A-Za-z0-9_])\/(?:Users|home|private|tmp|var|etc|opt|usr|Volumes)(?:\/|$)/,
  /(?:^|[^A-Za-z0-9_])file:\/\/\/(?:Users|home|private|tmp|var|etc|opt|usr|Volumes)(?:\/|$)/,
  /(?:^|[^A-Za-z0-9_])path\s*=\s*\/(?:Users|home|private|tmp|var|etc|opt|usr|Volumes)(?:\/|$)/i,
  /(?:^|[^A-Za-z0-9_])[A-Za-z]:\\/,
  /(?:^|[^A-Za-z0-9_])path\s*=\s*[A-Za-z]:\\/i,
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

function getLineCategory(value: string): string | undefined {
  for (const line of value.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }

    for (const { category, pattern } of SENSITIVE_PATTERNS) {
      if (category.endsWith("header") && pattern.test(trimmedLine)) {
        return category;
      }
    }

    for (const { category, pattern } of LOG_PATTERNS) {
      if (pattern.test(trimmedLine)) {
        return category;
      }
    }
  }

  return undefined;
}

function getUnsafeCategory(
  field: SafeField,
  value: string
): string | undefined {
  if (value.length > SAFE_TEXT_LIMITS[field]) {
    return "length";
  }

  for (const { category, pattern } of SENSITIVE_PATTERNS) {
    if (category.endsWith("header")) {
      continue;
    }
    if (pattern.test(value)) {
      return category;
    }
  }

  const lineCategory = getLineCategory(value);
  if (lineCategory) {
    return lineCategory;
  }

  for (const token of tokenize(value)) {
    const normalized = stripToken(token);
    if (PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) {
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

  if (bead.metadata.projectStatus === "In Progress") {
    return "In Progress";
  }

  if (bead.status === "in_progress") {
    return "In Progress";
  }

  return "Todo";
}

function priorityLabel(priority: Bead["priority"]): string {
  return `P${priority}`;
}

function validateBeadIdField(field: string, value: string): void {
  if (!BEAD_ID_PATTERN.test(value)) {
    throw new Error(`${field}: invalid bead id`);
  }
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
  validateBeadIdField("bead.id", bead.id);

  if (bead.parent !== undefined) {
    validateBeadIdField("parent", bead.parent);
  }

  for (const dependency of bead.dependencies) {
    validateBeadIdField("dependency issue_id", dependency.issue_id);
    validateBeadIdField("dependency depends_on_id", dependency.depends_on_id);
  }

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
    `- Owner: ${bead.metadata.owner}`,
    `- Wave: ${bead.metadata.wave}`,
    `- Parent: ${parent}`,
    `- Active dependencies: ${dependencies}`,
  ]);

  return {
    beadId: bead.id,
    body,
    fields: {
      "Bead ID": bead.id,
      "Bead Type": bead.issue_type,
      Blocked: blocked,
      Owner: bead.metadata.owner,
      Priority: priorityLabel(bead.priority),
      Runner: bead.metadata.runner,
      Size: bead.metadata.size,
      Status: projectStatusFor(bead),
      Wave: bead.metadata.wave,
      Workstream: bead.metadata.workstream,
    },
    title: bead.title,
  };
}
