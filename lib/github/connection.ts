import "server-only";

import {
  createHash,
  createHmac,
  type KeyObject,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { isCanonicalUuid } from "@opencoven/agent-contracts";
import type {
  AbuseAdmission,
  AbuseEnforcementInput,
} from "@/lib/abuse/enforce";
import {
  type IdempotencyCompleteInput,
  type IdempotencyStore,
  runIdempotentOperation,
} from "@/lib/abuse/idempotency";
import {
  applicationHomePath,
  safeApplicationCallbackPath,
} from "@/lib/application-path";
import { compareAscii } from "@/lib/ascii";
import { parseCanonicalApplicationOrigin } from "@/lib/auth/application-origin";
import type {
  RunnerAuth,
  RunnerAuthenticatedSubscriber,
  RunnerSubscriberAuthorization,
} from "@/lib/runner/auth";
import type { RunnerPrincipal } from "@/lib/runner/types";
import type {
  ConnectGitHubInstallationConnectionsResult,
  FencedGitHubInstallationConnectionsInput,
  GitHubConnectionPhaseControl,
  GitHubConnectionRecord,
  GitHubConnectionSnapshot,
  RefreshGitHubInstallationConnectionsResult,
  RemoveGitHubInstallationConnectionsResult,
  ReplaceGitHubInstallationConnectionsInput,
} from "@/lib/teams/store";
import {
  GITHUB_MAX_REPOSITORIES,
  type GitHubConnectionAppClient,
  type GitHubInstallation,
  GitHubProviderError,
  normalizedAppPermission,
} from "./app-auth";
import { clampUserPermission } from "./authority-types";
import type { GitHubAppConfig, GitHubEnvironmentState } from "./config";
import type {
  GitHubUserAuthorizationClient,
  GitHubUserInstallationAuthority,
} from "./user-auth";

const INSTALL_STATE_VERSION = "v1";
const USER_AUTHORIZATION_STATE_VERSION = "v2";
const STATE_TTL_SECONDS = 10 * 60;
const MAX_STATE_BYTES = 4096;
const STATE_SIGNATURE_CHARACTERS = 43;
const STATE_ENVELOPE_CHARACTERS =
  Math.max(
    INSTALL_STATE_VERSION.length,
    USER_AUTHORIZATION_STATE_VERSION.length
  ) +
  2 +
  STATE_SIGNATURE_CHARACTERS;
const MAX_STATE_PAYLOAD_BYTES = Math.floor(
  ((MAX_STATE_BYTES - STATE_ENVELOPE_CHARACTERS) * 3) / 4
);
export const GITHUB_RETURN_PATH_MAX_ENCODED_BYTES = 2048;
const RANDOM_STATE_BYTES = 32;
const TENANT = /^[A-Za-z0-9_]{1,64}$/u;
const DECIMAL_ID = /^[1-9][0-9]{0,19}$/u;
const JTI = /^[A-Za-z0-9_-]{43}$/u;
const CALLBACK_PARAMETERS = new Set([
  "installation_id",
  "setup_action",
  "state",
]);
const OAUTH_CALLBACK_PARAMETERS = new Set(["code", "state"]);
const INSTALL_PARAMETERS = new Set(["returnTo"]);
const IDEMPOTENCY_RETENTION_FLOOR_MS = 1000;
const CALLBACK_PROCESSING_LEASE_MS = 10 * 60_000;
const OAUTH_CODE = /^[A-Za-z0-9._~-]{1,1024}$/u;

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

type GitHubUserAuthorizationStateClaims = Readonly<{
  authVersion: number;
  exp: number;
  iat: number;
  installationId: string;
  jti: string;
  returnPath: string;
  tenant: string;
  userId: string;
  v: 2;
}>;

type GitHubUserAuthorizationStateVerification =
  | Readonly<{
      claims: GitHubUserAuthorizationStateClaims;
      kind: "valid";
    }>
  | Readonly<{ kind: "expired" | "invalid" }>;

export type GitHubConnectionStore = Readonly<{
  connectGitHubInstallationConnections: (
    principal: RunnerPrincipal,
    input: FencedGitHubInstallationConnectionsInput
  ) => Promise<ConnectGitHubInstallationConnectionsResult>;
  disconnectGitHubConnections: (
    principal: RunnerPrincipal
  ) => Promise<{ removed: number; revokedCapabilities: number }>;
  readGitHubConnectionSnapshot: (
    principal: RunnerPrincipal,
    limit: number,
    control?: GitHubConnectionPhaseControl
  ) => Promise<GitHubConnectionSnapshot>;
  refreshGitHubInstallationConnections: (
    principal: RunnerPrincipal,
    input: FencedGitHubInstallationConnectionsInput
  ) => Promise<RefreshGitHubInstallationConnectionsResult>;
  removeGitHubInstallationConnectionsIfCurrent: (
    principal: RunnerPrincipal,
    input: GitHubConnectionPhaseControl & {
      expectedGeneration: number;
      installationId: string;
    }
  ) => Promise<RemoveGitHubInstallationConnectionsResult>;
}>;

export type GitHubConnectionDependencies = Readonly<{
  appBasePath: () => string;
  appOrigin: () => string | null;
  auth: Pick<RunnerAuth, "authorizeSubscriber">;
  createProvider: (config: GitHubAppConfig) => GitHubConnectionAppClient;
  createUserAuthorizationClient: (
    config: GitHubAppConfig
  ) => GitHubUserAuthorizationClient;
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

export type GitHubConnectionAuthorityRefreshResult =
  | Readonly<{ kind: "current"; snapshot: GitHubConnectionSnapshot }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "unusable" }>;

type GitHubErrorCode =
  | "abuse_control_unavailable"
  | "github_callback_invalid"
  | "github_configuration_invalid"
  | "github_feature_disabled"
  | "github_installation_access_denied"
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
  | Readonly<{ authorizationState: string; kind: "authorize" }>
  | Readonly<{
      installationId: string;
      kind: "consumed";
      returnPath: string;
    }>
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
  github_installation_access_denied: {
    message: "The GitHub installation is not accessible to this user.",
    retryable: false,
    status: 403,
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
  return createSignedState(
    INSTALL_STATE_VERSION,
    claims,
    input.stateSigningKey
  );
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
    version !== INSTALL_STATE_VERSION ||
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
    supplied.toString("base64url") !== signature ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return { kind: "invalid" };
  }

  let claims: unknown;
  try {
    const decoded = Buffer.from(payload, "base64url");
    if (
      decoded.toString("base64url") !== payload ||
      decoded.length > MAX_STATE_PAYLOAD_BYTES
    ) {
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

function createGitHubUserAuthorizationState(
  input: Readonly<{
    authVersion: number;
    installationId: string;
    now: Date;
    randomBytes?: (size: number) => Uint8Array;
    returnPath: string;
    stateSigningKey: KeyObject;
    tenant: string;
    userId: string;
  }>
): string {
  assertValidStateIdentity(input);
  if (!DECIMAL_ID.test(input.installationId)) {
    throw new Error("GitHub user authorization installation is invalid.");
  }
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const entropy = (input.randomBytes ?? randomBytes)(RANDOM_STATE_BYTES);
  if (entropy.byteLength !== RANDOM_STATE_BYTES) {
    throw new Error("GitHub state entropy source returned an invalid length.");
  }
  const claims: GitHubUserAuthorizationStateClaims = {
    authVersion: input.authVersion,
    exp: nowSeconds + STATE_TTL_SECONDS,
    iat: nowSeconds,
    installationId: input.installationId,
    jti: Buffer.from(entropy).toString("base64url"),
    returnPath: input.returnPath,
    tenant: input.tenant,
    userId: input.userId,
    v: 2,
  };
  return createSignedState(
    USER_AUTHORIZATION_STATE_VERSION,
    claims,
    input.stateSigningKey
  );
}

function verifyGitHubUserAuthorizationState(
  input: Readonly<{
    now: Date;
    state: string;
    stateSigningKey: KeyObject;
  }>
): GitHubUserAuthorizationStateVerification {
  if (
    Number.isNaN(input.now.getTime()) ||
    Buffer.byteLength(input.state, "utf8") > MAX_STATE_BYTES
  ) {
    return { kind: "invalid" };
  }
  const [version, payload, signature, extra] = input.state.split(".");
  if (
    version !== USER_AUTHORIZATION_STATE_VERSION ||
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
    supplied.toString("base64url") !== signature ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return { kind: "invalid" };
  }
  let claims: unknown;
  try {
    const decoded = Buffer.from(payload, "base64url");
    if (
      decoded.toString("base64url") !== payload ||
      decoded.length > MAX_STATE_PAYLOAD_BYTES
    ) {
      return { kind: "invalid" };
    }
    claims = JSON.parse(decoded.toString("utf8"));
  } catch {
    return { kind: "invalid" };
  }
  if (!validUserAuthorizationClaims(claims)) {
    return { kind: "invalid" };
  }
  if (Math.floor(input.now.getTime() / 1000) >= claims.exp) {
    return { kind: "expired" };
  }
  return { claims, kind: "valid" };
}

function createSignedState(
  version: string,
  claims: GitHubInstallStateClaims | GitHubUserAuthorizationStateClaims,
  stateSigningKey: KeyObject
): string {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url"
  );
  const signed = `${version}.${payload}`;
  const signature = createHmac("sha256", stateSigningKey)
    .update(signed, "utf8")
    .digest("base64url");
  const state = `${signed}.${signature}`;
  if (Buffer.byteLength(state, "utf8") > MAX_STATE_BYTES) {
    throw new Error("GitHub state exceeds its encoded bound.");
  }
  return state;
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
      return callback.kind === "installation"
        ? installationSetupCallback({
            callback,
            config: configured,
            dependencies,
            now,
            subscriber,
          })
        : userAuthorizationCallback({
            callback,
            config: configured,
            dependencies,
            now,
            subscriber,
          });
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
      let snapshot: GitHubConnectionSnapshot;
      try {
        store = await dependencies.createStore(subscriber);
        snapshot = await store.readGitHubConnectionSnapshot(
          subscriber.principal,
          GITHUB_MAX_REPOSITORIES + 1
        );
      } catch {
        return errorResponse(dependencies, "github_provider_unavailable");
      }
      const { connections: local } = snapshot;
      if (local.length > GITHUB_MAX_REPOSITORIES) {
        return errorResponse(dependencies, "github_installation_unusable");
      }
      if (local.length === 0) {
        return publicConnections([]);
      }

      let refreshed: GitHubConnectionAuthorityRefreshResult;
      try {
        refreshed = await refreshGitHubConnectionAuthority({
          config: configured,
          principal: subscriber.principal,
          provider: dependencies.createProvider(configured),
          snapshot,
          store,
        });
      } catch (error) {
        return providerOrStoreError(dependencies, error);
      }
      if (refreshed.kind === "stale") {
        return errorResponse(dependencies, "request_in_progress");
      }
      if (refreshed.kind === "unusable") {
        return errorResponse(dependencies, "github_installation_unusable");
      }
      return publicConnections(refreshed.snapshot.connections);
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

export async function refreshGitHubConnectionAuthority(
  input: Readonly<{
    abortSignal?: AbortSignal;
    config: GitHubAppConfig;
    deadlineAt?: number;
    principal: RunnerPrincipal;
    provider: GitHubConnectionAppClient;
    snapshot?: GitHubConnectionSnapshot;
    store: GitHubConnectionStore;
  }>
): Promise<GitHubConnectionAuthorityRefreshResult> {
  const control: GitHubConnectionPhaseControl = {
    abortSignal: input.abortSignal,
    deadlineAt: input.deadlineAt,
  };
  const assertLive = () => {
    input.abortSignal?.throwIfAborted();
    if (
      input.deadlineAt !== undefined &&
      (!Number.isSafeInteger(input.deadlineAt) ||
        input.deadlineAt <= Date.now())
    ) {
      throw new Error("GitHub connection authority deadline exceeded.");
    }
  };
  assertLive();
  const initial =
    input.snapshot ??
    (await input.store.readGitHubConnectionSnapshot(
      input.principal,
      GITHUB_MAX_REPOSITORIES + 1,
      control
    ));
  assertLive();
  if (initial.connections.length > GITHUB_MAX_REPOSITORIES) {
    return { kind: "unusable" };
  }
  let { generation } = initial;
  const installationIds = [
    ...new Set(initial.connections.map(({ installationId }) => installationId)),
  ].sort();
  const verified = await Promise.all(
    installationIds.map(async (installationId) => {
      assertLive();
      try {
        const authority = await verifiedInstallationAuthority(
          input.provider,
          input.config,
          installationId,
          {
            existing: initial.connections.filter(
              (connection) => connection.installationId === installationId
            ),
          }
        );
        assertLive();
        return {
          authority,
          installationId,
          kind: "current" as const,
        };
      } catch (error) {
        if (!terminalInstallationError(error)) {
          throw error;
        }
        return { installationId, kind: "unusable" as const };
      }
    })
  );
  for (const current of verified) {
    const { installationId } = current;
    if (current.kind === "unusable") {
      const removal =
        // biome-ignore lint/performance/noAwaitInLoops: generation-fenced writes must remain serialized
        await input.store.removeGitHubInstallationConnectionsIfCurrent(
          input.principal,
          {
            ...control,
            expectedGeneration: generation,
            installationId,
          }
        );
      if (removal.kind === "stale") {
        return { kind: "stale" };
      }
      return { kind: "unusable" };
    }
    const replacement = await input.store.refreshGitHubInstallationConnections(
      input.principal,
      {
        ...control,
        ...replacementInput(input.principal, current.authority),
        expectedGeneration: generation,
      }
    );
    if (replacement.kind === "stale") {
      return { kind: "stale" };
    }
    ({ generation } = replacement);
  }
  const snapshot = await input.store.readGitHubConnectionSnapshot(
    input.principal,
    GITHUB_MAX_REPOSITORIES + 1,
    control
  );
  assertLive();
  if (
    snapshot.generation !== generation ||
    snapshot.connections.length < 1 ||
    snapshot.connections.length > GITHUB_MAX_REPOSITORIES
  ) {
    return { kind: "stale" };
  }
  return { kind: "current", snapshot };
}

async function installationSetupCallback(
  input: Readonly<{
    callback: Readonly<{
      kind: "installation";
      installationId: string;
      setupAction: "install" | "update";
      state: string;
    }>;
    config: GitHubAppConfig;
    dependencies: GitHubConnectionDependencies;
    now: () => Date;
    subscriber: RunnerAuthenticatedSubscriber;
  }>
): Promise<Response> {
  const checkedState = verifyGitHubInstallState({
    now: input.now(),
    state: input.callback.state,
    stateSigningKey: input.config.stateSigningKey,
  });
  if (checkedState.kind !== "valid") {
    return errorResponse(
      input.dependencies,
      checkedState.kind === "expired"
        ? "github_state_expired"
        : "github_state_invalid"
    );
  }
  if (!stateMatchesSubscriber(checkedState.claims, input.subscriber)) {
    return errorResponse(input.dependencies, "github_state_mismatch");
  }
  const returnPath = currentReturnPath(
    checkedState.claims.returnPath,
    input.dependencies
  );
  const callbackUrl = configuredGitHubCallbackUrl(input.dependencies);
  if (!returnPath) {
    return errorResponse(input.dependencies, "github_state_invalid");
  }
  if (!callbackUrl) {
    return errorResponse(input.dependencies, "github_configuration_invalid");
  }

  try {
    const result = await runIdempotentOperation({
      idempotencyKey: stateIdempotencyKey(checkedState.claims),
      now: input.now,
      operation: callbackOperation(
        "github_install_setup",
        input.subscriber.principal.tenant
      ),
      ownerId: input.subscriber.userId,
      perform: async () => ({
        body: {
          authorizationState: createGitHubUserAuthorizationState({
            authVersion: checkedState.claims.authVersion,
            installationId: input.callback.installationId,
            now: input.now(),
            randomBytes: input.dependencies.randomBytes,
            returnPath,
            stateSigningKey: input.config.stateSigningKey,
            tenant: checkedState.claims.tenant,
            userId: checkedState.claims.userId,
          }),
          kind: "authorize",
        },
        status: 200,
      }),
      request: {
        installationId: input.callback.installationId,
        jti: checkedState.claims.jti,
        setupAction: input.callback.setupAction,
      },
      retentionMs: stateRetentionMs(checkedState.claims.exp, input.now()),
      store: input.dependencies.idempotencyStore,
    });
    if (result.kind === "in_progress") {
      return errorResponse(input.dependencies, "request_in_progress");
    }
    if (result.kind !== "response") {
      return errorResponse(input.dependencies, "github_state_invalid");
    }
    const outcome = callbackOutcome(result.response.body);
    if (outcome?.kind !== "authorize") {
      return errorResponse(input.dependencies, "github_configuration_invalid");
    }
    const authorizationState = verifyGitHubUserAuthorizationState({
      now: input.now(),
      state: outcome.authorizationState,
      stateSigningKey: input.config.stateSigningKey,
    });
    if (
      authorizationState.kind !== "valid" ||
      authorizationState.claims.installationId !==
        input.callback.installationId ||
      authorizationState.claims.returnPath !== returnPath ||
      !stateMatchesSubscriber(authorizationState.claims, input.subscriber)
    ) {
      return errorResponse(input.dependencies, "github_configuration_invalid");
    }
    return redirectResponse(
      githubUserAuthorizationUrl({
        callbackUrl,
        clientId: input.config.clientId,
        codeChallenge: githubCodeChallenge(
          githubCodeVerifier(
            authorizationState.claims,
            input.config.stateSigningKey
          )
        ),
        state: outcome.authorizationState,
      }),
      302,
      result.replayed
    );
  } catch (error) {
    return providerOrStoreError(input.dependencies, error);
  }
}

async function userAuthorizationCallback(
  input: Readonly<{
    callback: Readonly<{ code: string; kind: "oauth"; state: string }>;
    config: GitHubAppConfig;
    dependencies: GitHubConnectionDependencies;
    now: () => Date;
    subscriber: RunnerAuthenticatedSubscriber;
  }>
): Promise<Response> {
  const checkedState = verifyGitHubUserAuthorizationState({
    now: input.now(),
    state: input.callback.state,
    stateSigningKey: input.config.stateSigningKey,
  });
  if (checkedState.kind !== "valid") {
    return errorResponse(
      input.dependencies,
      checkedState.kind === "expired"
        ? "github_state_expired"
        : "github_state_invalid"
    );
  }
  if (!stateMatchesSubscriber(checkedState.claims, input.subscriber)) {
    return errorResponse(input.dependencies, "github_state_mismatch");
  }
  const returnPath = currentReturnPath(
    checkedState.claims.returnPath,
    input.dependencies
  );
  const callbackUrl = configuredGitHubCallbackUrl(input.dependencies);
  if (!returnPath) {
    return errorResponse(input.dependencies, "github_state_invalid");
  }
  if (!callbackUrl) {
    return errorResponse(input.dependencies, "github_configuration_invalid");
  }

  let consumedCompletion: IdempotencyCompleteInput | null = null;
  let result: Awaited<ReturnType<typeof runIdempotentOperation>>;
  try {
    result = await runIdempotentOperation({
      completeSuccessfulResponse: async (completion) => {
        const processingCompletion = {
          ...completion,
          expiresAt: new Date(
            completion.completedAt.getTime() + CALLBACK_PROCESSING_LEASE_MS
          ),
        };
        const completed =
          await input.dependencies.idempotencyStore.complete(
            processingCompletion
          );
        if (completed === "completed") {
          consumedCompletion = processingCompletion;
        }
        return completed;
      },
      idempotencyKey: stateIdempotencyKey(checkedState.claims),
      now: input.now,
      operation: callbackOperation(
        "github_user_authorization",
        input.subscriber.principal.tenant
      ),
      ownerId: input.subscriber.userId,
      perform: async () => ({
        body: {
          installationId: checkedState.claims.installationId,
          kind: "consumed",
          returnPath,
        },
        status: 200,
      }),
      request: {
        codeHash: sha256(input.callback.code),
        installationId: checkedState.claims.installationId,
        jti: checkedState.claims.jti,
      },
      retentionMs: stateRetentionMs(checkedState.claims.exp, input.now()),
      store: input.dependencies.idempotencyStore,
    });
  } catch (error) {
    return providerOrStoreError(input.dependencies, error);
  }
  if (result.kind === "in_progress") {
    return errorResponse(input.dependencies, "request_in_progress");
  }
  if (result.kind !== "response") {
    return errorResponse(input.dependencies, "github_state_invalid");
  }
  const storedOutcome = callbackOutcome(result.response.body);
  if (!storedOutcome) {
    return errorResponse(input.dependencies, "github_configuration_invalid");
  }
  if (result.replayed) {
    if (
      storedOutcome.kind === "redirect" &&
      storedOutcome.returnPath === returnPath
    ) {
      return redirectResponse(
        `${callbackUrl.origin}${storedOutcome.returnPath}`,
        303,
        true
      );
    }
    if (storedOutcome.kind === "error") {
      return errorResponse(input.dependencies, storedOutcome.code);
    }
    if (storedOutcome.kind === "consumed") {
      return errorResponse(input.dependencies, "request_in_progress");
    }
    return errorResponse(input.dependencies, "github_state_invalid");
  }
  if (
    storedOutcome.kind !== "consumed" ||
    storedOutcome.installationId !== checkedState.claims.installationId ||
    storedOutcome.returnPath !== returnPath ||
    consumedCompletion === null
  ) {
    return errorResponse(input.dependencies, "github_configuration_invalid");
  }

  const outcome = await completeUserAuthorization({
    callback: input.callback,
    callbackUrl: callbackUrl.url,
    claims: checkedState.claims,
    config: input.config,
    dependencies: input.dependencies,
    subscriber: input.subscriber,
  });
  try {
    const completedAt = input.now();
    await replaceConsumedOutcome(
      input.dependencies.idempotencyStore,
      consumedCompletion,
      outcome,
      completedAt,
      stateRetentionMs(checkedState.claims.exp, completedAt)
    );
  } catch {
    return errorResponse(input.dependencies, "github_provider_unavailable");
  }
  if (outcome.kind === "error") {
    return errorResponse(input.dependencies, outcome.code);
  }
  return redirectResponse(`${callbackUrl.origin}${outcome.returnPath}`, 303);
}

async function completeUserAuthorization(
  input: Readonly<{
    callback: Readonly<{ code: string }>;
    callbackUrl: string;
    claims: GitHubUserAuthorizationStateClaims;
    config: GitHubAppConfig;
    dependencies: GitHubConnectionDependencies;
    subscriber: RunnerAuthenticatedSubscriber;
  }>
): Promise<Extract<CallbackOutcome, { kind: "error" | "redirect" }>> {
  let store: GitHubConnectionStore;
  let snapshot: GitHubConnectionSnapshot;
  try {
    store = await input.dependencies.createStore(input.subscriber);
    snapshot = await store.readGitHubConnectionSnapshot(
      input.subscriber.principal,
      GITHUB_MAX_REPOSITORIES + 1
    );
  } catch (error) {
    return { code: callbackErrorCode(error), kind: "error" };
  }
  if (snapshot.connections.length > GITHUB_MAX_REPOSITORIES) {
    return { code: "github_installation_unusable", kind: "error" };
  }

  let userAuthority: GitHubUserInstallationAuthority;
  try {
    userAuthority = await input.dependencies
      .createUserAuthorizationClient(input.config)
      .proveInstallationAccess({
        code: input.callback.code,
        codeVerifier: githubCodeVerifier(
          input.claims,
          input.config.stateSigningKey
        ),
        installationId: input.claims.installationId,
        redirectUri: input.callbackUrl,
      });
  } catch (error) {
    return {
      code: callbackErrorCode(error),
      kind: "error",
    };
  }

  let authority: VerifiedInstallationAuthority;
  try {
    authority = await verifiedInstallationAuthority(
      input.dependencies.createProvider(input.config),
      input.config,
      input.claims.installationId,
      { userAuthority }
    );
  } catch (error) {
    if (!terminalInstallationError(error)) {
      return { code: callbackErrorCode(error), kind: "error" };
    }
    try {
      const removal = await store.removeGitHubInstallationConnectionsIfCurrent(
        input.subscriber.principal,
        {
          expectedGeneration: snapshot.generation,
          installationId: input.claims.installationId,
        }
      );
      if (removal.kind === "stale") {
        return { code: "request_in_progress", kind: "error" };
      }
    } catch {
      return { code: "github_provider_unavailable", kind: "error" };
    }
    return { code: "github_installation_unusable", kind: "error" };
  }

  let current: RunnerSubscriberAuthorization;
  try {
    current = await input.dependencies.auth.authorizeSubscriber();
  } catch {
    return { code: "github_state_mismatch", kind: "error" };
  }
  if (
    current.kind !== "allowed" ||
    !stateMatchesSubscriber(input.claims, current)
  ) {
    return { code: "github_state_mismatch", kind: "error" };
  }
  try {
    const connected = await store.connectGitHubInstallationConnections(
      input.subscriber.principal,
      {
        ...replacementInput(input.subscriber.principal, authority),
        expectedGeneration: snapshot.generation,
      }
    );
    if (connected.kind === "stale") {
      return { code: "request_in_progress", kind: "error" };
    }
  } catch {
    return { code: "github_provider_unavailable", kind: "error" };
  }
  return { kind: "redirect", returnPath: input.claims.returnPath };
}

type VerifiedInstallationAuthority = Readonly<{
  installation: GitHubInstallation;
  repositories: ReplaceGitHubInstallationConnectionsInput["repositories"];
}>;

async function verifiedInstallationAuthority(
  provider: GitHubConnectionAppClient,
  config: GitHubAppConfig,
  installationId: string,
  input:
    | Readonly<{
        existing: readonly GitHubConnectionRecord[];
      }>
    | Readonly<{
        userAuthority: GitHubUserInstallationAuthority;
      }>
): Promise<VerifiedInstallationAuthority> {
  const installation = await provider.getInstallation(installationId);
  const appContentsPermission = normalizedAppPermission(
    installation.permissions.contents
  );
  const appIssuesPermission = normalizedAppPermission(
    installation.permissions.issues
  );
  const appPullRequestsPermission = normalizedAppPermission(
    installation.permissions.pull_requests
  );
  const appOrganizationProjectsPermission = normalizedAppPermission(
    installation.permissions.organization_projects
  );
  if (
    installation.id !== installationId ||
    installation.appId !== config.appId ||
    installation.appSlug !== config.appSlug ||
    installation.suspendedAt !== null ||
    installation.repositorySelection !== "selected" ||
    !permissionAtLeast(installation.permissions.metadata, "read") ||
    (appContentsPermission === "none" &&
      appIssuesPermission === "none" &&
      appPullRequestsPermission === "none")
  ) {
    throw new GitHubProviderError("github_installation_unusable", {
      retryable: false,
      status: 409,
    });
  }
  const selection = await provider.listInstallationRepositories(installationId);
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
  const selectedById = new Map(
    selection.repositories.map((repository) => [repository.id, repository])
  );
  const repositories: ReplaceGitHubInstallationConnectionsInput["repositories"] =
    [];
  if ("userAuthority" in input) {
    for (const userRepository of input.userAuthority.repositories) {
      const selected = selectedById.get(userRepository.id);
      if (!selected) {
        continue;
      }
      if (
        selected.name !== userRepository.name ||
        selected.nodeId !== userRepository.nodeId ||
        selected.owner !== userRepository.owner
      ) {
        throw new GitHubProviderError("github_provider_invalid_response", {
          retryable: false,
          status: 502,
        });
      }
      repositories.push({
        appContentsPermission,
        appIssuesPermission,
        appOrganizationProjectsPermission,
        appPullRequestsPermission,
        githubUserId: input.userAuthority.user.id,
        githubUserLogin: input.userAuthority.user.login,
        id: deterministicConnectionId(config.appId, selected.id),
        repositoryId: selected.id,
        repositoryName: selected.name,
        repositoryNodeId: selected.nodeId,
        repositoryOwner: selected.owner,
        userPermissionCeiling: userRepository.permission,
        userPermissionCurrent: userRepository.permission,
        userProjectManagementCeiling: false,
        userProjectManagementCurrent: false,
      });
    }
  } else {
    const selectedExisting = input.existing.flatMap((existing) => {
      const selected = selectedById.get(existing.repositoryId);
      return selected ? [{ existing, selected }] : [];
    });
    const [authorityOwner] = selectedExisting;
    if (
      authorityOwner &&
      selectedExisting.some(
        ({ existing }) =>
          existing.githubUserId !== authorityOwner.existing.githubUserId ||
          existing.githubUserLogin !== authorityOwner.existing.githubUserLogin
      )
    ) {
      throw new GitHubProviderError("github_provider_invalid_response", {
        retryable: false,
        status: 502,
      });
    }
    const observedByRepository = new Map(
      authorityOwner
        ? (
            await provider.getRepositoryUserPermissions({
              installationId,
              repositories: selectedExisting.map(({ selected }) => selected),
              user: {
                id: authorityOwner.existing.githubUserId,
                login: authorityOwner.existing.githubUserLogin,
              },
            })
          ).map(({ permission, repositoryId }) => [repositoryId, permission])
        : []
    );
    if (observedByRepository.size !== selectedExisting.length) {
      throw new GitHubProviderError("github_provider_invalid_response", {
        retryable: false,
        status: 502,
      });
    }
    for (const { existing, selected } of selectedExisting) {
      const observed = observedByRepository.get(existing.repositoryId);
      if (!observed) {
        throw new GitHubProviderError("github_provider_invalid_response", {
          retryable: false,
          status: 502,
        });
      }
      const current = clampUserPermission(
        existing.userPermissionCeiling,
        observed
      );
      if (!current) {
        continue;
      }
      repositories.push({
        appContentsPermission,
        appIssuesPermission,
        appOrganizationProjectsPermission,
        appPullRequestsPermission,
        githubUserId: existing.githubUserId,
        githubUserLogin: existing.githubUserLogin,
        id: existing.id,
        repositoryId: selected.id,
        repositoryName: selected.name,
        repositoryNodeId: selected.nodeId,
        repositoryOwner: selected.owner,
        userPermissionCeiling: existing.userPermissionCeiling,
        userPermissionCurrent: current,
        userProjectManagementCeiling: existing.userProjectManagementCeiling,
        userProjectManagementCurrent: false,
      });
    }
  }
  if (repositories.length < 1) {
    throw new GitHubProviderError("github_installation_unusable", {
      retryable: false,
      status: 409,
    });
  }
  return { installation, repositories };
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
    repositories: authority.repositories
      .map((repository) => ({
        ...repository,
        id: deterministicConnectionId(
          principal.tenant,
          repository.repositoryId
        ),
      }))
      .sort((left, right) =>
        compareAscii(left.repositoryId, right.repositoryId)
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

function callbackParameters(request: Request):
  | Readonly<{
      installationId: string;
      kind: "installation";
      setupAction: "install" | "update";
      state: string;
    }>
  | Readonly<{ code: string; kind: "oauth"; state: string }>
  | null {
  const parameters = new URL(request.url).searchParams;
  const entries = [...parameters.entries()];
  const names = new Set(entries.map(([name]) => name));
  if (names.size !== entries.length) {
    return null;
  }
  if (
    entries.length === CALLBACK_PARAMETERS.size &&
    entries.every(([name]) => CALLBACK_PARAMETERS.has(name))
  ) {
    const installationId = parameters.get("installation_id");
    const setupAction = parameters.get("setup_action");
    const state = parameters.get("state");
    if (
      !installationId ||
      !DECIMAL_ID.test(installationId) ||
      (setupAction !== "install" && setupAction !== "update") ||
      !validCallbackState(state)
    ) {
      return null;
    }
    return { installationId, kind: "installation", setupAction, state };
  }
  if (
    entries.length === OAUTH_CALLBACK_PARAMETERS.size &&
    entries.every(([name]) => OAUTH_CALLBACK_PARAMETERS.has(name))
  ) {
    const code = parameters.get("code");
    const state = parameters.get("state");
    if (!code || !OAUTH_CODE.test(code) || !validCallbackState(state)) {
      return null;
    }
    return { code, kind: "oauth", state };
  }
  return null;
}

function validCallbackState(value: string | null): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_STATE_BYTES
  );
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
  return safe === supplied && canonicalSameOriginPath(supplied)
    ? safe
    : errorResponse(dependencies, "github_invalid_return_path");
}

function currentReturnPath(
  value: string,
  dependencies: GitHubConnectionDependencies
): string | null {
  try {
    const safe = safeApplicationCallbackPath(value, dependencies.appBasePath());
    return safe === value && canonicalSameOriginPath(value) ? safe : null;
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
          compareAscii(
            `${left.repositoryOwner}/${left.repositoryName}`,
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

function configuredGitHubCallbackUrl(
  dependencies: GitHubConnectionDependencies
): Readonly<{ origin: string; url: string }> | null {
  const origin = configuredOrigin(dependencies);
  if (!origin) {
    return null;
  }
  try {
    const home = applicationHomePath(dependencies.appBasePath());
    const basePath = home === "/" ? "" : home;
    return {
      origin,
      url: `${origin}${basePath}/api/github/callback`,
    };
  } catch {
    return null;
  }
}

function githubUserAuthorizationUrl(
  input: Readonly<{
    callbackUrl: Readonly<{ url: string }>;
    clientId: string;
    codeChallenge: string;
    state: string;
  }>
): string {
  const location = new URL("https://github.com/login/oauth/authorize");
  location.searchParams.set("client_id", input.clientId);
  location.searchParams.set("redirect_uri", input.callbackUrl.url);
  location.searchParams.set("state", input.state);
  location.searchParams.set("code_challenge", input.codeChallenge);
  location.searchParams.set("code_challenge_method", "S256");
  location.searchParams.set("allow_signup", "false");
  location.searchParams.set("prompt", "select_account");
  return location.toString();
}

function githubCodeVerifier(
  claims: GitHubUserAuthorizationStateClaims,
  stateSigningKey: KeyObject
): string {
  return createHmac("sha256", stateSigningKey)
    .update("github-user-authorization-pkce\0", "utf8")
    .update(claims.jti, "utf8")
    .update("\0", "utf8")
    .update(claims.installationId, "utf8")
    .digest("base64url");
}

function githubCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function callbackOperation(kind: string, tenant: string): string {
  return `${kind}:${sha256(tenant).slice(0, 16)}`;
}

function stateIdempotencyKey(
  claims: GitHubInstallStateClaims | GitHubUserAuthorizationStateClaims
): string {
  return sha256(`github-state\0${claims.v}\0${claims.jti}`);
}

function stateRetentionMs(exp: number, now: Date): number {
  return Math.max(IDEMPOTENCY_RETENTION_FLOOR_MS, exp * 1000 - now.getTime());
}

async function replaceConsumedOutcome(
  store: IdempotencyStore,
  completion: IdempotencyCompleteInput,
  outcome: Extract<CallbackOutcome, { kind: "error" | "redirect" }>,
  completedAt: Date,
  retentionMs: number
): Promise<void> {
  if (
    !store.replaceCompleted ||
    Number.isNaN(completedAt.getTime()) ||
    !Number.isFinite(retentionMs) ||
    retentionMs <= 0
  ) {
    throw new Error("GitHub callback completion storage is unavailable.");
  }
  const result = await store.replaceCompleted({
    ...completion,
    completedAt,
    expiresAt: new Date(completedAt.getTime() + retentionMs),
    response: {
      envelope: { body: outcome, kind: "plain_json" },
      status: 200,
    },
  });
  if (result !== "replaced") {
    throw new Error("GitHub callback completion was lost.");
  }
}

function callbackOutcome(value: unknown): CallbackOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  if (
    body.kind === "authorize" &&
    typeof body.authorizationState === "string" &&
    validCallbackState(body.authorizationState) &&
    Object.keys(body).length === 2
  ) {
    return {
      authorizationState: body.authorizationState,
      kind: "authorize",
    };
  }
  if (
    body.kind === "consumed" &&
    typeof body.installationId === "string" &&
    DECIMAL_ID.test(body.installationId) &&
    typeof body.returnPath === "string" &&
    canonicalSameOriginPath(body.returnPath) &&
    Object.keys(body).length === 3
  ) {
    return {
      installationId: body.installationId,
      kind: "consumed",
      returnPath: body.returnPath,
    };
  }
  if (
    body.kind === "redirect" &&
    typeof body.returnPath === "string" &&
    canonicalSameOriginPath(body.returnPath) &&
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

function callbackErrorCode(error: unknown): GitHubErrorCode {
  if (!(error instanceof GitHubProviderError)) {
    return "github_provider_unavailable";
  }
  if (error.code === "github_user_installation_inaccessible") {
    return "github_installation_access_denied";
  }
  if (error.code === "github_oauth_exchange_rejected") {
    return "github_callback_invalid";
  }
  if (error.code === "github_provider_rate_limited") {
    return "rate_limited";
  }
  return "github_provider_unavailable";
}

function errorResponse(
  dependencies: GitHubConnectionDependencies,
  code: GitHubErrorCode,
  options: Readonly<{ retryAfterSeconds?: number }> = {}
): Response {
  const definition = ERROR_DEFINITIONS[code];
  const headers = new Headers({
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  });
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
    "referrer-policy": "no-referrer",
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
  claims: GitHubInstallStateClaims | GitHubUserAuthorizationStateClaims,
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
    !isCanonicalUuid(input.userId) ||
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
    isCanonicalUuid(claims.userId) &&
    typeof claims.tenant === "string" &&
    TENANT.test(claims.tenant) &&
    typeof claims.returnPath === "string" &&
    canonicalSameOriginPath(claims.returnPath)
  );
}

function validUserAuthorizationClaims(
  value: unknown
): value is GitHubUserAuthorizationStateClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const claims = value as Record<string, unknown>;
  if (
    Object.keys(claims).sort().join(",") !==
    "authVersion,exp,iat,installationId,jti,returnPath,tenant,userId,v"
  ) {
    return false;
  }
  return (
    claims.v === 2 &&
    validStateIdentityClaims(claims) &&
    typeof claims.installationId === "string" &&
    DECIMAL_ID.test(claims.installationId)
  );
}

function validStateIdentityClaims(claims: Record<string, unknown>): boolean {
  return (
    Number.isSafeInteger(claims.authVersion) &&
    Number(claims.authVersion) >= 0 &&
    Number.isSafeInteger(claims.iat) &&
    Number.isSafeInteger(claims.exp) &&
    Number(claims.exp) > Number(claims.iat) &&
    Number(claims.exp) - Number(claims.iat) <= STATE_TTL_SECONDS &&
    typeof claims.jti === "string" &&
    JTI.test(claims.jti) &&
    typeof claims.userId === "string" &&
    isCanonicalUuid(claims.userId) &&
    typeof claims.tenant === "string" &&
    TENANT.test(claims.tenant) &&
    typeof claims.returnPath === "string" &&
    canonicalSameOriginPath(claims.returnPath)
  );
}

function canonicalSameOriginPath(value: string): boolean {
  if (
    value.length === 0 ||
    encodedReturnPathBytes(value) > GITHUB_RETURN_PATH_MAX_ENCODED_BYTES ||
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

function encodedReturnPathBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
