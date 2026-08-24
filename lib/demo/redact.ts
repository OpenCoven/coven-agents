import {
  type DemoTranscript,
  sanitizeEvidenceText,
} from "@opencoven/agent-contracts";

export function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") {
    return sanitizeEvidenceText(value, secrets) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, secrets)) as T;
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactDeep(item, secrets),
      ])
    ) as T;
  }
  return value;
}

export function redactTranscript(
  transcript: DemoTranscript,
  secrets: Iterable<string>
): DemoTranscript {
  const nonemptySecrets = Array.from(secrets).filter(Boolean);
  return redactDeep(transcript, nonemptySecrets);
}

export function assertNoSecrets(
  transcript: DemoTranscript,
  secrets: Iterable<string>
): void {
  const serialized = JSON.stringify(transcript);
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) {
      throw new Error("Demo transcript contains a provided secret.");
    }
  }
  if (sanitizeEvidenceText(serialized) !== serialized) {
    throw new Error("Demo transcript contains sanitizer-recognized evidence.");
  }
}
