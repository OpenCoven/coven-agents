import "server-only";

import {
  AGENT_RUNNER_LIMITS,
  type CommandEvidence,
  commandEvidenceSchema,
  type FileEvidence,
  fileEvidenceSchema,
  sanitizeEvidencePath,
  sanitizeEvidenceText,
  TEAM_LIMITS,
  type TeamHandoff,
  teamHandoffSchema,
} from "@opencoven/agent-contracts";
import { truncateUtf8 } from "@/lib/runner/evidence";

export const TEAM_HANDOFF_TRUNCATION_MARKER =
  "\n[team handoff truncated for public safety]";

const EVIDENCE_TRUNCATION_MARKER = "\n[evidence truncated for public safety]";
const OPERATIONAL_METADATA_KEY =
  "(?:tenant(?:[-_\\s]?(?:id|metadata))?|provider(?:[-_\\s]?(?:id|metadata|logs?))?|session(?:[-_\\s]?(?:id|metadata))?|command[-_\\s]?id|encrypted(?:[-_\\s]?(?:credential|record|records))?|credentials?(?:[-_\\s]?(?:id|record|records|metadata))?|daytona[-_\\s]?logs|raw[-_\\s]?logs|daytona[-_\\s]?(?:session|command)[-_\\s]?id)";
const operationalMetadataLine = new RegExp(
  String.raw`^(\s*["']?${OPERATIONAL_METADATA_KEY}["']?\s*[:=]\s*).*$`,
  "gimu"
);
const operationalMetadataProperty = new RegExp(
  String.raw`(["']?${OPERATIONAL_METADATA_KEY}["']?\s*:\s*)(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|[^,}\r\n]+)`,
  "gimu"
);

export type BuildTeamHandoffInput = {
  commandEvidence?: readonly unknown[];
  consumedBytes?: number;
  fileEvidence?: readonly unknown[];
  output: string;
  priorHandoffs?: readonly unknown[];
};

export type BuildTeamHandoffInvalidCode =
  | "ambiguous-prior-budget"
  | "handoff-budget-exhausted"
  | "invalid-consumed-byte-budget"
  | "invalid-input"
  | "invalid-prior-handoff";

export type BuildTeamHandoffResult =
  | {
      handoff: TeamHandoff;
      kind: "built";
      serializedBytes: number;
      totalConsumedBytes: number;
    }
  | {
      code: BuildTeamHandoffInvalidCode;
      kind: "invalid";
      message: string;
    };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function serializedBytes(value: unknown): number {
  return byteLength(JSON.stringify(value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isOperationalMetadataKey(value: string): boolean {
  const compact = value.replace(/[-_\s]/gu, "");
  const normalized = compact.toLowerCase();
  const isLogField =
    normalized === "logs" ||
    /[-_\s]logs$/iu.test(value) ||
    /Logs$/u.test(compact) ||
    /^(?:daytona|provider|raw)logs$/u.test(normalized);
  return (
    isLogField ||
    normalized.includes("credential") ||
    normalized.startsWith("encrypted") ||
    /^(?:provider|session|tenant)(?:id|metadata)?$/u.test(normalized) ||
    /^(?:daytona)?(?:command|session)id$/u.test(normalized)
  );
}

function containsOperationalMetadataKey(value: string): boolean {
  const propertyKey = /(?:^|[,{]\s*)["']?([^"'{}[\],:]+?)["']?\s*:/gmu;
  for (const match of value.matchAll(propertyKey)) {
    if (match[1] && isOperationalMetadataKey(match[1])) {
      return true;
    }
  }
  return false;
}

function structuredValueEnd(value: string, start: number): number | null {
  const opening = value[start];
  if (opening !== "{" && opening !== "[") {
    return null;
  }

  const closers = [opening === "{" ? "}" : "]"];
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[") {
      closers.push(character === "{" ? "}" : "]");
      continue;
    }
    if (character === "}" || character === "]") {
      if (closers.at(-1) !== character) {
        return null;
      }
      closers.pop();
      if (closers.length === 0) {
        return index + 1;
      }
    }
  }
  return null;
}

function filterStructuredValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(filterStructuredValue);
  }
  const record = asRecord(value);
  if (!record) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, nestedValue]) => [
      key,
      isOperationalMetadataKey(key)
        ? "[REDACTED]"
        : filterStructuredValue(nestedValue),
    ])
  );
}

function filterStructuredMetadata(value: string): string {
  let output = "";
  let cursor = 0;
  while (cursor < value.length) {
    const objectStart = value.indexOf("{", cursor);
    const arrayStart = value.indexOf("[", cursor);
    const starts = [objectStart, arrayStart].filter(
      (candidateStart) => candidateStart >= 0
    );
    if (starts.length === 0) {
      return output + value.slice(cursor);
    }
    const start = Math.min(...starts);
    output += value.slice(cursor, start);
    const end = structuredValueEnd(value, start);
    if (end === null) {
      const remainder = value.slice(start);
      return (
        output +
        (containsOperationalMetadataKey(remainder) ? "[REDACTED]" : remainder)
      );
    }

    const candidate = value.slice(start, end);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      output += containsOperationalMetadataKey(candidate)
        ? "[REDACTED]"
        : candidate;
      cursor = end;
      continue;
    }
    output += JSON.stringify(filterStructuredValue(parsed));
    cursor = end;
  }
  return output;
}

export function sanitizeTeamText(value: string): string {
  return sanitizeEvidenceText(filterStructuredMetadata(value))
    .replace(operationalMetadataLine, "$1[REDACTED]")
    .replace(operationalMetadataProperty, `$1"[REDACTED]"`);
}

function boundedEvidenceText(value: string, maxLength: number): string {
  return truncateUtf8(
    sanitizeTeamText(value),
    maxLength,
    maxLength,
    EVIDENCE_TRUNCATION_MARKER
  );
}

function normalizeCommand(value: unknown): CommandEvidence | null {
  const candidate = asRecord(value);
  if (
    !candidate ||
    typeof candidate.command !== "string" ||
    !candidate.command.trim() ||
    typeof candidate.stdout !== "string" ||
    typeof candidate.stderr !== "string"
  ) {
    return null;
  }

  const completedAt =
    typeof candidate.completedAt === "string"
      ? candidate.completedAt
      : normalizeTimestamp(candidate.timestamp);
  const parsed = commandEvidenceSchema.safeParse({
    command: boundedEvidenceText(
      candidate.command.trim(),
      AGENT_RUNNER_LIMITS.maxCommandLength
    ),
    ...(completedAt ? { completedAt } : {}),
    exitCode: candidate.exitCode === undefined ? null : candidate.exitCode,
    ...(typeof candidate.startedAt === "string"
      ? { startedAt: candidate.startedAt }
      : {}),
    stderr: boundedEvidenceText(
      candidate.stderr,
      AGENT_RUNNER_LIMITS.maxEventOutputLength
    ),
    stdout: boundedEvidenceText(
      candidate.stdout,
      AGENT_RUNNER_LIMITS.maxEventOutputLength
    ),
  });

  return parsed.success ? parsed.data : null;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return;
  }
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf())
    ? undefined
    : timestamp.toISOString();
}

function normalizeFile(value: unknown): FileEvidence | null {
  const candidate = asRecord(value);
  if (
    !candidate ||
    typeof candidate.path !== "string" ||
    !candidate.path.trim() ||
    (candidate.status !== undefined && candidate.status !== "completed")
  ) {
    return null;
  }
  const operation =
    candidate.operation === "update" ? "modify" : candidate.operation;
  const occurredAt =
    typeof candidate.occurredAt === "string"
      ? candidate.occurredAt
      : normalizeTimestamp(candidate.timestamp);
  const parsed = fileEvidenceSchema.safeParse({
    ...(candidate.byteLength === undefined
      ? {}
      : { byteLength: candidate.byteLength }),
    ...(occurredAt ? { occurredAt } : {}),
    operation,
    path: boundedEvidenceText(
      sanitizeEvidencePath(candidate.path.trim()),
      AGENT_RUNNER_LIMITS.maxPathLength
    ),
  });

  return parsed.success ? parsed.data : null;
}

function invalid(
  code: BuildTeamHandoffInvalidCode,
  message: string
): BuildTeamHandoffResult {
  return { code, kind: "invalid", message };
}

function consumedPriorBytes(
  input: BuildTeamHandoffInput
): number | BuildTeamHandoffResult {
  if (input.consumedBytes !== undefined && input.priorHandoffs !== undefined) {
    return invalid(
      "ambiguous-prior-budget",
      "Provide prior handoffs or consumed bytes, not both."
    );
  }
  if (input.consumedBytes !== undefined) {
    if (
      !Number.isSafeInteger(input.consumedBytes) ||
      input.consumedBytes < 0 ||
      input.consumedBytes > TEAM_LIMITS.maxTotalHandoffLength
    ) {
      return invalid(
        "invalid-consumed-byte-budget",
        "Consumed handoff bytes must be a safe nonnegative aggregate budget."
      );
    }
    return input.consumedBytes;
  }

  let total = 0;
  for (const prior of input.priorHandoffs ?? []) {
    const parsed = teamHandoffSchema.safeParse(prior);
    if (!parsed.success) {
      return invalid(
        "invalid-prior-handoff",
        "A prior handoff failed strict contract validation."
      );
    }
    const bytes = serializedBytes(parsed.data);
    if (bytes > TEAM_LIMITS.maxHandoffLength) {
      return invalid(
        "invalid-prior-handoff",
        "A prior handoff exceeds its serialized byte boundary."
      );
    }
    total += bytes;
    if (total > TEAM_LIMITS.maxTotalHandoffLength) {
      return invalid(
        "handoff-budget-exhausted",
        "Prior handoffs already exceed the aggregate handoff boundary."
      );
    }
  }
  return total;
}

function fitStringField(
  value: string,
  requiredSuffix: string,
  limit: number,
  render: (candidate: string) => TeamHandoff
): string | null {
  if (serializedBytes(render(`${value}${requiredSuffix}`)) <= limit) {
    return `${value}${requiredSuffix}`;
  }
  if (serializedBytes(render(requiredSuffix)) > limit) {
    return null;
  }

  const characters = [...value];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${characters.slice(0, middle).join("")}${requiredSuffix}`;
    if (serializedBytes(render(candidate)) <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${characters.slice(0, low).join("")}${requiredSuffix}`;
}

function compactEvidence(
  commandEvidence: readonly CommandEvidence[],
  fileEvidence: readonly FileEvidence[],
  limit: number
): {
  commandEvidence: CommandEvidence[];
  commandSourceIndexes: number[];
  fileEvidence: FileEvidence[];
} | null {
  const commands = commandEvidence.map((evidence, sourceIndex) => ({
    evidence: {
      ...evidence,
      stderr: "",
      stdout: "",
    },
    sourceIndex,
  }));
  const files = [...fileEvidence];
  const render = (): TeamHandoff => ({
    commandEvidence: commands.map((command) => command.evidence),
    fileEvidence: files,
    output: TEAM_HANDOFF_TRUNCATION_MARKER,
  });

  while (serializedBytes(render()) > limit) {
    if (commands.length === 0 && files.length === 0) {
      return null;
    }
    const commandBytes = commands[0]
      ? serializedBytes(commands[0].evidence)
      : Number.NEGATIVE_INFINITY;
    const fileBytes = files[0]
      ? serializedBytes(files[0])
      : Number.NEGATIVE_INFINITY;
    if (commandBytes >= fileBytes) {
      commands.shift();
    } else {
      files.shift();
    }
  }
  return {
    commandEvidence: commands.map((command) => command.evidence),
    commandSourceIndexes: commands.map((command) => command.sourceIndex),
    fileEvidence: files,
  };
}

function enrichCommandOutput(
  handoff: TeamHandoff,
  source: readonly CommandEvidence[],
  sourceIndexes: readonly number[],
  limit: number
): TeamHandoff {
  let current = handoff;

  for (let index = current.commandEvidence.length - 1; index >= 0; index -= 1) {
    const evidence = current.commandEvidence[index];
    const sourceIndex = sourceIndexes[index];
    const sourceEvidence =
      sourceIndex === undefined ? undefined : source[sourceIndex];
    if (!(evidence && sourceEvidence)) {
      continue;
    }
    for (const field of ["stdout", "stderr"] as const) {
      if (!sourceEvidence[field]) {
        continue;
      }
      const render = (value: string): TeamHandoff => ({
        ...current,
        commandEvidence: current.commandEvidence.map((candidate, position) =>
          position === index ? { ...candidate, [field]: value } : candidate
        ),
      });
      const full = render(sourceEvidence[field]);
      if (serializedBytes(full) <= limit) {
        current = full;
        continue;
      }
      const fitted = fitStringField(
        sourceEvidence[field],
        EVIDENCE_TRUNCATION_MARKER,
        limit,
        render
      );
      if (fitted) {
        current = render(fitted);
      }
    }
  }
  return current;
}

export function buildTeamHandoff(
  input: BuildTeamHandoffInput
): BuildTeamHandoffResult {
  if (!input || typeof input.output !== "string") {
    return invalid("invalid-input", "Team handoff output must be a string.");
  }
  if (
    (input.commandEvidence !== undefined &&
      !Array.isArray(input.commandEvidence)) ||
    (input.fileEvidence !== undefined && !Array.isArray(input.fileEvidence)) ||
    (input.priorHandoffs !== undefined && !Array.isArray(input.priorHandoffs))
  ) {
    return invalid("invalid-input", "Team handoff evidence must be arrays.");
  }

  const priorBytes = consumedPriorBytes(input);
  if (typeof priorBytes !== "number") {
    return priorBytes;
  }
  const availableBytes = Math.min(
    TEAM_LIMITS.maxHandoffLength,
    TEAM_LIMITS.maxTotalHandoffLength - priorBytes
  );
  const minimum = serializedBytes({
    commandEvidence: [],
    fileEvidence: [],
    output: TEAM_HANDOFF_TRUNCATION_MARKER,
  });
  if (availableBytes < minimum) {
    return invalid(
      "handoff-budget-exhausted",
      "The aggregate handoff budget cannot hold a public-safe result."
    );
  }

  const commandEvidence = (input.commandEvidence ?? [])
    .slice(-AGENT_RUNNER_LIMITS.maxCommandResults)
    .map(normalizeCommand)
    .filter((value): value is CommandEvidence => value !== null);
  const fileEvidence = (input.fileEvidence ?? [])
    .slice(-AGENT_RUNNER_LIMITS.maxFileOperations)
    .map(normalizeFile)
    .filter((value): value is FileEvidence => value !== null);
  const output = sanitizeTeamText(input.output);
  const full = teamHandoffSchema.parse({
    commandEvidence,
    fileEvidence,
    output: truncateUtf8(
      output,
      TEAM_LIMITS.maxHandoffLength,
      TEAM_LIMITS.maxHandoffLength,
      TEAM_HANDOFF_TRUNCATION_MARKER
    ),
  });

  let handoff = full;
  if (serializedBytes(handoff) > availableBytes) {
    const compact = compactEvidence(
      commandEvidence,
      fileEvidence,
      availableBytes
    );
    if (!compact) {
      return invalid(
        "handoff-budget-exhausted",
        "The aggregate handoff budget cannot hold bounded evidence."
      );
    }
    const render = (candidateOutput: string): TeamHandoff => ({
      commandEvidence: compact.commandEvidence,
      fileEvidence: compact.fileEvidence,
      output: candidateOutput,
    });
    const fittedOutput = fitStringField(
      output,
      TEAM_HANDOFF_TRUNCATION_MARKER,
      availableBytes,
      render
    );
    if (fittedOutput === null) {
      return invalid(
        "handoff-budget-exhausted",
        "The aggregate handoff budget cannot hold a public-safe result."
      );
    }
    handoff = enrichCommandOutput(
      render(fittedOutput),
      commandEvidence,
      compact.commandSourceIndexes,
      availableBytes
    );
  }

  const parsed = teamHandoffSchema.safeParse(handoff);
  const bytes = parsed.success
    ? serializedBytes(parsed.data)
    : Number.MAX_VALUE;
  if (!parsed.success || bytes > availableBytes) {
    return invalid(
      "invalid-input",
      "The bounded team handoff failed strict contract validation."
    );
  }
  return {
    handoff: parsed.data,
    kind: "built",
    serializedBytes: bytes,
    totalConsumedBytes: priorBytes + bytes,
  };
}
