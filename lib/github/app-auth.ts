import "server-only";

import { type KeyObject, sign } from "node:crypto";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/u;
const NODE_ID = /^[A-Za-z0-9_=-]{1,256}$/u;
const PERMISSION_NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const REQUEST_ID = /^[A-Za-z0-9:-]{1,128}$/u;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PAGES = 10;
export const GITHUB_MAX_REPOSITORIES = 16;
const MAX_INSTALLATION_TOKEN_BYTES = 4096;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type PermissionLevel = "admin" | "read" | "write";
type JsonObject = Record<string, unknown>;

export type GitHubInstallation = Readonly<{
  account: Readonly<{
    id: string;
    login: string;
    type: "Organization" | "User";
  }>;
  appId: string;
  appSlug: string;
  id: string;
  permissions: Readonly<Record<string, PermissionLevel>>;
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}>;

export type GitHubRepository = Readonly<{
  id: string;
  name: string;
  nodeId: string;
  owner: string;
}>;

export type GitHubRepositorySelection = Readonly<{
  repositories: readonly GitHubRepository[];
  repositorySelection: "all" | "selected";
}>;

export type GitHubAppClient = Readonly<{
  getInstallation: (installationId: string) => Promise<GitHubInstallation>;
  listInstallationRepositories: (
    installationId: string,
    repositoryIds?: readonly string[]
  ) => Promise<GitHubRepositorySelection>;
}>;

export class GitHubProviderError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    code: string,
    options: Readonly<{
      requestId?: string | null;
      retryable: boolean;
      status: number;
    }>
  ) {
    super("GitHub provider request failed.");
    this.name = "GitHubProviderError";
    this.code = code;
    this.requestId = options.requestId ?? null;
    this.retryable = options.retryable;
    this.status = options.status;
  }

  toJSON() {
    return {
      code: this.code,
      requestId: this.requestId,
      retryable: this.retryable,
      status: this.status,
    };
  }
}

export function createGitHubAppJwt(
  input: Readonly<{ appId: string; privateKey: KeyObject }>,
  nowMs = Date.now()
): string {
  if (!DECIMAL_ID.test(input.appId)) {
    throw new Error("GitHub App id must be a canonical positive decimal.");
  }
  if (
    !Number.isFinite(nowMs) ||
    nowMs < 0 ||
    input.privateKey.asymmetricKeyType !== "rsa"
  ) {
    throw new Error("GitHub App JWT signing configuration is invalid.");
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({
    exp: nowSeconds + 540,
    iat: nowSeconds - 60,
    iss: input.appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput, "utf8"),
    input.privateKey
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function githubInstallationTokenRequest(
  permissions: Readonly<Record<string, PermissionLevel>>,
  repositoryIds?: readonly string[]
): Readonly<{
  permissions: Readonly<Record<string, PermissionLevel>>;
  repository_ids?: number[];
}> {
  const entries = Object.entries(permissions);
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    entries.some(
      ([name, level]) =>
        !PERMISSION_NAME.test(name) ||
        (level !== "read" && level !== "write" && level !== "admin")
    )
  ) {
    throw new Error("GitHub installation token permissions are invalid.");
  }

  if (repositoryIds === undefined) {
    return { permissions: { ...permissions } };
  }
  if (
    repositoryIds.length === 0 ||
    repositoryIds.length > GITHUB_MAX_REPOSITORIES
  ) {
    throw new Error("GitHub repository id selection is invalid.");
  }
  const ids = repositoryIds.map((id) => {
    if (!DECIMAL_ID.test(id)) {
      throw new Error("GitHub repository ids must be safe decimal integers.");
    }
    const parsed = Number(id);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error("GitHub repository ids must be safe decimal integers.");
    }
    return parsed;
  });
  if (new Set(ids).size !== ids.length) {
    throw new Error("GitHub repository id selection contains duplicates.");
  }
  return { permissions: { ...permissions }, repository_ids: ids };
}

export function createGitHubAppClient(
  input: Readonly<{
    appId: string;
    appSlug: string;
    fetch?: FetchLike;
    maxPages?: number;
    maxRepositories?: number;
    maxResponseBytes?: number;
    now?: () => number;
    privateKey: KeyObject;
    timeoutMs?: number;
  }>
): GitHubAppClient {
  const fetchImpl = input.fetch ?? ((url, init) => fetch(url, init));
  const maxPages = positiveInteger(
    input.maxPages ?? DEFAULT_MAX_PAGES,
    "GitHub page bound"
  );
  const maxRepositories = positiveInteger(
    input.maxRepositories ?? GITHUB_MAX_REPOSITORIES,
    "GitHub repository bound"
  );
  const maxResponseBytes = positiveInteger(
    input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "GitHub response byte bound"
  );
  const timeoutMs = positiveInteger(
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "GitHub request timeout"
  );
  const now = input.now ?? Date.now;

  const appJson = (path: string, init: RequestInit = {}) =>
    requestJson(path, {
      ...init,
      authorization: `Bearer ${createGitHubAppJwt(
        { appId: input.appId, privateKey: input.privateKey },
        now()
      )}`,
    });

  async function requestJson(
    path: string,
    options: RequestInit & { authorization: string }
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutTimer = globalThis.setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(providerTimeoutError());
      }, timeoutMs);
    });
    const request = async (): Promise<unknown> => {
      let response: Response;
      try {
        response = await fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
          body: options.body,
          headers: {
            accept: "application/vnd.github+json",
            authorization: options.authorization,
            "content-type": "application/json",
            "user-agent": "OpenCoven-GitHub-App",
            "x-github-api-version": GITHUB_API_VERSION,
            ...Object.fromEntries(new Headers(options.headers).entries()),
          },
          method: options.method ?? "GET",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw providerStatusError(response);
        }
        const text = await readBoundedText(response, maxResponseBytes);
        try {
          const preserveIntegers = ((
            _key: string,
            value: unknown,
            context?: Readonly<{ source?: string }>
          ) =>
            typeof value === "number" &&
            context?.source !== undefined &&
            /^-?[0-9]+$/u.test(context.source)
              ? context.source
              : value) as (
            this: unknown,
            key: string,
            value: unknown
          ) => unknown;
          return JSON.parse(text, preserveIntegers) as unknown;
        } catch {
          // biome-ignore lint/style/useErrorCause: parser errors can echo secret-bearing provider response fragments
          throw new GitHubProviderError("github_provider_invalid_json", {
            retryable: false,
            status: 502,
          });
        }
      } catch (error) {
        if (error instanceof GitHubProviderError) {
          throw error;
        }
        if (timedOut || controller.signal.aborted) {
          throw providerTimeoutError();
        }
        // biome-ignore lint/style/useErrorCause: transport errors can contain authorization material
        throw new GitHubProviderError("github_provider_unavailable", {
          retryable: true,
          status: 503,
        });
      }
    };

    try {
      return await Promise.race([request(), timeout]);
    } finally {
      if (timeoutTimer !== undefined) {
        globalThis.clearTimeout(timeoutTimer);
      }
    }
  }

  async function withInstallationToken<T>(
    installationId: string,
    repositoryIds: readonly string[] | undefined,
    operation: (authorization: string) => Promise<T>
  ): Promise<T> {
    assertDecimalId(installationId, "GitHub installation id");
    const body = object(
      await appJson(`/app/installations/${installationId}/access_tokens`, {
        body: JSON.stringify(
          githubInstallationTokenRequest({ metadata: "read" }, repositoryIds)
        ),
        method: "POST",
      }),
      "GitHub installation token response"
    );
    let token = string(body.token, "GitHub installation token", {
      maxBytes: MAX_INSTALLATION_TOKEN_BYTES,
    });
    const expiresAt = string(
      body.expires_at,
      "GitHub installation token expiry",
      { maxBytes: 64 }
    );
    if (Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now()) {
      throw new GitHubProviderError("github_provider_invalid_response", {
        retryable: false,
        status: 502,
      });
    }
    try {
      return await operation(`Bearer ${token}`);
    } finally {
      token = "";
    }
  }

  return {
    async getInstallation(installationId) {
      assertDecimalId(installationId, "GitHub installation id");
      return parseInstallation(
        await appJson(`/app/installations/${installationId}`)
      );
    },

    listInstallationRepositories(installationId, repositoryIds) {
      return withInstallationToken(
        installationId,
        repositoryIds,
        async (authorization) => {
          const repositories: GitHubRepository[] = [];
          let selection: "all" | "selected" | null = null;
          let totalCount: number | null = null;

          for (let page = 1; page <= maxPages; page += 1) {
            // biome-ignore lint/performance/noAwaitInLoops: each bounded page depends on the prior page's count
            const pageBody = await requestJson(
              `/installation/repositories?page=${page}&per_page=100`,
              { authorization }
            );
            const parsed = object(pageBody, "GitHub repository page");
            const currentSelection = repositorySelection(
              parsed.repository_selection
            );
            if (selection !== null && selection !== currentSelection) {
              throw invalidResponse();
            }
            selection = currentSelection;

            const currentTotal = nonNegativeInteger(
              parsed.total_count,
              "GitHub repository total"
            );
            if (totalCount !== null && totalCount !== currentTotal) {
              throw invalidResponse();
            }
            totalCount = currentTotal;
            if (totalCount > maxRepositories) {
              throw new GitHubProviderError("github_repository_limit", {
                retryable: false,
                status: 422,
              });
            }

            if (!Array.isArray(parsed.repositories)) {
              throw invalidResponse();
            }
            for (const value of parsed.repositories) {
              repositories.push(parseRepository(value));
              if (repositories.length > maxRepositories) {
                throw new GitHubProviderError("github_repository_limit", {
                  retryable: false,
                  status: 422,
                });
              }
            }

            if (repositories.length >= totalCount) {
              return {
                repositories: deduplicateRepositories(repositories),
                repositorySelection: selection,
              };
            }
            if (parsed.repositories.length === 0) {
              throw invalidResponse();
            }
          }

          throw new GitHubProviderError(
            "github_provider_pagination_exhausted",
            {
              retryable: false,
              status: 502,
            }
          );
        }
      );
    },
  };
}

function parseInstallation(value: unknown): GitHubInstallation {
  const body = object(value, "GitHub installation");
  const account = object(body.account, "GitHub installation account");
  const { type } = account;
  if (type !== "Organization" && type !== "User") {
    throw invalidResponse();
  }
  const accountId = decimalString(account.id, "GitHub account id");
  if (
    decimalString(body.target_id, "GitHub installation target id") !==
      accountId ||
    body.target_type !== type
  ) {
    throw invalidResponse();
  }
  const permissionsBody = object(
    body.permissions,
    "GitHub installation permissions"
  );
  const permissions: Record<string, PermissionLevel> = {};
  if (Object.keys(permissionsBody).length > 128) {
    throw invalidResponse();
  }
  for (const [name, level] of Object.entries(permissionsBody)) {
    if (
      !PERMISSION_NAME.test(name) ||
      (level !== "read" && level !== "write" && level !== "admin")
    ) {
      throw invalidResponse();
    }
    permissions[name] = level;
  }

  const suspendedAt = body.suspended_at;
  if (
    suspendedAt !== null &&
    (typeof suspendedAt !== "string" ||
      suspendedAt.length > 64 ||
      Number.isNaN(Date.parse(suspendedAt)))
  ) {
    throw invalidResponse();
  }

  return {
    account: {
      id: accountId,
      login: namedString(account.login, "GitHub account login"),
      type,
    },
    appId: decimalString(body.app_id, "GitHub App id"),
    appSlug: slug(body.app_slug),
    id: decimalString(body.id, "GitHub installation id"),
    permissions,
    repositorySelection: repositorySelection(body.repository_selection),
    suspendedAt,
  };
}

function parseRepository(value: unknown): GitHubRepository {
  const body = object(value, "GitHub repository");
  const owner = object(body.owner, "GitHub repository owner");
  const ownerLogin = namedString(owner.login, "GitHub repository owner login");
  const name = namedString(body.name, "GitHub repository name");
  if (
    typeof body.full_name !== "string" ||
    body.full_name !== `${ownerLogin}/${name}`
  ) {
    throw invalidResponse();
  }
  if (typeof body.node_id !== "string" || !NODE_ID.test(body.node_id)) {
    throw invalidResponse();
  }
  return {
    id: decimalString(body.id, "GitHub repository id"),
    name,
    nodeId: body.node_id,
    owner: ownerLogin,
  };
}

function deduplicateRepositories(
  repositories: readonly GitHubRepository[]
): GitHubRepository[] {
  const ids = new Set<string>();
  for (const repository of repositories) {
    if (ids.has(repository.id)) {
      throw invalidResponse();
    }
    ids.add(repository.id);
  }
  return [...repositories].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}

function providerStatusError(response: Response): GitHubProviderError {
  const requestIdValue = response.headers.get("x-github-request-id");
  const requestId =
    requestIdValue && REQUEST_ID.test(requestIdValue) ? requestIdValue : null;
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"));
  const classified = rateLimited
    ? { code: "github_provider_rate_limited", retryable: true }
    : response.status === 401
      ? { code: "github_provider_unauthorized", retryable: false }
      : response.status === 403
        ? { code: "github_provider_forbidden", retryable: false }
        : response.status === 404
          ? { code: "github_installation_missing", retryable: false }
          : response.status === 409
            ? { code: "github_provider_conflict", retryable: false }
            : response.status === 422
              ? { code: "github_provider_rejected", retryable: false }
              : response.status >= 500
                ? { code: "github_provider_unavailable", retryable: true }
                : {
                    code: "github_provider_invalid_response",
                    retryable: false,
                  };
  return new GitHubProviderError(classified.code, {
    requestId,
    retryable: classified.retryable,
    status: response.status,
  });
}

async function readBoundedText(
  response: Response,
  maxBytes: number
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength &&
    /^[0-9]+$/u.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    throw responseTooLarge();
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    // biome-ignore lint/performance/noAwaitInLoops: streaming is required to enforce the byte ceiling before buffering
    const next = await reader.read();
    if (next.done) {
      break;
    }
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw responseTooLarge();
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // biome-ignore lint/style/useErrorCause: decoder errors can echo secret-bearing provider response fragments
    throw new GitHubProviderError("github_provider_invalid_json", {
      retryable: false,
      status: 502,
    });
  }
}

function responseTooLarge(): GitHubProviderError {
  return new GitHubProviderError("github_provider_response_too_large", {
    retryable: false,
    status: 502,
  });
}

function providerTimeoutError(): GitHubProviderError {
  return new GitHubProviderError("github_provider_timeout", {
    retryable: true,
    status: 504,
  });
}

function invalidResponse(): GitHubProviderError {
  return new GitHubProviderError("github_provider_invalid_response", {
    retryable: false,
    status: 502,
  });
}

function object(value: unknown, _label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as JsonObject;
}

function string(
  value: unknown,
  _label: string,
  options: Readonly<{ maxBytes: number }>
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > options.maxBytes
  ) {
    throw invalidResponse();
  }
  return value;
}

function namedString(value: unknown, _label: string): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function slug(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(value)
  ) {
    throw invalidResponse();
  }
  return value;
}

function repositorySelection(value: unknown): "all" | "selected" {
  if (value !== "all" && value !== "selected") {
    throw invalidResponse();
  }
  return value;
}

function decimalString(value: unknown, _label: string): string {
  const rendered =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (!DECIMAL_ID.test(rendered)) {
    throw invalidResponse();
  }
  return rendered;
}

function nonNegativeInteger(value: unknown, _label: string): number {
  const rendered =
    typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === "string"
        ? value
        : "";
  if (!/^(0|[1-9][0-9]{0,15})$/u.test(rendered)) {
    throw invalidResponse();
  }
  const parsed = Number(rendered);
  if (!Number.isSafeInteger(parsed)) {
    throw invalidResponse();
  }
  return parsed;
}

function assertDecimalId(value: string, label: string): void {
  if (!DECIMAL_ID.test(value)) {
    throw new Error(`${label} must be a canonical positive decimal.`);
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
