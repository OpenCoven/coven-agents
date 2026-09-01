import { createPrivateKey, createSecretKey, type KeyObject } from "node:crypto";

const APP_ID = /^[1-9][0-9]{0,19}$/u;
const APP_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
const PRIVATE_KEY_BEGIN = "-----BEGIN";
const PRIVATE_KEY_HEADERS = [
  `${PRIVATE_KEY_BEGIN} PRIVATE KEY-----`,
  `${PRIVATE_KEY_BEGIN} RSA PRIVATE KEY-----`,
] as const;
const MAX_PRIVATE_KEY_BYTES = 16_384;
const MAX_STATE_SECRET_BYTES = 1024;
const MIN_STATE_SECRET_BYTES = 32;
const MIN_STATE_SECRET_CHARACTERS = 16;
const STATE_SECRET_PEERS = [
  "AUTH_SECRET",
  "ABUSE_KEY_SECRET",
  "CRON_SECRET",
  "OPERATOR_DIAGNOSTIC_TOKEN",
  "RUNNER_MANUAL_RECONCILE_SECRET",
] as const;

type GitHubEnvironment = Readonly<Record<string, string | undefined>>;

export type GitHubAppConfig = Readonly<{
  appId: string;
  appSlug: string;
  enabled: true;
  privateKey: KeyObject;
  stateSigningKey: KeyObject;
}>;

export type GitHubEnvironmentState =
  | Readonly<{ enabled: false }>
  | GitHubAppConfig;

export function githubTeamsEnabled(
  env: Readonly<{ GITHUB_TEAMS_ENABLED?: string }>
): boolean {
  const configured = env.GITHUB_TEAMS_ENABLED;
  if (
    configured === undefined ||
    configured.trim() === "" ||
    configured === "off"
  ) {
    return false;
  }
  if (configured === "on") {
    return true;
  }
  throw new Error(
    'GITHUB_TEAMS_ENABLED must be exactly "on" or "off" when configured.'
  );
}

export function validateGitHubEnvironment(
  environment: GitHubEnvironment
): GitHubEnvironmentState {
  if (!githubTeamsEnabled(environment)) {
    return { enabled: false };
  }

  const missing = [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_SLUG",
    "GITHUB_STATE_SIGNING_SECRET",
  ].filter((name) => !environment[name]?.trim());
  if (missing.length > 0) {
    throw new Error(
      `GitHub teams requires nonblank environment variables: ${missing.join(", ")}.`
    );
  }

  const appId = environment.GITHUB_APP_ID?.trim() ?? "";
  if (!APP_ID.test(appId)) {
    throw new Error(
      "GITHUB_APP_ID must be a canonical positive decimal identifier."
    );
  }

  const appSlug = environment.GITHUB_APP_SLUG?.trim() ?? "";
  if (!APP_SLUG.test(appSlug)) {
    throw new Error("GITHUB_APP_SLUG must be a canonical GitHub App slug.");
  }

  const privateKey = parsePrivateKey(environment.GITHUB_APP_PRIVATE_KEY ?? "");
  const stateSecret = environment.GITHUB_STATE_SIGNING_SECRET ?? "";
  const stateSigningKey = parseStateSigningKey(stateSecret);
  for (const name of STATE_SECRET_PEERS) {
    const peer = environment[name]?.trim();
    if (peer && peer === stateSecret) {
      throw new Error(
        `GITHUB_STATE_SIGNING_SECRET must be distinct from ${name}.`
      );
    }
  }

  return {
    appId,
    appSlug,
    enabled: true,
    privateKey,
    stateSigningKey,
  };
}

export function githubAppConfig(
  environment: GitHubEnvironment = process.env
): GitHubAppConfig {
  const state = validateGitHubEnvironment(environment);
  if (!state.enabled) {
    throw new Error("GitHub teams are disabled.");
  }
  return state;
}

function parsePrivateKey(value: string): KeyObject {
  const normalized = value.trim();
  if (
    Buffer.byteLength(normalized, "utf8") > MAX_PRIVATE_KEY_BYTES ||
    !PRIVATE_KEY_HEADERS.some((header) => normalized.startsWith(header))
  ) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY must contain a bounded PKCS#8 or RSA private key."
    );
  }

  let key: KeyObject;
  try {
    key = createPrivateKey(normalized);
  } catch {
    // biome-ignore lint/style/useErrorCause: key parser errors can include fragments of the private key
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY must contain a parseable RSA private key."
    );
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("GITHUB_APP_PRIVATE_KEY must be an RSA private key.");
  }
  return key;
}

function parseStateSigningKey(value: string): KeyObject {
  const bytes = Buffer.from(value, "utf8");
  if (
    value !== value.trim() ||
    bytes.length < MIN_STATE_SECRET_BYTES ||
    bytes.length > MAX_STATE_SECRET_BYTES ||
    new Set(value).size < MIN_STATE_SECRET_CHARACTERS
  ) {
    throw new Error(
      `GITHUB_STATE_SIGNING_SECRET must be ${MIN_STATE_SECRET_BYTES}-${MAX_STATE_SECRET_BYTES} UTF-8 bytes with high entropy.`
    );
  }
  return createSecretKey(bytes);
}
