const REDACTED = "[REDACTED]";
const ENVIRONMENT_OUTPUT_REDACTED = "[environment output redacted]";

const doubleQuotedValue = String.raw`"(?:\\[^\r\n]|[^"\\\r\n])*"`;
const singleQuotedValue = String.raw`'(?:\\[^\r\n]|[^'\\\r\n])*'`;
const secretValue = String.raw`(?:${doubleQuotedValue}|${singleQuotedValue}|[^\s,;\r\n]+)`;
const structuredSensitiveKey =
  "(?=[A-Za-z0-9_.-]*(?:token|secret|session|cookie|password|api[-_.]?key|apikey|access[-_.]?key|accesskey|private[-_.]?key|privatekey|credential|authorization))[A-Za-z_][A-Za-z0-9_.-]*";

const environmentAssignment = new RegExp(
  String.raw`\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*${secretValue}`,
  "gu"
);
const objectPropertyPrefix = new RegExp(
  String.raw`(?:[,{]\s*)(["']?)(${structuredSensitiveKey})\1\s*:\s*`,
  "gimu"
);
const yamlProperty =
  /^([\t ]*(?:-[\t ]+)?(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\2[\t ]*:[\t ]*)(.*)$/u;
const secretCliOption =
  /(--[a-z0-9-]*(?:token|secret|password|api[-_]?key|access[-_]?key|private[-_]?key|credential)[a-z0-9-]*\s*(?:=|\s+))(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/giu;
const authorizationHeader = /\b((?:proxy-)?authorization\s*:\s*)[^\r\n"']+/giu;
const apiKeyHeader =
  /\b((?:x[-_])?(?:api[-_]?key|auth[-_]?token|access[-_]?token)\s*:\s*)[^\r\n"']+/giu;
const bearerValue = /\b(Bearer\s+)[^\s"'`,;]+/giu;
const cookieHeader = /\b((?:set-)?cookie\s*:\s*)[^\r\n]+/giu;
const credentialUrl = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@?#]+@/giu;
const jwtValue = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const privateKeyBlock =
  /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gu;
const doubleQuotedUnixHomeRoot = /"\/(?:Users|home)\/[^/\r\n"]+"/gu;
const singleQuotedUnixHomeRoot = /'\/(?:Users|home)\/[^/\r\n']+'/gu;
const backtickQuotedUnixHomeRoot = /`\/(?:Users|home)\/[^/\r\n`]+`/gu;
const doubleQuotedWindowsHomeRoot = /"(?:[A-Za-z]:\\)?Users\\[^\\\r\n"]+"/giu;
const singleQuotedWindowsHomeRoot = /'(?:[A-Za-z]:\\)?Users\\[^\\\r\n']+'/giu;
const backtickQuotedWindowsHomeRoot = /`(?:[A-Za-z]:\\)?Users\\[^\\\r\n`]+`/giu;
const unixHomePath = /(^|[^A-Za-z0-9._-])\/(?:Users|home)\/[^/\r\n]+(?=\/)/gu;
const windowsHomePath =
  /(^|[^A-Za-z0-9._-])(?:[A-Za-z]:\\)?Users\\[^\\\r\n]+(?=\\)/giu;
const unixHomeRoot =
  /(^|[^A-Za-z0-9._-])\/(?:Users|home)\/[^/\s),;:]+(?=$|[\s),;:])/gu;
const windowsHomeRoot =
  /(^|[^A-Za-z0-9._-])(?:[A-Za-z]:\\)?Users\\[^\\\s),;:]+(?=$|[\s),;:])/giu;
const ESCAPE = String.fromCodePoint(0x1b);
const BELL = String.fromCodePoint(0x07);
const terminalControlSequence = new RegExp(
  `${ESCAPE}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BELL}]*(?:${BELL}|${ESCAPE}\\\\))`,
  "gu"
);

const providerKeyPatterns = [
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{30,}\b/gu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
  /\b(?:npm_|pypi-)[A-Za-z0-9_-]{20,}\b/gu,
  /\bhf_[A-Za-z0-9]{20,}\b/gu,
  /\bdop_v1_[A-Za-z0-9]{20,}\b/gu,
  /\bya29\.[A-Za-z0-9._-]{20,}\b/gu,
];

function isSensitiveKey(value: string): boolean {
  const key = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .toUpperCase();
  const compactKey = key.replaceAll("_", "");
  return [
    "TOKEN",
    "SECRET",
    "SESSION",
    "COOKIE",
    "PASSWORD",
    "API_KEY",
    "ACCESS_KEY",
    "PRIVATE_KEY",
    "CREDENTIAL",
    "AUTHORIZATION",
  ].some(
    (fragment) =>
      key.includes(fragment) ||
      compactKey.includes(fragment.replaceAll("_", ""))
  );
}

function quotedValueEnd(value: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return index + 1;
    }
  }
  return value.length;
}

function structuredCollectionEnd(value: string, start: number): number {
  const closers = value[start] === "{" ? ["}"] : ["]"];
  let quote: string | null = null;
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
    if (character === "{") {
      closers.push("}");
      continue;
    }
    if (character === "[") {
      closers.push("]");
      continue;
    }
    if (character === closers.at(-1)) {
      closers.pop();
      if (closers.length === 0) {
        return index + 1;
      }
    }
  }

  return value.length;
}

function structuredValueEnd(value: string, start: number): number {
  const first = value[start];
  if (first === '"' || first === "'") {
    return quotedValueEnd(value, start, first);
  }
  if (first === "{" || first === "[") {
    return structuredCollectionEnd(value, start);
  }

  let index = start;
  while (
    index < value.length &&
    value[index] !== "," &&
    value[index] !== "}" &&
    value[index] !== "\r" &&
    value[index] !== "\n"
  ) {
    index += 1;
  }
  return index;
}

function redactStructuredProperties(value: string): string {
  let cursor = 0;
  let sanitized = "";
  objectPropertyPrefix.lastIndex = 0;

  for (
    let match = objectPropertyPrefix.exec(value);
    match;
    match = objectPropertyPrefix.exec(value)
  ) {
    const key = match[2] ?? "";
    if (!isSensitiveKey(key)) {
      continue;
    }
    const start = objectPropertyPrefix.lastIndex;
    const end = structuredValueEnd(value, start);
    sanitized += `${value.slice(cursor, start)}${REDACTED}`;
    cursor = end;
    objectPropertyPrefix.lastIndex = end;
  }

  return cursor === 0 ? value : `${sanitized}${value.slice(cursor)}`;
}

function yamlIndent(value: string): number {
  return /^([\t ]*)/u.exec(value)?.[1]?.length ?? 0;
}

function redactYamlProperties(value: string): string {
  const lines = value.split("\n");
  const sanitized: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = yamlProperty.exec(line);
    const key = match?.[3] ?? "";
    if (!match || !isSensitiveKey(key)) {
      sanitized.push(line);
      continue;
    }

    sanitized.push(`${match[1]}${REDACTED}`);
    const inlineValue = (match[4] ?? "").trim();
    const blockValue = inlineValue === "" || /^[|>][+-]?$/u.test(inlineValue);
    if (!blockValue) {
      continue;
    }

    const parentIndent = yamlIndent(line);
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      if (next.trim() && yamlIndent(next) <= parentIndent) {
        break;
      }
      index += 1;
    }
  }

  return sanitized.join("\n");
}

function redactSensitiveAssignments(value: string): string {
  const assignmentsRedacted = value.replace(
    environmentAssignment,
    (match, key: string) => (isSensitiveKey(key) ? `${key}=${REDACTED}` : match)
  );
  return redactYamlProperties(redactStructuredProperties(assignmentsRedacted));
}

function isEnvironmentAssignment(line: string): boolean {
  return /^(?:(?:export|declare -x)\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)$/u.test(
    line.trim()
  );
}

function redactEnvironmentDumps(value: string): string {
  const lines = value.split(/\r?\n/u);
  const sanitized: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!isEnvironmentAssignment(lines[index] ?? "")) {
      sanitized.push(lines[index] ?? "");
      index += 1;
      continue;
    }

    let end = index;
    while (isEnvironmentAssignment(lines[end] ?? "")) {
      end += 1;
    }
    if (end - index >= 2) {
      sanitized.push(ENVIRONMENT_OUTPUT_REDACTED);
    } else {
      sanitized.push(...lines.slice(index, end));
    }
    index = end;
  }

  return sanitized.join("\n");
}

function removeUnsafeControlCharacters(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        character === "\t" ||
        character === "\n" ||
        character === "\r" ||
        (codePoint >= 0x20 &&
          codePoint !== 0x7f &&
          (codePoint < 0x80 || codePoint >= 0xa0))
      );
    })
    .join("");
}

/**
 * Removes credentials from textual evidence before it reaches persistence or
 * event streams. Callers can provide process-local secrets that have no
 * recognizable provider format.
 */
export function sanitizeEvidenceText(
  value: string,
  additionalSecrets: Iterable<string> = []
): string {
  const withoutTerminalControls = removeUnsafeControlCharacters(
    value.replace(terminalControlSequence, "")
  );
  let sanitized = redactEnvironmentDumps(
    withoutTerminalControls.replace(privateKeyBlock, "[PRIVATE KEY REDACTED]")
  );
  for (const secret of additionalSecrets) {
    if (secret) {
      sanitized = sanitized.replaceAll(secret, REDACTED);
    }
  }
  sanitized = redactSensitiveAssignments(
    sanitized
      .replace(authorizationHeader, `$1${REDACTED}`)
      .replace(apiKeyHeader, `$1${REDACTED}`)
      .replace(cookieHeader, `$1${REDACTED}`)
      .replace(credentialUrl, `$1${REDACTED}@`)
      .replace(jwtValue, REDACTED)
      .replace(bearerValue, `$1${REDACTED}`)
  ).replace(secretCliOption, `$1${REDACTED}`);
  for (const pattern of providerKeyPatterns) {
    sanitized = sanitized.replace(pattern, REDACTED);
  }
  return sanitized
    .replace(doubleQuotedUnixHomeRoot, '"~"')
    .replace(singleQuotedUnixHomeRoot, "'~'")
    .replace(backtickQuotedUnixHomeRoot, "`~`")
    .replace(doubleQuotedWindowsHomeRoot, '"~"')
    .replace(singleQuotedWindowsHomeRoot, "'~'")
    .replace(backtickQuotedWindowsHomeRoot, "`~`")
    .replace(unixHomePath, "$1~")
    .replace(windowsHomePath, "$1~")
    .replace(unixHomeRoot, "$1~")
    .replace(windowsHomeRoot, "$1~");
}

export function sanitizeEvidencePath(value: string): string {
  return sanitizeEvidenceText(value);
}
