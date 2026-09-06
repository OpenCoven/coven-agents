import "server-only";

import {
  type DaytonaConfig,
  DaytonaNotFoundError,
  Image,
  SnapshotState,
} from "@daytona/sdk";
import {
  harnessInstallSpecifier,
  SUPPORTED_HARNESS_SPECS,
} from "@opencoven/harness";
import type { DaytonaSnapshotConfiguration } from "./config";

export {
  DAYTONA_DEFAULT_API_URL,
  DAYTONA_DEFAULT_TARGET,
  type DaytonaSnapshotConfiguration,
  daytonaSnapshotConfiguration,
} from "./config";

export const DAYTONA_COPILOT_IMAGE_BASE = "node:22-bookworm-slim";
/**
 * Snapshots are immutable and are never recreated under an existing name, so
 * this generation counter is part of the pin: bumping any harness
 * `installVersion` without bumping this leaves the old CLI running.
 */
export const DAYTONA_COPILOT_SNAPSHOT_NAME = "coven-agents-copilot-2";
export const PNPM_VERSION = "10.32.1";
export const WORKSPACE_DIRECTORY = "/workspace";

const SENSITIVE_LOG_VALUE =
  /\b(?:api[-_]?key|token|secret|password|credential)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/giu;
const AUTHORIZATION_HEADER_VALUE =
  /(^|[^A-Za-z0-9-])(authorization)([ \t]*:[ \t]*)[^\r\n]*/gimu;
const MAX_MARKER_WHITESPACE = 32;
const AUTHORIZATION_MARKER = new RegExp(
  `(^|[^A-Za-z0-9-])(authorization)([ \\t]{0,${MAX_MARKER_WHITESPACE}}:[ \\t]{0,${MAX_MARKER_WHITESPACE}})`,
  "giu"
);
const SECRET_KEY_MARKER = new RegExp(
  `(^|[^A-Za-z0-9_])(api[-_]?key|token|secret|password|credential)(\\s{0,${MAX_MARKER_WHITESPACE}}[:=]\\s{0,${MAX_MARKER_WHITESPACE}})`,
  "giu"
);
const AUTH_SCHEME_MARKER = /(^|[^A-Za-z0-9-])(bearer|basic)([ \t]+)/giu;
const PENDING_AUTH_SCHEME_MARKER = /(^|[^A-Za-z0-9-])(bearer|basic)$/giu;
const PENDING_AUTHORIZATION_MARKER =
  /(^|[^A-Za-z0-9-])(authorization)([ \t]+)/giu;
const PENDING_SECRET_KEY_MARKER =
  /(^|[^A-Za-z0-9_])(api[-_]?key|token|secret|password|credential)(\s+)/giu;
const MARKER_NAMES = [
  "authorization",
  "api-key",
  "api_key",
  "apikey",
  "token",
  "secret",
  "password",
  "credential",
  "bearer",
  "basic",
] as const;

/**
 * The longest supported marker is 78 characters (authorization plus bounded
 * whitespace and a separator). Longer whitespace runs fail closed as soon as
 * they start. Retaining 96 characters leaves room for its boundary and lets
 * ordinary output stream without waiting for line endings.
 */
export const DAYTONA_BUILD_LOG_LOOKBEHIND_SIZE = 96;

export type DaytonaSnapshot = Readonly<{
  name: string;
  state: string;
}>;

export type DaytonaSnapshotService = Readonly<{
  create: (
    parameters: Readonly<{
      image: Image;
      name: string;
      resources: Readonly<{ cpu: number; disk: number; memory: number }>;
    }>,
    options: Readonly<{ onLogs: (chunk: string) => void }>
  ) => Promise<DaytonaSnapshot>;
  get: (name: string) => Promise<DaytonaSnapshot>;
}>;

export type DaytonaSnapshotProvisioningDependencies = Readonly<{
  image?: Image;
  log: (message: string) => void;
  snapshot: DaytonaSnapshotService;
}>;

export type DaytonaBuildLogSanitizer = Readonly<{
  flush: () => string;
  write: (chunk: string) => string;
}>;

type SensitiveMarker = Readonly<{
  index: number;
  replacement: string;
}>;

export function daytonaClientConfiguration(
  configuration: DaytonaSnapshotConfiguration
): DaytonaConfig {
  return {
    apiKey: configuration.apiKey,
    apiUrl: configuration.apiUrl,
    target: configuration.target,
  };
}

/**
 * The `package@version` arguments for every harness baked into the snapshot,
 * in registry order. Derived from the registry pins, so the image can never
 * install a version other than the one harness discovery reports.
 */
export function daytonaHarnessInstallSpecifiers(): readonly string[] {
  return SUPPORTED_HARNESS_SPECS.map((spec) => harnessInstallSpecifier(spec));
}

export function createDaytonaCopilotImage(): Image {
  const harnesses = daytonaHarnessInstallSpecifiers().join(" ");
  return Image.base(DAYTONA_COPILOT_IMAGE_BASE)
    .runCommands(
      `npm install --global pnpm@${PNPM_VERSION} ${harnesses}`,
      `mkdir --parents ${WORKSPACE_DIRECTORY}`
    )
    .workdir(WORKSPACE_DIRECTORY);
}

export function createDaytonaSnapshotDefinition(
  configuration: Pick<DaytonaSnapshotConfiguration, "snapshotName">
): Readonly<{ image: Image; name: string }> {
  return {
    image: createDaytonaCopilotImage(),
    name: configuration.snapshotName,
  };
}

export function sanitizeDaytonaBuildLog(chunk: string, apiKey: string): string {
  return chunk
    .replaceAll(apiKey, "[REDACTED]")
    .replace(SENSITIVE_LOG_VALUE, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      return `${match.slice(0, match.indexOf(separator) + 1)} [REDACTED]`;
    })
    .replace(
      AUTHORIZATION_HEADER_VALUE,
      (_match, prefix: string, headerName: string, separator: string) =>
        `${prefix}${headerName}${separator}[REDACTED]`
    );
}

function earliestMarker(
  current: SensitiveMarker | undefined,
  candidate: SensitiveMarker | undefined
): SensitiveMarker | undefined {
  if (!candidate || (current && current.index <= candidate.index)) {
    return current;
  }
  return candidate;
}

function markerFromPattern(
  text: string,
  pattern: RegExp
): SensitiveMarker | undefined {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  if (!match || match.index === undefined) {
    return undefined;
  }

  const [, prefix = "", name = "", separator = ""] = match;
  return {
    index: match.index + prefix.length,
    replacement: `${name}${separator.trimEnd()} [REDACTED]`,
  };
}

function findSensitiveMarker(
  text: string,
  apiKey: string
): SensitiveMarker | undefined {
  let marker =
    apiKey.length > 0
      ? (() => {
          const index = text.indexOf(apiKey);
          return index === -1
            ? undefined
            : { index, replacement: "[REDACTED]" };
        })()
      : undefined;

  marker = earliestMarker(
    marker,
    markerFromPattern(text, AUTHORIZATION_MARKER)
  );
  marker = earliestMarker(marker, markerFromPattern(text, SECRET_KEY_MARKER));
  marker = earliestMarker(marker, markerFromPattern(text, AUTH_SCHEME_MARKER));
  marker = earliestMarker(
    marker,
    markerFromPattern(text, PENDING_AUTH_SCHEME_MARKER)
  );
  marker = earliestMarker(
    marker,
    markerFromPattern(text, PENDING_AUTHORIZATION_MARKER)
  );
  return earliestMarker(
    marker,
    markerFromPattern(text, PENDING_SECRET_KEY_MARKER)
  );
}

function isMarkerBoundary(
  text: string,
  index: number,
  pattern: RegExp
): boolean {
  const previous = text[index - 1];
  return index === 0 || !pattern.test(previous);
}

function possibleMarkerSuffixLength(text: string, apiKey: string): number {
  let longest = 0;
  const lowercaseText = text.toLowerCase();

  for (const markerName of MARKER_NAMES) {
    for (let length = 1; length <= markerName.length; length += 1) {
      const suffix = markerName.slice(0, length);
      if (
        lowercaseText.endsWith(suffix) &&
        isMarkerBoundary(text, text.length - suffix.length, /[A-Za-z0-9-]/u)
      ) {
        longest = Math.max(longest, suffix.length);
      }
    }
  }

  const keyPrefix =
    /(?:^|[^A-Za-z0-9_])(api[-_]?key|token|secret|password|credential)[ \t]{0,32}(?:[:=][ \t]{0,32})?$/iu.exec(
      text
    );
  if (keyPrefix?.index !== undefined) {
    longest = Math.max(
      longest,
      keyPrefix[0].length - (keyPrefix[1]?.length ?? 0)
    );
  }

  const authorizationPrefix =
    /(?:^|[^A-Za-z0-9-])authorization[ \t]{0,32}(?::[ \t]{0,32})?$/iu.exec(
      text
    );
  if (authorizationPrefix?.index !== undefined) {
    longest = Math.max(
      longest,
      authorizationPrefix[0].length - (authorizationPrefix[1]?.length ?? 0)
    );
  }

  const schemePrefix = /(?:^|[^A-Za-z0-9-])(?:bearer|basic)[ \t]*$/iu.exec(
    text
  );
  if (schemePrefix?.index !== undefined) {
    longest = Math.max(
      longest,
      schemePrefix[0].length - (schemePrefix[1]?.length ?? 0)
    );
  }

  for (let length = 1; length < apiKey.length; length += 1) {
    if (text.endsWith(apiKey.slice(0, length))) {
      longest = Math.max(longest, length);
    }
  }
  return longest;
}

/**
 * The Daytona SDK trims every callback chunk, so callbacks cannot be treated
 * as log records. This retains only enough text to recognize a split marker.
 * Once one is found, the remainder is untrustworthy and is never emitted.
 */
export function createDaytonaBuildLogSanitizer(
  apiKey: string
): DaytonaBuildLogSanitizer {
  let buffered = "";
  let suppressed = false;
  const lookbehind = Math.max(
    DAYTONA_BUILD_LOG_LOOKBEHIND_SIZE,
    apiKey.length - 1
  );

  function redactMarker(text: string): string | undefined {
    const marker = findSensitiveMarker(text, apiKey);
    if (!marker) {
      return undefined;
    }
    suppressed = true;
    buffered = "";
    return `${text.slice(0, marker.index)}${marker.replacement}`;
  }

  return {
    flush() {
      if (suppressed) {
        return "";
      }

      const redacted = redactMarker(buffered);
      if (redacted) {
        return redacted;
      }

      const safeLength =
        buffered.length - possibleMarkerSuffixLength(buffered, apiKey);
      const remainder = buffered.slice(0, safeLength);
      buffered = "";
      return remainder;
    },
    write(chunk) {
      if (suppressed || !chunk) {
        return "";
      }

      const text = buffered + chunk;
      const redacted = redactMarker(text);
      if (redacted) {
        return redacted;
      }

      const safeLength = Math.max(0, text.length - lookbehind);
      buffered = text.slice(safeLength);
      return text.slice(0, safeLength);
    },
  };
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof DaytonaNotFoundError ||
    (typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404)
  );
}

function snapshotState(state: string): string {
  return Object.values(SnapshotState).includes(
    state as (typeof SnapshotState)[keyof typeof SnapshotState]
  )
    ? state
    : "unknown";
}

/**
 * Creates an immutable, versioned snapshot only when its name is unused.
 * It never activates, deletes, or otherwise changes existing snapshots.
 */
export async function provisionDaytonaSnapshot(
  configuration: DaytonaSnapshotConfiguration,
  dependencies: DaytonaSnapshotProvisioningDependencies
): Promise<DaytonaSnapshot> {
  let snapshotAlreadyExists = false;
  try {
    await dependencies.snapshot.get(configuration.snapshotName);
    snapshotAlreadyExists = true;
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new Error(
        `Unable to determine whether Daytona snapshot "${configuration.snapshotName}" exists.`,
        { cause: error }
      );
    }
  }
  if (snapshotAlreadyExists) {
    throw new Error(
      `Daytona snapshot "${configuration.snapshotName}" already exists; refusing to recreate it.`
    );
  }

  const logSanitizer = createDaytonaBuildLogSanitizer(configuration.apiKey);
  try {
    await dependencies.snapshot.create(
      {
        image: dependencies.image ?? createDaytonaCopilotImage(),
        name: configuration.snapshotName,
        // Resources belong here and nowhere else. Daytona applies its own
        // defaults (1 vCPU / 1 GiB / 3 GiB) to a snapshot created without
        // them, and `CreateSandboxFromSnapshotParams` carries no resources
        // field, so a sandbox can never ask for more than its snapshot has.
        // Omitting this is what left every sandbox below policy.
        resources: configuration.resources,
      },
      {
        onLogs: (chunk) => {
          const completeLines = logSanitizer.write(chunk);
          if (completeLines) {
            dependencies.log(completeLines);
          }
        },
      }
    );
  } catch (error) {
    throw new Error(
      `Failed to create Daytona snapshot "${configuration.snapshotName}".`,
      { cause: error }
    );
  } finally {
    const remainder = logSanitizer.flush();
    if (remainder) {
      dependencies.log(remainder);
    }
  }

  let snapshot: DaytonaSnapshot;
  try {
    snapshot = await dependencies.snapshot.get(configuration.snapshotName);
  } catch (error) {
    throw new Error(
      `Unable to verify Daytona snapshot "${configuration.snapshotName}" after creation.`,
      { cause: error }
    );
  }

  if (
    snapshot.name !== configuration.snapshotName ||
    snapshot.state !== SnapshotState.ACTIVE
  ) {
    throw new Error(
      `Daytona snapshot "${configuration.snapshotName}" is not active after creation (state: ${snapshotState(snapshot.state)}).`
    );
  }
  return snapshot;
}
