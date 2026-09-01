import { createPrivateKey, createSecretKey, type KeyObject } from "node:crypto";

const APP_ID = /^[1-9][0-9]{0,19}$/u;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CLIENT_VALUE_PATTERN = /^[\x21-\x7e]+$/u;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
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
const MAX_CLIENT_SECRET_BYTES = 1024;
const MIN_CLIENT_SECRET_BYTES = 32;
const MIN_CLIENT_SECRET_CHARACTERS = 8;
const CREDENTIAL_URL_NAMES = new Set(["POSTGRES_URL", "REDIS_URL"]);
const NON_SECRET_AUTHORITY_NAMES = new Set([
  "CREDENTIAL_KEK_CURRENT_VERSION",
  "GITHUB_STATE_SIGNING_SECRET",
]);
const SECRET_AUTHORITY_NAME =
  /(?:^AUTH_SECRET$|_(?:CREDENTIAL|KEK|KEY|PASSWORD|PASSWD|SECRET|TOKEN)(?:_|$))/u;

type GitHubEnvironment = Readonly<Record<string, string | undefined>>;

export type GitHubAppConfig = Readonly<{
  appId: string;
  appSlug: string;
  clientId: string;
  clientSecret: KeyObject;
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
    "GITHUB_APP_CLIENT_ID",
    "GITHUB_APP_CLIENT_SECRET",
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

  const clientId = environment.GITHUB_APP_CLIENT_ID?.trim() ?? "";
  if (
    !CLIENT_ID.test(clientId) ||
    clientId !== environment.GITHUB_APP_CLIENT_ID
  ) {
    throw new Error("GITHUB_APP_CLIENT_ID must be a canonical client id.");
  }
  const signInClientId = environment.AUTH_GITHUB_ID?.trim();
  if (signInClientId && signInClientId === clientId) {
    throw new Error(
      "GITHUB_APP_CLIENT_ID must be distinct from AUTH_GITHUB_ID."
    );
  }

  const appSlug = environment.GITHUB_APP_SLUG?.trim() ?? "";
  if (!APP_SLUG.test(appSlug)) {
    throw new Error("GITHUB_APP_SLUG must be a canonical GitHub App slug.");
  }

  const privateKey = parsePrivateKey(environment.GITHUB_APP_PRIVATE_KEY ?? "");
  const clientSecretValue = environment.GITHUB_APP_CLIENT_SECRET ?? "";
  const clientSecret = parseClientSecret(clientSecretValue);
  const signInSecret = environment.AUTH_GITHUB_SECRET?.trim();
  if (signInSecret && signInSecret === clientSecretValue.trim()) {
    throw new Error(
      "GITHUB_APP_CLIENT_SECRET must be distinct from AUTH_GITHUB_SECRET."
    );
  }
  const stateSecret = environment.GITHUB_STATE_SIGNING_SECRET ?? "";
  const stateSigningKey = parseStateSigningKey(stateSecret);
  for (const [name, peer] of configuredSecretAuthorities(environment)) {
    if (peer === stateSecret.trim()) {
      throw new Error(
        `GITHUB_STATE_SIGNING_SECRET must be distinct from ${name}.`
      );
    }
  }

  return {
    appId,
    appSlug,
    clientId,
    clientSecret,
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

function configuredSecretAuthorities(
  environment: GitHubEnvironment
): Array<readonly [string, string]> {
  const configured: Array<readonly [string, string]> = [];
  for (const [name, raw] of Object.entries(environment)) {
    if (
      raw === undefined ||
      !ENVIRONMENT_NAME.test(name) ||
      NON_SECRET_AUTHORITY_NAMES.has(name) ||
      (!SECRET_AUTHORITY_NAME.test(name) && !CREDENTIAL_URL_NAMES.has(name))
    ) {
      continue;
    }
    const normalized = raw.trim();
    if (normalized) {
      configured.push([name, normalized]);
    }
  }
  return configured;
}

function parseClientSecret(value: string): KeyObject {
  const bytes = Buffer.from(value, "utf8");
  if (
    value !== value.trim() ||
    !CLIENT_VALUE_PATTERN.test(value) ||
    bytes.length < MIN_CLIENT_SECRET_BYTES ||
    bytes.length > MAX_CLIENT_SECRET_BYTES ||
    new Set(value).size < MIN_CLIENT_SECRET_CHARACTERS
  ) {
    throw new Error(
      `GITHUB_APP_CLIENT_SECRET must be ${MIN_CLIENT_SECRET_BYTES}-${MAX_CLIENT_SECRET_BYTES} printable ASCII bytes with high entropy.`
    );
  }
  try {
    return createSecretKey(bytes);
  } finally {
    bytes.fill(0);
  }
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
  try {
    return createSecretKey(bytes);
  } finally {
    bytes.fill(0);
  }
}
