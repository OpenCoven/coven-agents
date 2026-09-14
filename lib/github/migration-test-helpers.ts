import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const migrations = new URL("../db/migrations/", import.meta.url);
export const POSTGRES_REGEX_REPETITION_LIMIT = 255;

export type Snapshot = Readonly<{
  id: string;
  prevId: string;
  tables: Record<
    string,
    Readonly<{
      columns: Record<string, Readonly<{ notNull: boolean; type: string }>>;
      checkConstraints: Record<
        string,
        Readonly<{ name: string; value: string }>
      >;
      foreignKeys: Record<string, Readonly<{ onDelete: string }>>;
      indexes: Record<string, Readonly<{ isUnique: boolean; where?: string }>>;
      uniqueConstraints: Record<string, Readonly<{ columns: string[] }>>;
    }>
  >;
}>;

type Journal = Readonly<{
  entries: readonly Readonly<{
    breakpoints: boolean;
    idx: number;
    tag: string;
    version: string;
    when: number;
  }>[];
}>;

export function readMigration(name: string): Promise<string> {
  return readFile(new URL(name, migrations), "utf8");
}

export async function readJournal(): Promise<Journal> {
  return JSON.parse(await readMigration("meta/_journal.json")) as Journal;
}

export async function readSnapshot(name: string): Promise<Snapshot> {
  return JSON.parse(await readMigration(name)) as Snapshot;
}

export async function latestSnapshotName(): Promise<string> {
  const last = (await readJournal()).entries.at(-1);
  assert.ok(last, "journal must record at least one migration");
  return `meta/${String(last.idx).padStart(4, "0")}_snapshot.json`;
}

export function snapshotCheckText(snapshot: Snapshot): string {
  return Object.values(snapshot.tables)
    .flatMap((table) => Object.values(table.checkConstraints))
    .map((check) => check.value)
    .join("\n");
}

type Token = Readonly<{
  kind: "word" | "string" | "quoted" | "symbol";
  literal?: Readonly<{ end: number; escape: boolean }>;
  value: string;
}>;
type RegexBoundEntry = Readonly<{ operand: string; bounds: readonly number[] }>;
const TOKEN =
  /--[^\r\n]*|\/\*|\*\/|E'|'|"(?:\\.|""|[^"\\])*"|\$(?:[A-Za-z_]\w*)?\$|[A-Za-z_]\w*|!?~~?\*?|[^\s]/giy;
const REGEX_BOUND = /\\.|\[(?:\\.|[^\]\\])*\]|\{(\d+)(?:,(\d*))?\}/gu;
const JSONPATH_REGEX = /like_regex\s+"((?:[^"\\]|\\.)*)"/giu;

function escapeString(value: string): string {
  return value.replace(
    /\\(?:x([\da-fA-F]{1,2})|u([\da-fA-F]{4})|U([\da-fA-F]{8})|([0-7]{1,3})|([\s\S]))/gu,
    (
      _match: string,
      hex: string | undefined,
      unicode: string | undefined,
      longUnicode: string | undefined,
      octal: string | undefined,
      character: string | undefined
    ) => {
      const encoded = hex ?? unicode ?? longUnicode ?? octal;
      if (encoded !== undefined) {
        return String.fromCodePoint(Number.parseInt(encoded, octal ? 8 : 16));
      }
      assert.ok(character);
      const escapes: Record<string, string> = {
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      return escapes[character] ?? character;
    }
  );
}

function quotedLiteralEnd(
  text: string,
  start: number,
  escapeMode: boolean
): number {
  for (let index = start; index < text.length; index += 1) {
    if (escapeMode && text[index] === "\\") {
      index += 1;
    } else if (text[index] === "'") {
      if (text[index + 1] === "'") {
        index += 1;
      } else {
        return index;
      }
    }
  }
  throw new Error("Unterminated SQL string literal");
}

// A bounded lexer for literal regex operands in our SQL, not an arbitrary SQL
// parser. Computed/dynamic SQL patterns are intentionally outside this gate.
function tokens(text: string): Token[] {
  const result: Token[] = [];
  let offset = 0;
  let commentDepth = 0;
  while (offset < text.length) {
    if (commentDepth > 0) {
      if (text.startsWith("/*", offset)) {
        commentDepth += 1;
        offset += 2;
      } else if (text.startsWith("*/", offset)) {
        commentDepth -= 1;
        offset += 2;
      } else {
        offset += 1;
      }
      continue;
    }
    if (/\s/u.test(text[offset])) {
      offset += 1;
      continue;
    }
    const start = offset;
    TOKEN.lastIndex = offset;
    const match = TOKEN.exec(text);
    assert.ok(match, `Unrecognized SQL token at ${offset}`);
    const [raw] = match;
    offset = TOKEN.lastIndex;
    if (raw === "/*") {
      commentDepth += 1;
      continue;
    }
    if (raw.startsWith("--")) {
      continue;
    }
    if (raw.startsWith("$") && raw.endsWith("$")) {
      const end = text.indexOf(raw, offset);
      assert.ok(end >= 0, "Unterminated SQL dollar literal");
      result.push({ kind: "string", value: text.slice(offset, end) });
      offset = end + raw.length;
    } else if (raw === "'" || /^e'$/iu.test(raw)) {
      const previous = result.at(-1);
      const gap = previous?.literal
        ? text.slice(previous.literal.end, start)
        : "";
      // PostgreSQL continues quotes across LF/CR and -- comments, not block
      // comments or a new E/dollar prefix. The first quote's escape mode persists.
      const continuation =
        raw === "'" &&
        previous?.literal &&
        /[\r\n]/u.test(gap) &&
        /^(?:[ \t\r\n\f\v]|--[^\r\n]*)+$/u.test(gap)
          ? previous
          : undefined;
      const escapeMode =
        /^e'$/iu.test(raw) || continuation?.literal?.escape === true;
      const end = quotedLiteralEnd(text, offset, escapeMode);
      const content = text.slice(offset, end).replaceAll("''", "'");
      const value = escapeMode ? escapeString(content) : content;
      offset = end + 1;
      const literal: Token = {
        kind: "string",
        literal: { end: offset, escape: escapeMode },
        value: continuation ? continuation.value + value : value,
      };
      if (continuation) {
        result[result.length - 1] = literal;
      } else {
        result.push(literal);
      }
    } else if (raw.startsWith('"')) {
      result.push({ kind: "quoted", value: raw.slice(1, -1) });
    } else {
      result.push({
        kind: /^[A-Za-z_]/u.test(raw) ? "word" : "symbol",
        value: raw.toLowerCase(),
      });
    }
  }
  assert.equal(commentDepth, 0, "Unterminated SQL comment");
  return result;
}

function literalOperand(
  stream: readonly Token[],
  start: number
): Token | undefined {
  let index = start;
  let depth = 0;
  while (stream[index]?.kind === "symbol" && stream[index].value === "(") {
    depth += 1;
    index += 1;
  }
  const literal = stream[index];
  if (literal?.kind !== "string") {
    return undefined;
  }
  for (; depth > 0; depth -= 1) {
    index += 1;
    if (stream[index]?.kind !== "symbol" || stream[index].value !== ")") {
      return undefined;
    }
  }
  return literal;
}

function functionOperand(
  stream: readonly Token[],
  start: number,
  separator: string
): Token | undefined {
  let depth = 0;
  for (let index = start + 1; index < stream.length; index += 1) {
    const token = stream[index];
    if (token.kind === "symbol" && token.value === "(") {
      depth += 1;
    } else if (token.kind === "symbol" && token.value === ")") {
      depth -= 1;
      if (depth === 0) {
        return undefined;
      }
    } else if (
      depth === 1 &&
      token.value === separator &&
      token.kind === (separator === "," ? "symbol" : "word")
    ) {
      return literalOperand(stream, index + 1);
    }
  }
  return undefined;
}

function regexOperands(text: string, depth = 0): string[] {
  assert.ok(depth <= 8, "SQL function nesting exceeds regex scanner limit");
  const stream = tokens(text);
  const operands: string[] = [];
  for (const [index, token] of stream.entries()) {
    let operand: Token | undefined;
    if (token.kind === "symbol" && /^!?~\*?$/u.test(token.value)) {
      operand = literalOperand(stream, index + 1);
    } else if (token.kind === "word") {
      if (
        token.value === "like_regex" &&
        stream[index + 1]?.kind === "quoted"
      ) {
        operands.push(stream[index + 1].value);
      } else if (
        token.value === "similar" &&
        stream[index + 1]?.value === "to"
      ) {
        operand = literalOperand(stream, index + 2);
      } else if (["regexp_like", "substring"].includes(token.value)) {
        operand = functionOperand(
          stream,
          index,
          token.value === "substring" ? "from" : ","
        );
      } else if (token.value.startsWith("jsonb_path_")) {
        const path = functionOperand(stream, index, ",");
        if (path?.kind === "string") {
          operands.push(
            ...[...path.value.matchAll(JSONPATH_REGEX)].map(
              (match) => JSON.parse(`"${match[1]}"`) as string
            )
          );
        }
      } else if (
        ["as", "do"].includes(token.value) &&
        stream[index + 1]?.kind === "string"
      ) {
        operands.push(...regexOperands(stream[index + 1].value, depth + 1));
      }
    }
    if (operand?.kind === "string") {
      operands.push(operand.value);
    }
  }
  return operands;
}

export function regexRepetitionBounds(text: string): RegexBoundEntry[] {
  assert.ok(text.length <= 2_000_000, "SQL exceeds regex scanner input limit");
  return regexOperands(text).flatMap((operand) => {
    const bounds = [...operand.matchAll(REGEX_BOUND)]
      .flatMap((bound) => bound.slice(1))
      .filter((bound): bound is string => bound !== undefined && bound !== "")
      .map(Number);
    return bounds.length > 0 ? [{ bounds, operand }] : [];
  });
}

export function excessiveRegexBounds(text: string): RegexBoundEntry[] {
  return regexRepetitionBounds(text).filter((entry) =>
    entry.bounds.some((bound) => bound > POSTGRES_REGEX_REPETITION_LIMIT)
  );
}
