import "server-only";

import {
  createHash,
  createHmac,
  type KeyObject,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import {
  type IdempotencyStore,
  runIdempotentOperation,
} from "@/lib/abuse/idempotency";
import {
  applicationHomePath,
  safeApplicationCallbackPath,
} from "@/lib/application-path";
import { parseCanonicalApplicationOrigin } from "@/lib/auth/application-origin";
import type {
  RunnerAuth,
  RunnerAuthenticatedSubscriber,
  RunnerSubscriberAuthorization,
} from "@/lib/runner/auth";
import type { RunnerPrincipal } from "@/lib/runner/types";
import type {
  GitHubConnectionRecord,
  ReplaceGitHubInstallationConnectionsInput,
} from "@/lib/teams/store";
import {
  GITHUB_MAX_REPOSITORIES,
  type GitHubAppClient,
  type GitHubInstallation,
  GitHubProviderError,
  type GitHubRepositorySelection,
} from "./app-auth";
import type { GitHubAppConfig, GitHubEnvironmentState } from "./config";

const STATE_VERSION = "v1";
const STATE_TTL_SECONDS = 10 * 60;
const MAX_STATE_BYTES = 4096;
const RANDOM_STATE_BYTES = 32;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TENANT = /^[A-Za-z0-9_]{1,64}$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const JTI = /^[A-Za-z0-9_-]{43}$/u;
const CALLBACK_PARAMETERS = new Set([
  "installation_id",
  "setup_action",
  "state",
]);
const INSTALL_PARAMETERS = new Set(["returnTo"]);
const IDEMPOTENCY_RETENTION_FLOOR_MS = 1000;

export type GitHubInstallStateClaims = Readonly<{
  authVersion: number;
  exp: number;
  iat: number;
  jti: string;
  returnPath: string;
  tenant: string;
  userId: string;
  v: 1;
}>;

export type GitHubInstallStateVerification =
  | Readonly<{ claims: GitHubInstallStateClaims; kind: "valid" }>
  | Readonly<{ kind: "expired" | "invalid" }>;

export type GitHubConnectionStore = Readonly<{
  disconnectGitHubConnections: (
    principal: RunnerPrincipal
  ) => Promise<{ removed: number; revokedCapabilities: number }>;
  listGitHubConnections: (
    principal: RunnerPrincipal,
    limit: number
  ) => Promise<GitHubConnectionRecord[]>;
  removeGitHubInstallationConnections: (
    principal: RunnerPrincipal,
    installationId: string
  ) => Promise<{ removed: number; revokedCapabilities: number }>;
  replaceGitHubInstallationConnections: (
    principal: RunnerPrincipal,
    input: ReplaceGitHubInstallationConnectionsInput
  ) => Promise<{
    changed: boolean;
    connections: GitHubConnectionRecord[];
  }>;
}>;

export type GitHubConnectionDependencies = Readonly<{
  appBasePath: () => string;
  appOrigin: () => string | null;
  auth: Pick<RunnerAuth, "authorizeSubscriber">;
  createProvider: (config: GitHubAppConfig) => GitHubAppClient;
  createRequestId?: () => string;
  createStore: (
    subscriber: RunnerAuthenticatedSubscriber
  ) => GitHubConnectionStore | Promise<GitHubConnectionStore>;
  enforceAbuse: (input: AbuseEnforcementInput) => Promise<AbuseAdmission>;
  getConfig: () => GitHubEnvironmentState;
  idempotencyStore: IdempotencyStore;
  now?: () => Date;
  randomBytes?: (size: number) => Uint8Array;
}>;

export type GitHubConnectionHandlers = Readonly<{
  callback: (request: Request, ip: string | null) => Promise<Response>;
  disconnect: (request: Request, ip: string | null) => Promise<Response>;
  getConnection: (request: Request, ip: string | null) => Promise<Response>;
  install: (request: Request, ip: string | null) => Promise<Response>;
}>;

type GitHubErrorCode =
  | "abuse_control_unavailable"
  | "github_callback_invalid"
  | "github_configuration_invalid"
  | "github_feature_disabled"
  | "github_installation_unusable"
  | "github_invalid_return_path"
  | "github_provider_unavailable"
  | "github_state_expired"
  | "github_state_invalid"
  | "github_state_mismatch"
  | "origin_rejected"
  | "rate_limited"
  | "request_in_progress"
  | "subscription_required"
  | "unauthorized";

type CallbackOutcome =
  | Readonly<{ code: GitHubErrorCode; kind: "error" }>
  | Readonly<{ kind: "redirect"; returnPath: string }>;

const ERROR_DEFINITIONS = {
  abuse_control_unavailable: {
    message: "Please try again later.",
    retryable: true,
    status: 503,
  },
  github_callback_invalid: {
    message: "GitHub callback validation failed.",
    retryable: false,
    status: 400,
  },
  github_configuration_invalid: {
    message: "GitHub connection configuration is unavailable.",
    retryable: true,
    status: 503,
  },
  github_feature_disabled: {
    message: "GitHub connections are not enabled.",
    retryable: false,
    status: 404,
  },
  github_installation_unusable: {
    message: "The GitHub installation cannot be used.",
    retryable: false,
    status: 409,
  },
  github_invalid_return_path: {
    message: "The return path is invalid.",
    retryable: false,
    status: 400,
  },
  github_provider_unavailable: {
    message: "GitHub is unavailable. Please try again.",
    retryable: true,
    status: 503,
  },
  github_state_expired: {
    message: "GitHub installation state has expired.",
    retryable: false,
    status: 400,
  },
  github_state_invalid: {
    message: "GitHub installation state is invalid.",
    retryable: false,
    status: 400,
  },
  github_state_mismatch: {
    message: "GitHub installation authority changed.",
    retryable: false,
    status: 403,
  },
  origin_rejected: {
    message: "Request origin was rejected.",
    retryable: false,
    status: 403,
  },
  rate_limited: {
    message: "Too many requests. Try again later.",
    retryable: true,
    status: 429,
  },
  request_in_progress: {
    message: "This GitHub callback is still being processed.",
    retryable: true,
    status: 409,
  },
  subscription_required: {
    message: "An active subscription is required.",
    retryable: false,
    status: 403,
  },
  unauthorized: {
    message: "Identity was rejected.",
    retryable: false,
    status: 401,
  },
} as const satisfies Record<
  GitHubErrorCode,
  Readonly<{ message: string; retryable: boolean; status: number }>
>;

export function createGitHubInstallState(
  input: Readonly<{
    authVersion: number;
    now: Date;
    randomBytes?: (size: number) => Uint8Array;
    returnPath: string;
    stateSigningKey: KeyObject;
    tenant: string;
    userId: string;
  }>
): string {
  assertValidStateIdentity(input);
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const entropy = (input.randomBytes ?? randomBytes)(RANDOM_STATE_BYTES);
  if (entropy.byteLength !== RANDOM_STATE_BYTES) {
    throw new Error("GitHub state entropy source returned an invalid length.");
  }
  const claims: GitHubInstallStateClaims = {
    authVersion: input.authVersion,
    exp: nowSeconds + STATE_TTL_SECONDS,
    iat: nowSeconds,
    jti: Buffer.from(entropy).toString("base64url"),
    returnPath: input.returnPath,
    tenant: input.tenant,
    userId: input.userId,
    v: 1,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  const signed = `${STATE_VERSION}.${payload}`;
  const signature = createHmac("sha256", input.stateSigningKey)
    .update(signed, "utf8")
    .digest("base64url");
  return `${signed}.${signature}`;
}

export function verifyGitHubInstallState(
  input: Readonly<{
    now: Date;
    state: string;
    stateSigningKey: KeyObject;
  }>
): GitHubInstallStateVerification {
  if (
    Number.isNaN(input.now.getTime()) ||
    Buffer.byteLength(input.state, "utf8") > MAX_STATE_BYTES
  ) {
    return { kind: "invalid" };
  }
  const [version, payload, signature, extra] = input.state.split(".");
  if (
    version !== STATE_VERSION ||
    !payload ||
    !signature ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/u.test(payload) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(signature)
  ) {
    return { kind: "invalid" };
  }

  const expected = createHmac("sha256", input.stateSigningKey)
    .update(`${version}.${payload}`, "utf8")
    .digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return { kind: "invalid" };
  }
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return { kind: "invalid" };
  }

  let claims: unknown;
  try {
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload || decoded.length > 2048) {
      return { kind: "invalid" };
    }
    claims = JSON.parse(decoded.toString("utf8"));
  } catch {
    return { kind: "invalid" };
  }
  if (!validClaims(claims)) {
    return { kind: "invalid" };
  }
  if (Math.floor(input.now.getTime() / 1000) >= claims.exp) {
    return { kind: "expired" };
  }
  return { claims, kind: "valid" };
}

export function createGitHubConnectionHandlers(
  dependencies: GitHubConnectionDependencies
): GitHubConnectionHandlers {
  const now = dependencies.now ?? (() => new Date());

  async function authorize(): Promise<
    RunnerAuthenticatedSubscriber | Response
  > {
    let authorization: RunnerSubscriberAuthorization;
    try {
      authorization = await dependencies.auth.authorizeSubscriber();
    } catch {
      return errorResponse(dependencies, "unauthorized");
    }
    return authorization.kind === "allowed"
      ? authorization
      : errorResponse(dependencies, authorization.kind);
  }

  async function admit(
    subscriber: RunnerAuthenticatedSubscriber,
    ip: string | null,
    route:
      | "github_callback"
      | "github_connection_delete"
      | "github_connection_read"
      | "github_install"
  ): Promise<Response | null> {
    let admission: AbuseAdmission;
    try {
      admission = await dependencies.enforceAbuse({
        failClosed: route === "github_install" || route === "github_callback",
        ip,
        route,
        ...(route === "github_connection_delete"
          ? { tenant: subscriber.principal.tenant }
          : { userId: subscriber.userId }),
      });
    } catch {
      admission = { kind: "unavailable", responseStatus: 503 };
    }
    if (admission.kind === "allowed") {
      return null;
    }
    return errorResponse(
      dependencies,
      admission.kind === "denied"
        ? "rate_limited"
        : "abuse_control_unavailable",
      admission.kind === "denied"
        ? { retryAfterSeconds: admission.retryAfterSeconds }
        : {}
    );
  }

  function config(): GitHubAppConfig | Response {
    let state: GitHubEnvironmentState;
    try {
      state = dependencies.getConfig();
    } catch {
      return errorResponse(dependencies, "github_configuration_invalid");
    }
    return state.enabled
      ? state
      : errorResponse(dependencies, "github_feature_disabled");
  }

  return {
    async callback(request, ip) {
      const subscriber = await authorize();
      if (subscriber instanceof Response) {
        return subscriber;
      }
      const denied = await admit(subscriber, ip, "github_callback");
      if (denied) {
        return denied;
      }

      const callback = callbackParameters(request);
      if (!callback) {
        return errorResponse(dependencies, "github_callback_invalid");
      }
      const configured = config();
      if (configured instanceof Response) {
        return configured;
      }
      const checkedState = verifyGitHubInstallState({
        now: now(),
        state: callback.state,
        stateSigningKey: configured.stateSigningKey,
      });
      if (checkedState.kind !== "valid") {
        return errorResponse(
          dependencies,
          checkedState.kind === "expired"
            ? "github_state_expired"
            : "github_state_invalid"
        );
      }
      if (!stateMatchesSubscriber(checkedState.claims, subscriber)) {
        return errorResponse(dependencies, "github_state_mismatch");
      }
      const returnPath = currentReturnPath(
        checkedState.claims.returnPath,
        dependencies
      );
      if (!returnPath) {
        return errorResponse(dependencies, "github_state_invalid");
      }

      try {
        const result = await runIdempotentOperation({
          idempotencyKey: sha256(callback.state),
          operation: `github_callback:${sha256(
            subscriber.principal.tenant
          ).slice(0, 16)}`,
          ownerId: subscriber.userId,
          perform: async () => ({
            body: await completeCallback({
              callback,
              claims: checkedState.claims,
              config: configured,
              dependencies,
              subscriber,
            }),
            status: 200,
          }),
          request: {
            installationId: callback.installationId,
            jti: checkedState.claims.jti,
            setupAction: callback.setupAction,
          },
          retentionMs: Math.max(
            IDEMPOTENCY_RETENTION_FLOOR_MS,
            checkedState.claims.exp * 1000 - now().getTime()
          ),
          store: dependencies.idempotencyStore,
        });

        if (result.kind === "in_progress") {
          return errorResponse(dependencies, "request_in_progress");
        }
        if (result.kind !== "response") {
          return errorResponse(dependencies, "github_state_invalid");
        }
        const outcome = callbackOutcome(result.response.body);
        if (!outcome) {
          return errorResponse(dependencies, "github_configuration_invalid");
        }
        if (outcome.kind === "error") {
          return errorResponse(dependencies, outcome.code);
        }
        const origin = configuredOrigin(dependencies);
        if (!origin || outcome.returnPath !== returnPath) {
          return errorResponse(dependencies, "github_configuration_invalid");
        }
        return redirectResponse(
          `${origin}${outcome.returnPath}`,
          303,
          result.replayed
        );
      } catch (error) {
        return providerOrStoreError(dependencies, error);
      }
    },

    async disconnect(request, ip) {
      const subscriber = await authorize();
      if (subscriber instanceof Response) {
        return subscriber;
      }
      const denied = await admit(subscriber, ip, "github_connection_delete");
      if (denied) {
        return denied;
      }
      if (!validMutationOrigin(request, dependencies)) {
        return errorResponse(dependencies, "origin_rejected");
      }
      try {
        const store = await dependencies.createStore(subscriber);
        await store.disconnectGitHubConnections(subscriber.principal);
      } catch {
        return errorResponse(dependencies, "github_provider_unavailable");
      }
      return new Response(null, {
        headers: { "cache-control": "no-store" },
        status: 204,
      });
    },

    async getConnection(_request, ip) {
      const subscriber = await authorize();
      if (subscriber instanceof Response) {
        return subscriber;
      }
      const denied = await admit(subscriber, ip, "github_connection_read");
      if (denied) {
        return denied;
      }
      const configured = config();
      if (configured instanceof Response) {
        return configured;
      }

      let store: GitHubConnectionStore;
      let local: GitHubConnectionRecord[];
      try {
        store = await dependencies.createStore(subscriber);
        local = await store.listGitHubConnections(
          subscriber.principal,
          GITHUB_MAX_REPOSITORIES + 1
        );
      } catch {
        return errorResponse(dependencies, "github_provider_unavailable");
      }
      if (local.length > GITHUB_MAX_REPOSITORIES) {
        return errorResponse(dependencies, "github_installation_unusable");
      }
      if (local.length === 0) {
        return publicConnections([]);
      }

      const provider = dependencies.createProvider(configured);
      const refreshed: GitHubConnectionRecord[] = [];
      const installationIds = [
        ...new Set(local.map(({ installationId }) => installationId)),
      ].sort();
      for (const installationId of installationIds) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: bounded installations must each be revalidated before disclosure
          const authority = await verifiedInstallationAuthority(
            provider,
            configured,
            installationId,
            local
              .filter(
                (connection) => connection.installationId === installationId
              )
              .map(({ repositoryId }) => repositoryId)
          );
          const replacement = await store.replaceGitHubInstallationConnections(
            subscriber.principal,
            replacementInput(subscriber.principal, authority)
          );
          refreshed.push(...replacement.connections);
        } catch (error) {
          if (terminalInstallationError(error)) {
            await store.removeGitHubInstallationConnections(
              subscriber.principal,
              installationId
            );
            return errorResponse(dependencies, "github_installation_unusable");
          }
          return providerOrStoreError(dependencies, error);
        }
      }
      return publicConnections(refreshed);
    },
    async install(request, ip) {
      const subscriber = await authorize();
      if (subscriber instanceof Response) {
        return subscriber;
      }
      const denied = await admit(subscriber, ip, "github_install");
      if (denied) {
        return denied;
      }

      const parsedReturn = installReturnPath(request, dependencies);
      if (parsedReturn instanceof Response) {
        return parsedReturn;
      }
      const configured = config();
      if (configured instanceof Response) {
        return configured;
      }

      let state: string;
      try {
        state = createGitHubInstallState({
          authVersion: subscriber.authVersion,
          now: now(),
          randomBytes: dependencies.randomBytes,
          returnPath: parsedReturn,
          stateSigningKey: configured.stateSigningKey,
          tenant: subscriber.principal.tenant,
          userId: subscriber.userId,
        });
      } catch {
        return errorResponse(dependencies, "github_configuration_invalid");
      }
      const location = new URL(
        `https://github.com/apps/${configured.appSlug}/installations/new`
      );
      location.searchParams.set("state", state);
      return redirectResponse(location.toString(), 302);
    },
  };
}

async function completeCallback(
  input: Readonly<{
    callback: Readonly<{
      installationId: string;
      setupAction: "install" | "update";
    }>;
    claims: GitHubInstallStateClaims;
    config: GitHubAppConfig;
    dependencies: GitHubConnectionDependencies;
    subscriber: RunnerAuthenticatedSubscriber;
  }>
): Promise<CallbackOutcome> {
  const store = await input.dependencies.createStore(input.subscriber);
  const provider = input.dependencies.createProvider(input.config);
  let authority: VerifiedInstallationAuthority;
  try {
    authority = await verifiedInstallationAuthority(
      provider,
      input.config,
      input.callback.installationId
    );
  } catch (error) {
    if (!terminalInstallationError(error)) {
      throw error;
    }
    await store.removeGitHubInstallationConnections(
      input.subscriber.principal,
      input.callback.installationId
    );
    return { code: "github_installation_unusable", kind: "error" };
  }

  const current = await input.dependencies.auth.authorizeSubscriber();
  if (
    current.kind !== "allowed" ||
    !stateMatchesSubscriber(input.claims, current)
  ) {
    return { code: "github_state_mismatch", kind: "error" };
  }
  await store.replaceGitHubInstallationConnections(
    input.subscriber.principal,
    replacementInput(input.subscriber.principal, authority)
  );
  return { kind: "redirect", returnPath: input.claims.returnPath };
}

type VerifiedInstallationAuthority = Readonly<{
  installation: GitHubInstallation;
  selection: GitHubRepositorySelection;
}>;

async function verifiedInstallationAuthority(
  provider: GitHubAppClient,
  config: GitHubAppConfig,
  installationId: string,
  repositoryIds?: readonly string[]
): Promise<VerifiedInstallationAuthority> {
  const installation = await provider.getInstallation(installationId);
  if (
    installation.id !== installationId ||
    installation.appId !== config.appId ||
    installation.appSlug !== config.appSlug ||
    installation.suspendedAt !== null ||
    installation.repositorySelection !== "selected" ||
    !permissionAtLeast(installation.permissions.metadata, "read") ||
    !permissionAtLeast(installation.permissions.issues, "write") ||
    !permissionAtLeast(installation.permissions.pull_requests, "write") ||
    !permissionAtLeast(installation.permissions.organization_projects, "write")
  ) {
    throw new GitHubProviderError("github_installation_unusable", {
      retryable: false,
      status: 409,
    });
  }
  const selection = await provider.listInstallationRepositories(
    installationId,
    repositoryIds
  );
  if (
    selection.repositorySelection !== "selected" ||
    selection.repositories.length < 1 ||
    selection.repositories.length > GITHUB_MAX_REPOSITORIES ||
    new Set(selection.repositories.map(({ id }) => id)).size !==
      selection.repositories.length
  ) {
    throw new GitHubProviderError("github_installation_unusable", {
      retryable: false,
      status: 409,
    });
  }
  return { installation, selection };
}

function replacementInput(
  principal: RunnerPrincipal,
  authority: VerifiedInstallationAuthority
): ReplaceGitHubInstallationConnectionsInput {
  return {
    accountId: authority.installation.account.id,
    accountLogin: authority.installation.account.login,
    accountType: authority.installation.account.type,
    installationId: authority.installation.id,
    repositories: authority.selection.repositories
      .map((repository) => ({
        id: deterministicConnectionId(principal.tenant, repository.id),
        repositoryId: repository.id,
        repositoryName: repository.name,
        repositoryNodeId: repository.nodeId,
        repositoryOwner: repository.owner,
      }))
      .sort((left, right) =>
        left.repositoryId.localeCompare(right.repositoryId)
      ),
  };
}

function deterministicConnectionId(tenant: string, repositoryId: string) {
  const bytes = createHash("sha256")
    .update("github-connection\0", "utf8")
    .update(tenant, "utf8")
    .update("\0", "utf8")
    .update(repositoryId, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function terminalInstallationError(error: unknown): boolean {
  return (
    error instanceof GitHubProviderError &&
    !error.retryable &&
    [
      "github_installation_missing",
      "github_installation_unusable",
      "github_provider_forbidden",
      "github_provider_rejected",
      "github_repository_limit",
    ].includes(error.code)
  );
}

function permissionAtLeast(
  value: unknown,
  required: "read" | "write"
): boolean {
  if (required === "read") {
    return value === "read" || value === "write" || value === "admin";
  }
  return value === "write" || value === "admin";
}

function callbackParameters(request: Request): Readonly<{
  installationId: string;
  setupAction: "install" | "update";
  state: string;
}> | null {
  const entries = [...new URL(request.url).searchParams.entries()];
  if (
    entries.length !== CALLBACK_PARAMETERS.size ||
    entries.some(([name]) => !CALLBACK_PARAMETERS.has(name)) ||
    new Set(entries.map(([name]) => name)).size !== entries.length
  ) {
    return null;
  }
  const parameters = new URL(request.url).searchParams;
  const installationId = parameters.get("installation_id");
  const setupAction = parameters.get("setup_action");
  const state = parameters.get("state");
  if (
    !installationId ||
    !DECIMAL_ID.test(installationId) ||
    (setupAction !== "install" && setupAction !== "update") ||
    !state ||
    Buffer.byteLength(state, "utf8") > MAX_STATE_BYTES
  ) {
    return null;
  }
  return { installationId, setupAction, state };
}

function installReturnPath(
  request: Request,
  dependencies: GitHubConnectionDependencies
): string | Response {
  const entries = [...new URL(request.url).searchParams.entries()];
  if (
    entries.some(([name]) => !INSTALL_PARAMETERS.has(name)) ||
    entries.filter(([name]) => name === "returnTo").length > 1
  ) {
    return errorResponse(dependencies, "github_invalid_return_path");
  }
  let basePath: string;
  try {
    basePath = dependencies.appBasePath();
  } catch {
    return errorResponse(dependencies, "github_configuration_invalid");
  }
  const supplied = new URL(request.url).searchParams.get("returnTo");
  if (supplied === null) {
    return applicationHomePath(basePath);
  }
  const safe = safeApplicationCallbackPath(supplied, basePath);
  return safe === supplied
    ? safe
    : errorResponse(dependencies, "github_invalid_return_path");
}

function currentReturnPath(
  value: string,
  dependencies: GitHubConnectionDependencies
): string | null {
  try {
    const safe = safeApplicationCallbackPath(value, dependencies.appBasePath());
    return safe === value ? safe : null;
  } catch {
    return null;
  }
}

function validMutationOrigin(
  request: Request,
  dependencies: GitHubConnectionDependencies
): boolean {
  const expected = configuredOrigin(dependencies);
  const supplied = request.headers.get("origin");
  let requestOrigin: string;
  try {
    requestOrigin = parseCanonicalApplicationOrigin(
      "Request origin",
      new URL(request.url).origin
    );
  } catch {
    return false;
  }
  if (!expected || !supplied) {
    return false;
  }
  try {
    return (
      parseCanonicalApplicationOrigin("Origin", supplied) === expected &&
      requestOrigin === expected
    );
  } catch {
    return false;
  }
}

function configuredOrigin(
  dependencies: GitHubConnectionDependencies
): string | null {
  try {
    const value = dependencies.appOrigin();
    return value
      ? parseCanonicalApplicationOrigin("Application origin", value)
      : null;
  } catch {
    return null;
  }
}

function publicConnections(connections: readonly GitHubConnectionRecord[]) {
  return Response.json(
    {
      connected: connections.length > 0,
      connections: [...connections]
        .sort((left, right) =>
          `${left.repositoryOwner}/${left.repositoryName}`.localeCompare(
            `${right.repositoryOwner}/${right.repositoryName}`
          )
        )
        .slice(0, GITHUB_MAX_REPOSITORIES)
        .map((connection) => ({
          account: {
            login: connection.accountLogin,
            type: connection.accountType,
          },
          installationId: connection.installationId,
          repository: {
            id: connection.repositoryId,
            name: connection.repositoryName,
            owner: connection.repositoryOwner,
          },
          updatedAt: connection.updatedAt.toISOString(),
        })),
    },
    { headers: { "cache-control": "no-store" } }
  );
}

function callbackOutcome(value: unknown): CallbackOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    body.kind === "redirect" &&
    typeof body.returnPath === "string" &&
    Object.keys(body).length === 2
  ) {
    return { kind: "redirect", returnPath: body.returnPath };
  }
  if (
    body.kind === "error" &&
    typeof body.code === "string" &&
    Object.hasOwn(ERROR_DEFINITIONS, body.code) &&
    Object.keys(body).length === 2
  ) {
    return { code: body.code as GitHubErrorCode, kind: "error" };
  }
  return null;
}

function providerOrStoreError(
  dependencies: GitHubConnectionDependencies,
  error: unknown
): Response {
  if (
    error instanceof GitHubProviderError &&
    error.code === "github_provider_rate_limited"
  ) {
    return errorResponse(dependencies, "rate_limited");
  }
  return errorResponse(dependencies, "github_provider_unavailable");
}

function errorResponse(
  dependencies: GitHubConnectionDependencies,
  code: GitHubErrorCode,
  options: Readonly<{ retryAfterSeconds?: number }> = {}
): Response {
  const definition = ERROR_DEFINITIONS[code];
  const headers = new Headers({ "cache-control": "no-store" });
  if (
    options.retryAfterSeconds !== undefined &&
    Number.isSafeInteger(options.retryAfterSeconds) &&
    options.retryAfterSeconds > 0
  ) {
    headers.set("retry-after", String(options.retryAfterSeconds));
  }
  return Response.json(
    {
      error: {
        code,
        message: definition.message,
        retryable: definition.retryable,
      },
      requestId: safeRequestId(dependencies),
    },
    { headers, status: definition.status }
  );
}

function redirectResponse(
  location: string,
  status: 302 | 303,
  replayed = false
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    location,
  });
  if (replayed) {
    headers.set("github-callback-replayed", "true");
  }
  return new Response(null, { headers, status });
}

function safeRequestId(dependencies: GitHubConnectionDependencies): string {
  const candidate = dependencies.createRequestId?.() ?? randomUUID();
  return typeof candidate === "string" &&
    /^[A-Za-z0-9_.:-]{1,128}$/u.test(candidate)
    ? candidate
    : randomUUID();
}

function stateMatchesSubscriber(
  claims: GitHubInstallStateClaims,
  subscriber: RunnerAuthenticatedSubscriber
): boolean {
  return (
    claims.userId === subscriber.userId &&
    claims.tenant === subscriber.principal.tenant &&
    claims.authVersion === subscriber.authVersion
  );
}

function assertValidStateIdentity(
  input: Readonly<{
    authVersion: number;
    now: Date;
    returnPath: string;
    tenant: string;
    userId: string;
  }>
): void {
  if (
    !Number.isSafeInteger(input.authVersion) ||
    input.authVersion < 0 ||
    Number.isNaN(input.now.getTime()) ||
    !UUID.test(input.userId) ||
    !TENANT.test(input.tenant) ||
    !canonicalSameOriginPath(input.returnPath)
  ) {
    throw new Error("GitHub installation state claims are invalid.");
  }
}

function validClaims(value: unknown): value is GitHubInstallStateClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  if (
    Object.keys(claims).sort().join(",") !==
    "authVersion,exp,iat,jti,returnPath,tenant,userId,v"
  ) {
    return false;
  }
  return (
    claims.v === 1 &&
    Number.isSafeInteger(claims.authVersion) &&
    Number(claims.authVersion) >= 0 &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp) &&
    Number(claims.exp) > Number(claims.iat) &&
    Number(claims.exp) - Number(claims.iat) <= STATE_TTL_SECONDS &&
    typeof claims.jti === "string" &&
    JTI.test(claims.jti) &&
    typeof claims.userId === "string" &&
    UUID.test(claims.userId) &&
    typeof claims.tenant === "string" &&
    TENANT.test(claims.tenant) &&
    typeof claims.returnPath === "string" &&
    canonicalSameOriginPath(claims.returnPath)
  );
}

function canonicalSameOriginPath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 2048 ||
    value !== value.trim() ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\0")
  ) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://application-path.invalid");
    return (
      parsed.origin === "https://application-path.invalid" &&
      `${parsed.pathname}${parsed.search}${parsed.hash}` === value &&
      !parsed.pathname.includes("%")
    );
  } catch {
    return false;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
