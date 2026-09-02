import "server-only";

import type { KeyObject } from "node:crypto";
import { GitHubProviderError } from "./app-auth";
import type { GitHubUserRepositoryPermission } from "./authority-types";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_OAUTH_ORIGIN = "https://github.com";
const GITHUB_API_VERSION = "2022-11-28";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_EXCHANGE_OBSERVATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_INSTALLATIONS = 1000;
const DEFAULT_MAX_REPOSITORIES = 16;
const MAX_TOKEN_BYTES = 4096;
const MAX_TOKEN_CANDIDATES_PER_TYPE = 4;
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
type TokenCandidates = Readonly<{
  access: readonly string[];
  overflow: boolean;
  refresh: readonly string[];
}>;

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
    exchangeObservationTimeoutMs?: number;
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
  const exchangeObservationTimeoutMs = positiveInteger(
    input.exchangeObservationTimeoutMs ??
      DEFAULT_EXCHANGE_OBSERVATION_TIMEOUT_MS,
    "GitHub OAuth exchange observation timeout"
  );
  if (exchangeObservationTimeoutMs <= timeoutMs) {
    throw new Error(
      "GitHub OAuth exchange observation timeout must exceed the request timeout."
    );
  }

  function requestJson(
    url: string,
    init: RequestInit,
    stage: "user"
  ): Promise<Readonly<{ timedOut: boolean; value: unknown }>> {
    return timedRequest(url, init, stage, async (response) => {
      const text = await readBoundedText(response, maxResponseBytes);
      return parseJson(text);
    });
  }

  function requestExchange(
    url: string,
    init: RequestInit
  ): Promise<
    Readonly<{
      timedOut: boolean;
      value: Readonly<{
        candidates: TokenCandidates;
        error: GitHubProviderError | null;
        parsed: unknown | null;
      }>;
    }>
  > {
    return timedRequest(url, init, "exchange", async (response) => {
      const body = await readBoundedBody(response, maxResponseBytes, true);
      const candidateText = new TextDecoder("utf-8").decode(body.bytes);
      const candidates = topLevelTokenCandidates(candidateText);
      const responseError = response.ok
        ? body.error
        : statusError(response, "exchange");
      if (responseError !== null) {
        return { candidates, error: responseError, parsed: null };
      }
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          body.bytes
        );
        return { candidates, error: null, parsed: parseJson(text) };
      } catch (error) {
        return {
          candidates,
          error:
            error instanceof GitHubProviderError ? error : invalidJsonError(),
          parsed: null,
        };
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
    const observeLateExchange = stage === "exchange";
    let timedOut = false;
    const timeoutTimer = globalThis.setTimeout(() => {
      timedOut = true;
      if (!observeLateExchange) {
        controller.abort();
      }
    }, timeoutMs);
    const observationTimer = observeLateExchange
      ? globalThis.setTimeout(
          () => controller.abort(),
          exchangeObservationTimeoutMs
        )
      : undefined;
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
          (stage === "user" && !response.ok)
        ) {
          await response.body?.cancel().catch(() => undefined);
          throw statusError(response, stage);
        }
        const value = await consume(response);
        return { timedOut, value };
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
      globalThis.clearTimeout(timeoutTimer);
      if (observationTimer !== undefined) {
        globalThis.clearTimeout(observationTimer);
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
      tokens: Readonly<{
        access: string | null;
        revokeAccess: readonly string[];
        revokeRefresh: readonly string[];
      }>;
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
      const exchange = await requestExchange(
        `${GITHUB_OAUTH_ORIGIN}/login/oauth/access_token`,
        {
          body: body.toString(),
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "OpenCoven-GitHub-App",
          },
          method: "POST",
        }
      );
      const parsed =
        exchange.value.parsed === null ? null : object(exchange.value.parsed);
      let validationError: GitHubProviderError | null = exchange.timedOut
        ? timeoutError()
        : exchange.value.error;
      if (
        validationError === null &&
        parsed !== null &&
        parsed.access_token === undefined &&
        typeof parsed.error === "string"
      ) {
        validationError = new GitHubProviderError(
          "github_oauth_exchange_rejected",
          {
            retryable: false,
            status: 400,
          }
        );
      }
      const revokeAccess = new Set(exchange.value.candidates.access);
      const revokeRefresh = new Set(exchange.value.candidates.refresh);
      let candidateOverflow = exchange.value.candidates.overflow;
      if (candidateOverflow) {
        validationError ??= invalidResponse();
      }
      let accessToken: string | null = null;
      if (parsed === null) {
        return {
          error: validationError ?? invalidResponse(),
          tokens: {
            access: null,
            revokeAccess: [...revokeAccess],
            revokeRefresh: [...revokeRefresh],
          },
        };
      }
      try {
        accessToken = boundedTokenCandidate(parsed.access_token);
        candidateOverflow =
          retainEffectiveCandidate(revokeAccess, accessToken) ||
          candidateOverflow;
      } catch (error) {
        validationError ??=
          error instanceof GitHubProviderError ? error : invalidResponse();
      }
      try {
        if (parsed.refresh_token !== undefined) {
          candidateOverflow =
            retainEffectiveCandidate(
              revokeRefresh,
              boundedTokenCandidate(parsed.refresh_token)
            ) || candidateOverflow;
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
      if (candidateOverflow) {
        validationError ??= invalidResponse();
      }
      return {
        error: validationError,
        tokens: {
          access: accessToken,
          revokeAccess: [...revokeAccess],
          revokeRefresh: [...revokeRefresh],
        },
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
        pageValue = requireOnTime(
          // biome-ignore lint/performance/noAwaitInLoops: each bounded page depends on the prior count
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
      const accessTokensToRevoke = [...exchangedTokens.revokeAccess];
      const refreshTokensToRevoke = [...exchangedTokens.revokeRefresh];
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
          ...refreshTokensToRevoke.map((token) => revokeRefreshToken(token)),
          ...accessTokensToRevoke.map((token) => revokeToken(token)),
        ];
        const results = await Promise.allSettled(revocations);
        revocationError = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected"
        )?.reason;
      } finally {
        accessToken = null;
        accessTokensToRevoke.fill("");
        accessTokensToRevoke.length = 0;
        refreshTokensToRevoke.fill("");
        refreshTokensToRevoke.length = 0;
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
  const body = await readBoundedBody(response, maxBytes);
  if (body.error !== null) {
    throw body.error;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body.bytes);
  } catch {
    // biome-ignore lint/style/useErrorCause: decoder errors can echo provider response fragments
    throw invalidJsonError();
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  captureOversizePrefix = false
): Promise<Readonly<{ bytes: Uint8Array; error: GitHubProviderError | null }>> {
  const contentLength = response.headers.get("content-length");
  const declaredOversize =
    contentLength &&
    /^[0-9]+$/u.test(contentLength) &&
    Number(contentLength) > maxBytes;
  if (declaredOversize && !captureOversizePrefix) {
    return { bytes: new Uint8Array(), error: responseTooLarge() };
  }
  if (!response.body) {
    return { bytes: new Uint8Array(), error: null };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: streaming enforces the byte ceiling before buffering
      next = await reader.read();
    } catch {
      return {
        bytes: concatenateBytes(chunks, total),
        error: declaredOversize ? responseTooLarge() : unavailableError(),
      };
    }
    if (next.done) {
      break;
    }
    const remaining = maxBytes - total;
    if (next.value.byteLength > remaining) {
      if (remaining > 0) {
        chunks.push(next.value.subarray(0, remaining));
        total += remaining;
      }
      await reader.cancel().catch(() => undefined);
      return {
        bytes: concatenateBytes(chunks, total),
        error: responseTooLarge(),
      };
    }
    chunks.push(next.value);
    total += next.value.byteLength;
  }
  return {
    bytes: concatenateBytes(chunks, total),
    error: declaredOversize ? responseTooLarge() : null,
  };
}

function concatenateBytes(
  chunks: readonly Uint8Array[],
  total: number
): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(text: string): unknown {
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
    // biome-ignore lint/style/useErrorCause: parser errors can echo provider response fragments
    throw invalidJsonError();
  }
}

function invalidJsonError(): GitHubProviderError {
  return new GitHubProviderError("github_provider_invalid_json", {
    retryable: false,
    status: 502,
  });
}

function topLevelTokenCandidates(text: string): TokenCandidates {
  const access = new Set<string>();
  const refresh = new Set<string>();
  let overflow = false;
  let depth = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "{" || character === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      if (depth < 0) {
        break;
      }
      index += 1;
      continue;
    }
    if (character !== '"') {
      index += 1;
      continue;
    }
    const key = jsonStringAt(text, index);
    if (key === null) {
      break;
    }
    index = key.end;
    if (
      depth !== 1 ||
      key.value === null ||
      (key.value !== "access_token" && key.value !== "refresh_token")
    ) {
      continue;
    }
    let valueStart = skipJsonWhitespace(text, key.end);
    if (text[valueStart] !== ":") {
      continue;
    }
    valueStart = skipJsonWhitespace(text, valueStart + 1);
    const value = jsonStringAt(text, valueStart);
    if (value === null) {
      continue;
    }
    index = value.end;
    if (value.value === null) {
      continue;
    }
    try {
      const candidate = boundedTokenCandidate(value.value);
      overflow =
        retainCandidate(
          key.value === "access_token" ? access : refresh,
          candidate
        ) || overflow;
    } catch {
      // Invalid strings are not safe credential revocation inputs.
    }
  }
  return { access: [...access], overflow, refresh: [...refresh] };
}

function jsonStringAt(
  text: string,
  start: number
): Readonly<{ end: number; value: string | null }> | null {
  if (text[start] !== '"') {
    return null;
  }
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character !== '"') {
      continue;
    }
    try {
      return {
        end: index + 1,
        value: JSON.parse(text.slice(start, index + 1)) as string,
      };
    } catch {
      return { end: index + 1, value: null };
    }
  }
  return null;
}

function retainCandidate(candidates: Set<string>, candidate: string): boolean {
  if (candidates.has(candidate)) {
    return false;
  }
  if (candidates.size >= MAX_TOKEN_CANDIDATES_PER_TYPE) {
    return true;
  }
  candidates.add(candidate);
  return false;
}

function retainEffectiveCandidate(
  candidates: Set<string>,
  candidate: string
): boolean {
  if (candidates.has(candidate)) {
    return false;
  }
  if (candidates.size >= MAX_TOKEN_CANDIDATES_PER_TYPE) {
    const lastCandidate = [...candidates].at(-1);
    if (lastCandidate !== undefined) {
      candidates.delete(lastCandidate);
    }
    candidates.add(candidate);
    return true;
  }
  candidates.add(candidate);
  return false;
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (
    index < text.length &&
    (text[index] === " " ||
      text[index] === "\n" ||
      text[index] === "\r" ||
      text[index] === "\t")
  ) {
    index += 1;
  }
  return index;
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
