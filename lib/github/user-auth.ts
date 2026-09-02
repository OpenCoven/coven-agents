import "server-only";

import type { KeyObject } from "node:crypto";
import { GitHubProviderError } from "./app-auth";
import type { GitHubUserRepositoryPermission } from "./authority-types";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_OAUTH_ORIGIN = "https://github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_INSTALLATIONS = 1000;
const DEFAULT_MAX_REPOSITORIES = 16;
const MAX_TOKEN_BYTES = 4096;
const MAX_CODE_BYTES = 1024;
const MAX_REDIRECT_URI_BYTES = 2048;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/u;
const NODE_ID = /^[A-Za-z0-9_=-]{1,256}$/u;
const OAUTH_CODE = /^[A-Za-z0-9._~-]+$/u;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const OAUTH_USER_PATTERN = /^ghu_[A-Za-z0-9]{20,4092}$/u;
const OAUTH_REFRESH_PATTERN = /^ghr_[A-Za-z0-9]{20,4092}$/u;
const TOKEN_CANDIDATE = /^[\x21-\x7e]+$/u;
const REQUEST_ID = /^[A-Za-z0-9:-]{1,128}$/u;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type JsonObject = Record<string, unknown>;

export type GitHubUserAuthorizationClient = Readonly<{
  proveInstallationAccess: (
    input: Readonly<{
      code: string;
      codeVerifier: string;
      installationId: string;
      redirectUri: string;
    }>
  ) => Promise<GitHubUserInstallationAuthority>;
}>;

export type GitHubUserInstallationAuthority = Readonly<{
  repositories: readonly Readonly<{
    id: string;
    name: string;
    nodeId: string;
    owner: string;
    permission: GitHubUserRepositoryPermission;
  }>[];
  user: Readonly<{ id: string; login: string }>;
}>;

export function createGitHubUserAuthorizationClient(
  input: Readonly<{
    appId: string;
    appSlug: string;
    clientId: string;
    clientSecret: KeyObject;
    fetch?: FetchLike;
    maxInstallations?: number;
    maxPages?: number;
    maxRepositories?: number;
    maxResponseBytes?: number;
    timeoutMs?: number;
  }>
): GitHubUserAuthorizationClient {
  assertDecimalId(input.appId, "GitHub App id");
  if (!CLIENT_ID.test(input.clientId)) {
    throw new Error("GitHub App client id is invalid.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u.test(input.appSlug)) {
    throw new Error("GitHub App slug is invalid.");
  }
  if (input.clientSecret.type !== "secret") {
    throw new Error("GitHub App client secret is invalid.");
  }

  const fetchImpl = input.fetch ?? ((url, init) => fetch(url, init));
  const maxInstallations = positiveInteger(
    input.maxInstallations ?? DEFAULT_MAX_INSTALLATIONS,
    "GitHub user installation bound"
  );
  const maxRepositories = positiveInteger(
    input.maxRepositories ?? DEFAULT_MAX_REPOSITORIES,
    "GitHub user repository bound"
  );
  const maxPages = positiveInteger(
    input.maxPages ?? DEFAULT_MAX_PAGES,
    "GitHub user installation page bound"
  );
  const maxResponseBytes = positiveInteger(
    input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    "GitHub user authorization response bound"
  );
  const timeoutMs = positiveInteger(
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "GitHub user authorization timeout"
  );

  function requestJson(
    url: string,
    init: RequestInit,
    stage: "exchange" | "user"
  ): Promise<Readonly<{ timedOut: boolean; value: unknown }>> {
    return timedRequest(url, init, stage, async (response) => {
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
            : value) as (this: unknown, key: string, value: unknown) => unknown;
        return JSON.parse(text, preserveIntegers) as unknown;
      } catch {
        // biome-ignore lint/style/useErrorCause: parser errors can echo user tokens or provider response fragments
        throw new GitHubProviderError("github_provider_invalid_json", {
          retryable: false,
          status: 502,
        });
      }
    });
  }

  async function timedRequest<T>(
    url: string,
    init: RequestInit,
    stage: "exchange" | "refresh-revoke" | "revoke" | "user",
    consume: (response: Response) => Promise<T>
  ): Promise<Readonly<{ timedOut: boolean; value: T }>> {
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    timer = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        });
        if (
          (stage === "revoke" && response.status !== 204) ||
          (stage === "refresh-revoke" && response.status !== 202) ||
          (stage !== "refresh-revoke" && stage !== "revoke" && !response.ok)
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw statusError(response, stage);
        }
        return { timedOut, value: await consume(response) };
      } catch (error) {
        if (timedOut || controller.signal.aborted) {
          throw timeoutError();
        }
        if (error instanceof GitHubProviderError) {
          throw error;
        }
        throw unavailableError();
      }
    } finally {
      if (timer !== undefined) {
        globalThis.clearTimeout(timer);
      }
    }
  }

  function requireOnTime<T>(
    result: Readonly<{ timedOut: boolean; value: T }>
  ): T {
    if (result.timedOut) {
      throw timeoutError();
    }
    return result.value;
  }

  function exchangeCode(
    proof: Parameters<
      GitHubUserAuthorizationClient["proveInstallationAccess"]
    >[0]
  ): Promise<
    Readonly<{
      error: GitHubProviderError | null;
      tokens: Readonly<{ access: string | null; refresh: string | null }>;
    }>
  > {
    return withClientSecret(input.clientSecret, async (clientSecret) => {
      const body = new URLSearchParams({
        client_id: input.clientId,
        client_secret: clientSecret,
        code: proof.code,
        code_verifier: proof.codeVerifier,
        redirect_uri: proof.redirectUri,
      });
      const exchange = await requestJson(
        `${GITHUB_OAUTH_ORIGIN}/login/oauth/access_token`,
        {
          body: body.toString(),
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "OpenCoven-GitHub-App",
          },
          method: "POST",
        },
        "exchange"
      );
      const parsed = object(exchange.value);
      let validationError: GitHubProviderError | null = exchange.timedOut
        ? timeoutError()
        : parsed.access_token === undefined && typeof parsed.error === "string"
          ? new GitHubProviderError("github_oauth_exchange_rejected", {
              retryable: false,
              status: 400,
            })
          : null;
      let accessToken: string | null = null;
      let refreshToken: string | null = null;
      try {
        accessToken = boundedTokenCandidate(parsed.access_token);
      } catch (error) {
        validationError ??=
          error instanceof GitHubProviderError ? error : invalidResponse();
      }
      try {
        if (parsed.refresh_token !== undefined) {
          refreshToken = boundedTokenCandidate(parsed.refresh_token);
        }
        if (
          parsed.error !== undefined ||
          parsed.token_type !== "bearer" ||
          parsed.scope !== ""
        ) {
          throw invalidResponse();
        }
        validateOptionalExpiration(parsed);
      } catch (error) {
        validationError ??=
          error instanceof GitHubProviderError ? error : invalidResponse();
      }
      if (accessToken !== null && !OAUTH_USER_PATTERN.test(accessToken)) {
        validationError ??= invalidResponse();
      }
      return {
        error: validationError,
        tokens: { access: accessToken, refresh: refreshToken },
      };
    });
  }

  async function assertAccessibleInstallation(
    installationId: string,
    token: string
  ): Promise<void> {
    let observed = 0;
    let totalCount: number | null = null;
    const ids = new Set<string>();
    for (let page = 1; page <= maxPages; page += 1) {
      const body = object(
        requireOnTime(
          // biome-ignore lint/performance/noAwaitInLoops: each bounded page depends on the prior count
          await requestJson(
            `${GITHUB_API_ORIGIN}/user/installations?page=${page}&per_page=100`,
            { headers: apiHeaders(`Bearer ${token}`), method: "GET" },
            "user"
          )
        )
      );
      const currentTotal = nonNegativeInteger(body.total_count);
      if (currentTotal > maxInstallations) {
        throw responseTooLarge();
      }

      if (totalCount !== null && totalCount !== currentTotal) {
        throw invalidResponse();
      }
      totalCount = currentTotal;
      if (
        !Array.isArray(body.installations) ||
        body.installations.length > 100
      ) {
        throw invalidResponse();
      }

      let matched = false;
      for (const value of body.installations) {
        const installation = parseUserInstallation(value);
        if (ids.has(installation.id)) {
          throw invalidResponse();
        }
        ids.add(installation.id);
        observed += 1;
        if (observed > maxInstallations || observed > totalCount) {
          throw invalidResponse();
        }
        if (installation.id === installationId) {
          matched = true;
        }
      }

      if (matched) {
        return;
      }
      if (observed >= totalCount) {
        throw inaccessibleInstallation();
      }
      if (body.installations.length === 0) {
        throw invalidResponse();
      }
    }
    throw new GitHubProviderError("github_provider_pagination_exhausted", {
      retryable: false,
      status: 502,
    });
  }

  async function userIdentity(
    token: string
  ): Promise<GitHubUserInstallationAuthority["user"]> {
    const body = object(
      requireOnTime(
        await requestJson(
          `${GITHUB_API_ORIGIN}/user`,
          {
            headers: apiHeaders(["Bearer", token].join(" ")),
            method: "GET",
          },
          "user"
        )
      )
    );
    return {
      id: decimalString(body.id),
      login: namedString(body.login),
    };
  }

  async function userRepositories(
    installationId: string,
    token: string
  ): Promise<GitHubUserInstallationAuthority["repositories"]> {
    let observed = 0;
    let totalCount: number | null = null;
    let selection: "all" | "selected" | null = null;
    const repositories: GitHubUserInstallationAuthority["repositories"][number][] =
      [];
    const ids = new Set<string>();
    for (let page = 1; page <= maxPages; page += 1) {
      let pageValue: unknown;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each bounded page depends on the prior count
        pageValue = requireOnTime(
          await requestJson(
            `${GITHUB_API_ORIGIN}/user/installations/${installationId}/repositories?page=${page}&per_page=100`,
            {
              headers: apiHeaders(["Bearer", token].join(" ")),
              method: "GET",
            },
            "user"
          )
        );
      } catch (error) {
        if (
          error instanceof GitHubProviderError &&
          error.code === "github_user_authorization_rejected" &&
          (error.status === 403 || error.status === 404)
        ) {
          throw inaccessibleInstallation();
        }
        throw error;
      }
      const body = object(pageValue);
      const currentSelection = repositorySelection(body.repository_selection);
      if (currentSelection === "all") {
        throw invalidResponse();
      }
      if (
        selection !== null &&
        currentSelection !== null &&
        selection !== currentSelection
      ) {
        throw invalidResponse();
      }
      selection ??= currentSelection;
      const currentTotal = nonNegativeInteger(body.total_count);
      if (currentTotal > maxRepositories) {
        throw responseTooLarge();
      }
      if (totalCount !== null && totalCount !== currentTotal) {
        throw invalidResponse();
      }
      totalCount = currentTotal;
      if (!Array.isArray(body.repositories) || body.repositories.length > 100) {
        throw invalidResponse();
      }
      for (const value of body.repositories) {
        const repository = parseUserRepository(value);
        if (ids.has(repository.id)) {
          throw invalidResponse();
        }
        ids.add(repository.id);
        repositories.push(repository);
        observed += 1;
        if (
          observed > maxRepositories ||
          totalCount === null ||
          observed > totalCount
        ) {
          throw invalidResponse();
        }
      }
      if (observed >= currentTotal) {
        return repositories;
      }
      if (body.repositories.length === 0) {
        throw invalidResponse();
      }
    }
    throw new GitHubProviderError("github_provider_pagination_exhausted", {
      retryable: false,
      status: 502,
    });
  }

  async function revokeToken(token: string): Promise<void> {
    await withClientSecret(input.clientSecret, async (clientSecret) => {
      const basic = Buffer.from(
        `${input.clientId}:${clientSecret}`,
        "utf8"
      ).toString("base64");
      requireOnTime(
        await timedRequest(
          `${GITHUB_API_ORIGIN}/applications/${input.clientId}/token`,
          {
            body: JSON.stringify({ access_token: token }),
            headers: apiHeaders(`Basic ${basic}`),
            method: "DELETE",
          },
          "revoke",
          () => Promise.resolve()
        )
      );
    });
  }

  async function revokeRefreshToken(token: string): Promise<void> {
    requireOnTime(
      await timedRequest(
        `${GITHUB_API_ORIGIN}/credentials/revoke`,
        {
          body: JSON.stringify({ credentials: [token] }),
          headers: {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            "user-agent": "OpenCoven-GitHub-App",
            "x-github-api-version": GITHUB_API_VERSION,
          },
          method: "POST",
        },
        "refresh-revoke",
        () => Promise.resolve()
      )
    );
  }

  return {
    async proveInstallationAccess(proof) {
      assertProofInput(proof);
      const { error: exchangeError, tokens: exchangedTokens } =
        await exchangeCode(proof);
      let accessToken = exchangedTokens.access;
      let refreshToken = exchangedTokens.refresh;
      let operationError: unknown = exchangeError ?? undefined;
      let authority: GitHubUserInstallationAuthority | undefined;
      if (operationError === undefined && accessToken !== null) {
        try {
          await assertAccessibleInstallation(proof.installationId, accessToken);
          const [userResult, repositoryResult] = await Promise.allSettled([
            userIdentity(accessToken),
            userRepositories(proof.installationId, accessToken),
          ]);
          if (userResult.status === "rejected") {
            throw userResult.reason;
          }
          if (repositoryResult.status === "rejected") {
            throw repositoryResult.reason;
          }
          authority = {
            repositories: repositoryResult.value,
            user: userResult.value,
          };
        } catch (error) {
          operationError = error;
        }
      } else if (operationError === undefined) {
        operationError = invalidResponse();
      }

      let revocationError: unknown;
      try {
        const revocations = [
          ...(refreshToken === null ? [] : [revokeRefreshToken(refreshToken)]),
          ...(accessToken === null ? [] : [revokeToken(accessToken)]),
        ];
        const results = await Promise.allSettled(revocations);
        revocationError = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        )?.reason;
      } finally {
        accessToken = null;
        refreshToken = null;
      }
      if (revocationError !== undefined) {
        throw revocationError;
      }
      if (operationError !== undefined) {
        throw operationError;
      }
      if (!authority) {
        throw invalidResponse();
      }
      return authority;
    },
  };

  function parseUserInstallation(value: unknown): { id: string } {
    const installation = object(value);
    if (
      decimalString(installation.app_id) !== input.appId ||
      installation.app_slug !== input.appSlug ||
      (installation.client_id !== undefined &&
        installation.client_id !== input.clientId)
    ) {
      throw invalidResponse();
    }
    return { id: decimalString(installation.id) };
  }

  function parseUserRepository(
    value: unknown
  ): GitHubUserInstallationAuthority["repositories"][number] {
    const repository = object(value);
    const owner = object(repository.owner);
    const ownerLogin = namedString(owner.login);
    const name = namedString(repository.name);
    if (repository.full_name !== `${ownerLogin}/${name}`) {
      throw invalidResponse();
    }
    if (
      typeof repository.node_id !== "string" ||
      !NODE_ID.test(repository.node_id)
    ) {
      throw invalidResponse();
    }
    const permissions = object(repository.permissions);
    const keys = Object.keys(permissions);
    if (
      keys.some(
        (key) => !["admin", "maintain", "pull", "push", "triage"].includes(key)
      ) ||
      typeof permissions.admin !== "boolean" ||
      typeof permissions.pull !== "boolean" ||
      typeof permissions.push !== "boolean" ||
      (permissions.maintain !== undefined &&
        typeof permissions.maintain !== "boolean") ||
      (permissions.triage !== undefined &&
        typeof permissions.triage !== "boolean") ||
      permissions.pull !== true ||
      ((permissions.admin === true || permissions.maintain === true) &&
        permissions.push !== true)
    ) {
      throw invalidResponse();
    }
    const permission: GitHubUserRepositoryPermission =
      permissions.admin === true
        ? "admin"
        : permissions.maintain === true
          ? "maintain"
          : permissions.push === true
            ? "write"
            : permissions.triage === true
              ? "triage"
              : "read";
    return {
      id: decimalString(repository.id),
      name,
      nodeId: repository.node_id,
      owner: ownerLogin,
      permission,
    };
  }
}

function assertProofInput(
  input: Parameters<GitHubUserAuthorizationClient["proveInstallationAccess"]>[0]
): void {
  if (
    !OAUTH_CODE.test(input.code) ||
    Buffer.byteLength(input.code, "utf8") > MAX_CODE_BYTES ||
    !PKCE_VERIFIER.test(input.codeVerifier) ||
    !DECIMAL_ID.test(input.installationId) ||
    input.redirectUri !== input.redirectUri.trim() ||
    Buffer.byteLength(input.redirectUri, "utf8") > MAX_REDIRECT_URI_BYTES
  ) {
    throw invalidResponse();
  }
  let redirect: URL;
  try {
    redirect = new URL(input.redirectUri);
  } catch {
    // biome-ignore lint/style/useErrorCause: URL parser errors can echo a credential-bearing invalid authority
    throw invalidResponse();
  }
  if (
    (redirect.protocol !== "https:" &&
      !(
        redirect.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(redirect.hostname)
      )) ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash ||
    redirect.toString() !== input.redirectUri
  ) {
    throw invalidResponse();
  }
}

function validateOptionalExpiration(body: JsonObject): void {
  const hasAccessExpiration = body.expires_in !== undefined;
  const hasRefreshToken = body.refresh_token !== undefined;
  const hasRefreshExpiration = body.refresh_token_expires_in !== undefined;
  if (
    hasAccessExpiration !== hasRefreshToken ||
    hasAccessExpiration !== hasRefreshExpiration
  ) {
    throw invalidResponse();
  }
  if (
    hasAccessExpiration &&
    (nonNegativeInteger(body.expires_in) !== 28_800 ||
      nonNegativeInteger(body.refresh_token_expires_in) !== 15_897_600)
  ) {
    throw invalidResponse();
  }
  if (hasRefreshToken) {
    boundedToken(body.refresh_token, OAUTH_REFRESH_PATTERN);
  }
}

function apiHeaders(authorization: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization,
    "content-type": "application/json",
    "user-agent": "OpenCoven-GitHub-App",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

async function withClientSecret<T>(
  key: KeyObject,
  operation: (value: string) => Promise<T>
): Promise<T> {
  const secret = key.export();
  if (!Buffer.isBuffer(secret)) {
    throw new Error("GitHub App client secret is invalid.");
  }
  try {
    return await operation(secret.toString("utf8"));
  } finally {
    secret.fill(0);
  }
}

function statusError(
  response: Response,
  stage: "exchange" | "refresh-revoke" | "revoke" | "user"
): GitHubProviderError {
  const requestIdValue = response.headers.get("x-github-request-id");
  const requestId =
    requestIdValue && REQUEST_ID.test(requestIdValue) ? requestIdValue : null;
  const rateLimited =
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.has("retry-after") ||
        response.headers.get("x-ratelimit-remaining") === "0"));
  if (rateLimited) {
    return new GitHubProviderError("github_provider_rate_limited", {
      requestId,
      retryable: true,
      status: response.status,
    });
  }
  if (response.status >= 500) {
    return new GitHubProviderError("github_provider_unavailable", {
      requestId,
      retryable: true,
      status: response.status,
    });
  }
  return new GitHubProviderError(
    stage === "exchange"
      ? "github_oauth_exchange_rejected"
      : stage === "user"
        ? "github_user_authorization_rejected"
        : "github_oauth_revocation_rejected",
    {
      requestId,
      retryable: false,
      status: response.status,
    }
  );
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
    // biome-ignore lint/performance/noAwaitInLoops: streaming enforces the byte ceiling before buffering
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
    // biome-ignore lint/style/useErrorCause: decoder errors can echo user tokens or provider response fragments
    throw new GitHubProviderError("github_provider_invalid_json", {
      retryable: false,
      status: 502,
    });
  }
}

function boundedToken(value: unknown, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES ||
    !pattern.test(value)
  ) {
    throw invalidResponse();
  }
  return value;
}

function boundedTokenCandidate(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    !TOKEN_CANDIDATE.test(value) ||
    Buffer.byteLength(value, "utf8") > MAX_TOKEN_BYTES
  ) {
    throw invalidResponse();
  }
  return value;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse();
  }
  return value as JsonObject;
}

function decimalString(value: unknown): string {
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

function namedString(value: unknown): string {
  if (typeof value !== "string" || !NAME.test(value)) {
    throw invalidResponse();
  }
  return value;
}

function repositorySelection(value: unknown): "all" | "selected" | null {
  if (value === undefined) {
    return null;
  }
  if (value !== "all" && value !== "selected") {
    throw invalidResponse();
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
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

function timeoutError(): GitHubProviderError {
  return new GitHubProviderError("github_provider_timeout", {
    retryable: true,
    status: 504,
  });
}

function unavailableError(): GitHubProviderError {
  return new GitHubProviderError("github_provider_unavailable", {
    retryable: true,
    status: 503,
  });
}

function responseTooLarge(): GitHubProviderError {
  return new GitHubProviderError("github_provider_response_too_large", {
    retryable: false,
    status: 502,
  });
}

function invalidResponse(): GitHubProviderError {
  return new GitHubProviderError("github_provider_invalid_response", {
    retryable: false,
    status: 502,
  });
}

function inaccessibleInstallation(): GitHubProviderError {
  return new GitHubProviderError("github_user_installation_inaccessible", {
    retryable: false,
    status: 403,
  });
}
