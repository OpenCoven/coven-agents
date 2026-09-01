import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { AbuseAdmission } from "@/lib/abuse/enforce";
import type {
  IdempotencyClaimInput,
  IdempotencyClaimResult,
  IdempotencyCompleteInput,
  IdempotencyReleaseInput,
  IdempotencyStore,
} from "@/lib/abuse/idempotency";
import type { RunnerAuthenticatedSubscriber } from "@/lib/runner/auth";
import type {
  GitHubConnectionRecord,
  ReplaceGitHubInstallationConnectionsInput,
} from "@/lib/teams/store";
import {
  type GitHubInstallation,
  GitHubProviderError,
  type GitHubRepositorySelection,
} from "./app-auth";
import { githubAppConfig } from "./config";
import {
  createGitHubConnectionHandlers,
  createGitHubInstallState,
  GITHUB_RETURN_PATH_MAX_ENCODED_BYTES,
  type GitHubConnectionStore,
  verifyGitHubInstallState,
} from "./connection";

const NOW = new Date("2026-08-31T18:00:00.000Z");
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TENANT = "u_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const OTHER_TENANT = "u_bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb";
const INSTALLATION_ID = "987654321";
const OTHER_INSTALLATION_ID = "987654322";
const OAUTH_CODE = "oauth-code-0123456789abcdef";
const SECOND_OAUTH_CODE = "oauth-code-fedcba9876543210";
const RETURN_PATH_ENCODED_BYTE_BOUND = GITHUB_RETURN_PATH_MAX_ENCODED_BYTES;
const TEST_APP_CLIENT_VALUE = `github-app-client-${"0123456789abcdef".repeat(
  3
)}`;
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const CONFIG = githubAppConfig({
  GITHUB_APP_CLIENT_ID: "Iv1.0123456789abcdef",
  GITHUB_APP_CLIENT_SECRET: TEST_APP_CLIENT_VALUE,
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: keys.privateKey,
  GITHUB_APP_SLUG: "opencoven-delivery",
  GITHUB_STATE_SIGNING_SECRET:
    "0123456789abcdefghijklmnopqrstuvwxyz-STATE-SIGNING",
  GITHUB_TEAMS_ENABLED: "on",
});

const subscriber: RunnerAuthenticatedSubscriber = {
  authVersion: 4,
  kind: "allowed",
  principal: { kind: "subscriber", tenant: TENANT, userId: USER_ID },
  session: { kind: "subscriber", tenant: TENANT, userId: USER_ID },
  userId: USER_ID,
};

test("install state rejects tampering, expiry, and malformed claims", () => {
  const state = stateFor();
  const verified = verifyGitHubInstallState({
    now: NOW,
    state,
    stateSigningKey: CONFIG.stateSigningKey,
  });
  assert.equal(verified.kind, "valid");
  if (verified.kind === "valid") {
    assert.deepEqual(verified.claims, {
      authVersion: 4,
      exp: Math.floor(NOW.getTime() / 1000) + 600,
      iat: Math.floor(NOW.getTime() / 1000),
      jti: "ERERERERERERERERERERERERERERERERERERERERERE",
      returnPath: "/account?tab=github",
      tenant: TENANT,
      userId: USER_ID,
      v: 1,
    });
  }

  const last = state.at(-1);
  assert.ok(last);
  const tampered = `${state.slice(0, -1)}${last === "a" ? "b" : "a"}`;
  assert.deepEqual(
    verifyGitHubInstallState({
      now: NOW,
      state: tampered,
      stateSigningKey: CONFIG.stateSigningKey,
    }),
    { kind: "invalid" }
  );
  assert.deepEqual(
    verifyGitHubInstallState({
      now: new Date(NOW.getTime() + 601_000),
      state,
      stateSigningKey: CONFIG.stateSigningKey,
    }),
    { kind: "expired" }
  );
  assert.deepEqual(
    verifyGitHubInstallState({
      now: NOW,
      state: "v1.not-json.invalid",
      stateSigningKey: CONFIG.stateSigningKey,
    }),
    { kind: "invalid" }
  );
});

test("install state rejects every non-canonical signature encoding before durable consumption", async () => {
  const state = stateFor();
  const idempotency = new MemoryIdempotencyStore();
  const handlers = createGitHubConnectionHandlers(
    dependencies({ idempotencyStore: idempotency })
  );

  const canonical = await handlers.callback(callbackRequest(state), null);
  assert.equal(canonical.status, 302);
  assert.equal(idempotency.claims.length, 1);

  const variants = nonCanonicalSignatureVariants(state);
  assert.equal(variants.length, 3);
  for (const variant of variants) {
    assert.deepEqual(
      verifyGitHubInstallState({
        now: NOW,
        state: variant,
        stateSigningKey: CONFIG.stateSigningKey,
      }),
      { kind: "invalid" }
    );
    // biome-ignore lint/performance/noAwaitInLoops: every alternate final character is a distinct regression case
    const response = await handlers.callback(callbackRequest(variant), null);
    assert.equal(response.status, 400);
    assert.equal(await errorCode(response), "github_state_invalid");
  }
  assert.equal(idempotency.claims.length, 1);
});

test("install authenticates, admits, and redirects only to the canonical GitHub App URL", async () => {
  const calls: string[] = [];
  const handlers = createGitHubConnectionHandlers(
    dependencies({
      authorizeSubscriber: () => {
        calls.push("auth");
        return Promise.resolve(subscriber);
      },
      enforceAbuse: (input) => {
        calls.push("abuse");
        assert.deepEqual(input, {
          failClosed: true,
          ip: "203.0.113.10",
          route: "github_install",
          userId: USER_ID,
        });
        return Promise.resolve({ kind: "allowed" });
      },
      getConfig: () => {
        calls.push("config");
        return CONFIG;
      },
    })
  );
  const returnPath = "/account?tab=github";
  const request = new Request(
    `https://app.example/api/github/install?returnTo=${encodeURIComponent(
      returnPath
    )}`
  );

  const response = await handlers.install(request, "203.0.113.10");

  assert.equal(response.status, 302);
  assertNoStore(response);
  assert.deepEqual(calls, ["auth", "abuse", "config"]);
  const location = response.headers.get("location");
  assert.ok(location);
  const redirect = new URL(location);
  assert.equal(
    redirect.origin + redirect.pathname,
    "https://github.com/apps/opencoven-delivery/installations/new"
  );
  assert.deepEqual([...redirect.searchParams.keys()], ["state"]);
  const state = redirect.searchParams.get("state");
  assert.ok(state);
  const verified = verifyGitHubInstallState({
    now: NOW,
    state,
    stateSigningKey: CONFIG.stateSigningKey,
  });
  assert.equal(verified.kind, "valid");
  if (verified.kind === "valid") {
    assert.equal(verified.claims.userId, USER_ID);
    assert.equal(verified.claims.tenant, TENANT);
    assert.equal(verified.claims.authVersion, 4);
    assert.equal(verified.claims.returnPath, returnPath);
  }
});

test("install rejects open redirects and duplicate query parameters", async () => {
  const handlers = createGitHubConnectionHandlers(dependencies());
  for (const url of [
    "https://app.example/api/github/install?returnTo=https%3A%2F%2Fevil.example",
    "https://app.example/api/github/install?returnTo=%2F%2Fevil.example",
    "https://app.example/api/github/install?returnTo=%2Faccount&returnTo=%2F",
    "https://app.example/api/github/install?unknown=1",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each URL asserts its own complete response
    const response = await handlers.install(new Request(url), null);
    assert.equal(response.status, 400, url);
    assert.equal(await errorCode(response), "github_invalid_return_path");
    assertNoStore(response);
  }
});

test("install enforces the encoded UTF-8 return-path bound before state creation", async () => {
  const handlers = createGitHubConnectionHandlers(dependencies());
  const exact = encodedReturnPath(RETURN_PATH_ENCODED_BYTE_BOUND);
  const exactResponse = await handlers.install(installRequest(exact), null);
  assert.equal(exactResponse.status, 302);
  const installState = new URL(
    exactResponse.headers.get("location") ?? ""
  ).searchParams.get("state");
  assert.ok(installState);
  assert.equal(
    verifyGitHubInstallState({
      now: NOW,
      state: installState,
      stateSigningKey: CONFIG.stateSigningKey,
    }).kind,
    "valid"
  );
  const authorization = await beginUserAuthorization(handlers, installState);
  const completed = await handlers.callback(
    oauthCallbackRequest(authorization.state),
    null
  );
  assert.equal(completed.status, 303);
  assert.equal(
    completed.headers.get("location"),
    `https://app.example${exact}`
  );

  for (const value of [
    `${exact}a`,
    encodedReturnPath(RETURN_PATH_ENCODED_BYTE_BOUND, "\\"),
    `${encodedReturnPath(RETURN_PATH_ENCODED_BYTE_BOUND, "\\")}\\`,
    "/account?note=é",
    encodedReturnPath(RETURN_PATH_ENCODED_BYTE_BOUND, "%F0%9F%98%80"),
    `${encodedReturnPath(RETURN_PATH_ENCODED_BYTE_BOUND, "%F0%9F%98%80")}%41`,
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each boundary value must produce its own response
    const response = await handlers.install(installRequest(value), null);
    const encodedBytes = returnPathEncodedBytes(value);
    if (encodedBytes === RETURN_PATH_ENCODED_BYTE_BOUND) {
      assert.equal(response.status, 302, value.slice(0, 40));
      continue;
    }
    assert.equal(response.status, 400, value.slice(0, 40));
    assert.equal(await errorCode(response), "github_invalid_return_path");
  }
});

test("install applies the same return-path bound with the configured base path", async () => {
  const handlers = createGitHubConnectionHandlers(
    dependencies({ appBasePath: () => "/demo" })
  );
  const exact = encodedReturnPath(
    RETURN_PATH_ENCODED_BYTE_BOUND,
    "a",
    "/demo/account?next="
  );
  assert.equal(
    (await handlers.install(installRequest(exact, "/demo"), null)).status,
    302
  );

  const over = `${exact}a`;
  const rejected = await handlers.install(installRequest(over, "/demo"), null);
  assert.equal(rejected.status, 400);
  assert.equal(await errorCode(rejected), "github_invalid_return_path");
});

test("install and callback preserve a canonical configured base path", async () => {
  const basePath = "/demo";
  const handlers = createGitHubConnectionHandlers(
    dependencies({
      appBasePath: () => basePath,
    })
  );
  const install = await handlers.install(
    new Request(
      `https://app.example/demo/api/github/install?returnTo=${encodeURIComponent(
        "/demo/account?tab=github"
      )}`
    ),
    null
  );
  const state = new URL(install.headers.get("location") ?? "").searchParams.get(
    "state"
  );
  assert.ok(state);

  const setup = await handlers.callback(callbackRequest(state, "/demo"), null);
  assert.equal(setup.status, 302);
  const authorization = new URL(setup.headers.get("location") ?? "");
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    "https://app.example/demo/api/github/callback"
  );
  const authorizationState = authorization.searchParams.get("state");
  assert.ok(authorizationState);

  const callback = await handlers.callback(
    oauthCallbackRequest(authorizationState, OAUTH_CODE, "/demo"),
    null
  );
  assert.equal(callback.status, 303);
  assert.equal(
    callback.headers.get("location"),
    "https://app.example/demo/account?tab=github"
  );
  assertNoStore(callback);

  const rejected = await handlers.install(
    new Request(
      `https://app.example/demo/api/github/install?returnTo=${encodeURIComponent(
        "/account"
      )}`
    ),
    null
  );
  assert.equal(rejected.status, 400);
  assert.equal(await errorCode(rejected), "github_invalid_return_path");
});

test("install fails closed for signed-out, stale, denied, unavailable, disabled, and invalid configuration", async () => {
  const cases: Array<{
    admission?: AbuseAdmission;
    auth?: "subscription_required" | "unauthorized";
    code: string;
    config?: "disabled" | "invalid";
    status: number;
  }> = [
    { auth: "unauthorized", code: "unauthorized", status: 401 },
    {
      auth: "subscription_required",
      code: "subscription_required",
      status: 403,
    },
    {
      admission: {
        kind: "denied",
        responseStatus: 429,
        retryAfterSeconds: 7,
      },
      code: "rate_limited",
      status: 429,
    },
    {
      admission: { kind: "unavailable", responseStatus: 503 },
      code: "abuse_control_unavailable",
      status: 503,
    },
    {
      code: "github_feature_disabled",
      config: "disabled",
      status: 404,
    },
    {
      code: "github_configuration_invalid",
      config: "invalid",
      status: 503,
    },
  ];

  for (const current of cases) {
    let configCalls = 0;
    // biome-ignore lint/performance/noAwaitInLoops: each case tracks isolated dependency call counts
    const response = await createGitHubConnectionHandlers(
      dependencies({
        authorizeSubscriber: () =>
          Promise.resolve(current.auth ? { kind: current.auth } : subscriber),
        enforceAbuse: () =>
          Promise.resolve(current.admission ?? { kind: "allowed" }),
        getConfig: () => {
          configCalls += 1;
          if (current.config === "invalid") {
            throw new Error("private key detail");
          }
          return current.config === "disabled"
            ? { enabled: false as const }
            : CONFIG;
        },
      })
    ).install(
      new Request("https://app.example/api/github/install"),
      "203.0.113.20"
    );

    assert.equal(response.status, current.status);
    assert.equal(await errorCode(response.clone()), current.code);
    assertNoStore(response);
    if (current.auth || current.admission) {
      assert.equal(configCalls, 0);
    }
    assert.doesNotMatch(await response.clone().text(), /private key detail/u);
  }
});

test("callback verifies provider authority, persists only provider metadata, and replays durable completion", async () => {
  const state = stateFor();
  const store = new MemoryConnectionStore();
  const idempotency = new MemoryIdempotencyStore();
  let installationCalls = 0;
  let repositoryCalls = 0;
  let authCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependencies({
      authorizeSubscriber: () => {
        authCalls += 1;
        return Promise.resolve(subscriber);
      },
      createProvider: () => ({
        getInstallation: () => {
          installationCalls += 1;
          return Promise.resolve(installation());
        },
        listInstallationRepositories: () => {
          repositoryCalls += 1;
          return Promise.resolve(repositories());
        },
      }),
      createStore: () => store,
      idempotencyStore: idempotency,
    })
  );
  const authorization = await beginUserAuthorization(handlers, state);
  const request = oauthCallbackRequest(authorization.state);

  const first = await handlers.callback(request, "203.0.113.30");
  const replay = await handlers.callback(request, "203.0.113.30");

  for (const response of [first, replay]) {
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "https://app.example/account?tab=github"
    );
    assertNoStore(response);
    // biome-ignore lint/performance/noAwaitInLoops: only two already-completed responses are inspected
    assert.doesNotMatch(await response.clone().text(), /token|private.?key/iu);
  }
  assert.equal(replay.headers.get("github-callback-replayed"), "true");
  assert.equal(installationCalls, 1);
  assert.equal(repositoryCalls, 1);
  assert.equal(
    authCalls,
    4,
    "setup + OAuth callback + persistence revalidation + replay auth"
  );
  assert.equal(store.replacements.length, 1);
  assert.equal(store.replacements[0]?.principal.tenant, TENANT);
  assert.deepEqual(store.replacements[0]?.input, {
    accountId: "13579",
    accountLogin: "OpenCoven",
    accountType: "Organization",
    expectedGeneration: 0,
    installationId: INSTALLATION_ID,
    repositories: [
      {
        id: store.replacements[0]?.input.repositories[0]?.id,
        repositoryId: "24680",
        repositoryName: "coven-agents",
        repositoryNodeId: "R_one",
        repositoryOwner: "OpenCoven",
      },
      {
        id: store.replacements[0]?.input.repositories[1]?.id,
        repositoryId: "24681",
        repositoryName: "coven-web",
        repositoryNodeId: "R_two",
        repositoryOwner: "OpenCoven",
      },
    ],
  });
  for (const repository of store.replacements[0]?.input.repositories ?? []) {
    assert.match(repository.id, /^[0-9a-f-]{36}$/u);
  }
  assert.equal(idempotency.claims.length, 3);
  assert.doesNotMatch(
    JSON.stringify(idempotency.claims),
    new RegExp(escapeRegExp(state), "u")
  );
});

test("setup callback requires user authorization before provider access or persistence", async () => {
  const store = new MemoryConnectionStore();
  let providerCalls = 0;
  let proofCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createProvider: () => {
          providerCalls += 1;
          return provider();
        },
        createStore: () => store,
      },
      {
        proveInstallationAccess: () => {
          proofCalls += 1;
          return Promise.resolve();
        },
      }
    )
  );

  const request = callbackRequest(stateFor());
  const response = await handlers.callback(request, null);
  const replay = await handlers.callback(request, null);

  assert.equal(response.status, 302);
  assert.equal(replay.status, 302);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(
    replay.headers.get("location"),
    response.headers.get("location")
  );
  assert.equal(replay.headers.get("github-callback-replayed"), "true");
  const location = response.headers.get("location");
  assert.ok(location);
  const authorization = new URL(location);
  assert.equal(
    authorization.origin + authorization.pathname,
    "https://github.com/login/oauth/authorize"
  );
  assert.deepEqual([...authorization.searchParams.keys()].sort(), [
    "allow_signup",
    "client_id",
    "code_challenge",
    "code_challenge_method",
    "prompt",
    "redirect_uri",
    "state",
  ]);
  assert.equal(authorization.searchParams.get("client_id"), CONFIG.clientId);
  assert.equal(
    authorization.searchParams.get("redirect_uri"),
    "https://app.example/api/github/callback"
  );
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    authorization.searchParams.get("code_challenge") ?? "",
    /^[A-Za-z0-9_-]{43}$/u
  );
  assert.ok(authorization.searchParams.get("state"));
  assert.doesNotMatch(location, /access_token|client_secret|ghu_|token=/iu);
  assert.equal(providerCalls, 0);
  assert.equal(proofCalls, 0);
  assert.equal(store.replacements.length, 0);
});

test("OAuth callback persists only after exact user installation access is proved", async () => {
  const store = new MemoryConnectionStore();
  const proofs: unknown[] = [];
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      { createStore: () => store },
      {
        proveInstallationAccess: (input) => {
          proofs.push(input);
          return Promise.resolve();
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);
  const response = await handlers.callback(
    oauthCallbackRequest(authorization.state),
    null
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    "https://app.example/account?tab=github"
  );
  assert.equal(proofs.length, 1);
  assert.deepEqual(proofs[0], {
    code: OAUTH_CODE,
    codeVerifier: (proofs[0] as { codeVerifier: string }).codeVerifier,
    installationId: INSTALLATION_ID,
    redirectUri: "https://app.example/api/github/callback",
  });
  assert.match(
    (proofs[0] as { codeVerifier: string }).codeVerifier,
    /^[A-Za-z0-9_-]{43}$/u
  );
  assert.equal(
    createHash("sha256")
      .update((proofs[0] as { codeVerifier: string }).codeVerifier, "ascii")
      .digest("base64url"),
    authorization.codeChallenge
  );
  assert.equal(store.replacements.length, 1);
  assert.equal(store.replacements[0]?.input.installationId, INSTALLATION_ID);
});

test("foreign valid installation proof is rejected without metadata persistence", async () => {
  const store = new MemoryConnectionStore();
  let providerCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createProvider: () => {
          providerCalls += 1;
          return provider();
        },
        createStore: () => store,
      },
      {
        proveInstallationAccess: () =>
          Promise.reject(
            new GitHubProviderError("github_user_installation_inaccessible", {
              retryable: false,
              status: 403,
            })
          ),
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);

  const response = await handlers.callback(
    oauthCallbackRequest(authorization.state),
    null
  );

  assert.equal(response.status, 403);
  assert.equal(await errorCode(response), "github_installation_access_denied");
  assert.equal(providerCalls, 0);
  assert.equal(store.replacements.length, 0);
});

test("OAuth state is phase-bound and rejects installation substitution", async () => {
  let proofCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {},
      {
        proveInstallationAccess: () => {
          proofCalls += 1;
          return Promise.resolve();
        },
      }
    )
  );
  const installState = stateFor();
  const authorization = await beginUserAuthorization(handlers, installState);

  const installAsOAuth = await handlers.callback(
    oauthCallbackRequest(installState),
    null
  );
  assert.equal(installAsOAuth.status, 400);
  assert.equal(await errorCode(installAsOAuth), "github_state_invalid");

  const oauthAsInstall = await handlers.callback(
    callbackRequest(authorization.state),
    null
  );
  assert.equal(oauthAsInstall.status, 400);
  assert.equal(await errorCode(oauthAsInstall), "github_state_invalid");

  const substituted = await handlers.callback(
    new Request(
      `${oauthCallbackRequest(authorization.state).url}&installation_id=${OTHER_INSTALLATION_ID}`
    ),
    null
  );
  assert.equal(substituted.status, 400);
  assert.equal(await errorCode(substituted), "github_callback_invalid");
  assert.equal(proofCalls, 0);
});

test("OAuth state rejects every non-canonical signature encoding without another proof or mutation", async () => {
  const idempotency = new MemoryIdempotencyStore();
  const store = new MemoryConnectionStore();
  let proofCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createStore: () => store,
        idempotencyStore: idempotency,
      },
      {
        proveInstallationAccess: () => {
          proofCalls += 1;
          return Promise.resolve();
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);
  const canonical = await handlers.callback(
    oauthCallbackRequest(authorization.state),
    null
  );
  assert.equal(canonical.status, 303);
  assert.equal(proofCalls, 1);
  assert.equal(store.replacements.length, 1);
  const durableClaims = idempotency.claims.length;

  const variants = nonCanonicalSignatureVariants(authorization.state);
  assert.equal(variants.length, 3);
  for (const variant of variants) {
    // biome-ignore lint/performance/noAwaitInLoops: every alternate final character is a distinct regression case
    const response = await handlers.callback(
      oauthCallbackRequest(variant),
      null
    );
    assert.equal(response.status, 400);
    assert.equal(await errorCode(response), "github_state_invalid");
  }
  assert.equal(proofCalls, 1);
  assert.equal(store.replacements.length, 1);
  assert.equal(idempotency.claims.length, durableClaims);
});

test("OAuth callback binds user, tenant, and auth version across both phases", async () => {
  for (const mismatched of [
    subscriberFor(OTHER_USER_ID, TENANT, 4),
    subscriberFor(USER_ID, OTHER_TENANT, 4),
    subscriberFor(USER_ID, TENANT, 5),
  ]) {
    let current = subscriber;
    let proofCalls = 0;
    const handlers = createGitHubConnectionHandlers(
      dependenciesWithUserAuthorization(
        {
          authorizeSubscriber: () => Promise.resolve(current),
        },
        {
          proveInstallationAccess: () => {
            proofCalls += 1;
            return Promise.resolve();
          },
        }
      )
    );
    // biome-ignore lint/performance/noAwaitInLoops: each mismatch owns isolated durable state
    const authorization = await beginUserAuthorization(handlers);
    current = mismatched;
    const response = await handlers.callback(
      oauthCallbackRequest(authorization.state),
      null
    );
    assert.equal(response.status, 403);
    assert.equal(await errorCode(response), "github_state_mismatch");
    assert.equal(proofCalls, 0);
  }
});

test("OAuth state expires independently before code exchange", async () => {
  let currentTime = NOW;
  let proofCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      { now: () => currentTime },
      {
        proveInstallationAccess: () => {
          proofCalls += 1;
          return Promise.resolve();
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);
  currentTime = new Date(NOW.getTime() + 601_000);

  const response = await handlers.callback(
    oauthCallbackRequest(authorization.state),
    null
  );

  assert.equal(response.status, 400);
  assert.equal(await errorCode(response), "github_state_expired");
  assert.equal(proofCalls, 0);
});

test("subscriber authority is revalidated after user proof and before persistence", async () => {
  const store = new MemoryConnectionStore();
  let current = subscriber;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        authorizeSubscriber: () => Promise.resolve(current),
        createStore: () => store,
      },
      {
        proveInstallationAccess: () => {
          current = subscriberFor(USER_ID, TENANT, 5);
          return Promise.resolve();
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);

  const response = await handlers.callback(
    oauthCallbackRequest(authorization.state),
    null
  );

  assert.equal(response.status, 403);
  assert.equal(await errorCode(response), "github_state_mismatch");
  assert.equal(store.replacements.length, 0);
});

test("installation substitution on a replayed setup state is rejected", async () => {
  const handlers = createGitHubConnectionHandlers(dependencies());
  const state = stateFor();
  const first = await handlers.callback(callbackRequest(state), null);
  assert.equal(first.status, 302);

  const substituted = await handlers.callback(
    callbackRequest(state, "", OTHER_INSTALLATION_ID),
    null
  );
  assert.equal(substituted.status, 400);
  assert.equal(await errorCode(substituted), "github_state_invalid");
});

test("OAuth code and state replay cannot repeat exchange or provider mutation", async () => {
  const store = new MemoryConnectionStore();
  const idempotency = new MemoryIdempotencyStore();
  let proofCalls = 0;
  let installationCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createProvider: () =>
          provider({
            getInstallation: () => {
              installationCalls += 1;
              return Promise.resolve(installation());
            },
          }),
        createStore: () => store,
        idempotencyStore: idempotency,
      },
      {
        proveInstallationAccess: () => {
          proofCalls += 1;
          return Promise.resolve();
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);
  const request = oauthCallbackRequest(authorization.state);

  const first = await handlers.callback(request, null);
  const replay = await handlers.callback(request, null);
  assert.equal(first.status, 303);
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get("github-callback-replayed"), "true");
  assert.equal(proofCalls, 1);
  assert.equal(installationCalls, 1);
  assert.equal(store.replacements.length, 1);
  assert.doesNotMatch(
    JSON.stringify(idempotency.claims),
    new RegExp(
      `${escapeRegExp(OAUTH_CODE)}|${escapeRegExp(authorization.state)}`,
      "u"
    )
  );

  const substitutedCode = await handlers.callback(
    oauthCallbackRequest(authorization.state, `${OAUTH_CODE}-different`),
    null
  );
  assert.equal(substitutedCode.status, 400);
  assert.equal(await errorCode(substitutedCode), "github_state_invalid");
  assert.equal(proofCalls, 1);
});

test("callback rejects tamper, expiry, user, tenant, and auth-version mismatches before provider access", async () => {
  const cases = [
    {
      state: `${stateFor().slice(0, -1)}x`,
      status: 400,
      subscriber,
    },
    {
      now: new Date(NOW.getTime() + 601_000),
      state: stateFor(),
      status: 400,
      subscriber,
    },
    {
      state: stateFor(),
      status: 403,
      subscriber: subscriberFor(OTHER_USER_ID, TENANT, 4),
    },
    {
      state: stateFor(),
      status: 403,
      subscriber: subscriberFor(USER_ID, OTHER_TENANT, 4),
    },
    {
      state: stateFor(),
      status: 403,
      subscriber: subscriberFor(USER_ID, TENANT, 5),
    },
  ];

  for (const current of cases) {
    let providerCalls = 0;
    const handlers = createGitHubConnectionHandlers(
      dependencies({
        authorizeSubscriber: () => Promise.resolve(current.subscriber),
        createProvider: () => ({
          getInstallation: () => {
            providerCalls += 1;
            return Promise.resolve(installation());
          },
          listInstallationRepositories: () => Promise.resolve(repositories()),
        }),
        now: () => current.now ?? NOW,
      })
    );
    // biome-ignore lint/performance/noAwaitInLoops: each mismatch uses an isolated handler and provider counter
    const response = await handlers.callback(
      callbackRequest(current.state),
      null
    );
    assert.equal(response.status, current.status);
    assert.equal(providerCalls, 0);
    assertNoStore(response);
  }
});

test("callback rejects forged callback fields, invalid installation ids, and setup actions", async () => {
  const state = stateFor();
  for (const suffix of [
    "&account_id=999",
    "&repository_id=999",
    "&installation_id=01",
    "&setup_action=delete",
    "&state=duplicate",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each forged query uses an isolated handler
    const response = await createGitHubConnectionHandlers(
      dependencies()
    ).callback(new Request(`${callbackRequest(state).url}${suffix}`), null);
    assert.equal(response.status, 400, suffix);
    assert.equal(await errorCode(response), "github_callback_invalid");
    assertNoStore(response);
  }
});

test("OAuth denial details and provider tokens are never reflected by the callback", async () => {
  let proofCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {},
      {
        proveInstallationAccess: () => {
          proofCalls += 1;
          return Promise.resolve();
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);
  const token = `ghu_${"A".repeat(32)}`;
  const query = new URLSearchParams({
    error: "access_denied",
    error_description: token,
    state: authorization.state,
  });

  const response = await handlers.callback(
    new Request(`https://app.example/api/github/callback?${query}`),
    null
  );

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(await errorCode(response.clone()), "github_callback_invalid");
  assert.doesNotMatch(await response.text(), new RegExp(token, "u"));
  assert.equal(proofCalls, 0);
});

test("missing, suspended, under-permissioned, all-repository, and excessive installations clear local authority", async () => {
  const cases: Array<{
    provider: () => ReturnType<typeof provider>;
  }> = [
    {
      provider: () =>
        provider({
          getInstallation: () =>
            Promise.reject(
              new GitHubProviderError("github_installation_missing", {
                retryable: false,
                status: 404,
              })
            ),
        }),
    },
    {
      provider: () =>
        provider({
          getInstallation: () =>
            Promise.resolve(
              installation({ suspendedAt: "2026-08-31T17:00:00.000Z" })
            ),
        }),
    },
    {
      provider: () =>
        provider({
          getInstallation: () =>
            Promise.resolve(installation({ permissions: {} })),
        }),
    },
    {
      provider: () =>
        provider({
          getInstallation: () =>
            Promise.resolve(
              installation({
                permissions: {
                  issues: "read",
                  metadata: "read",
                  organization_projects: "write",
                  pull_requests: "write",
                },
              })
            ),
        }),
    },
    {
      provider: () =>
        provider({
          getInstallation: () =>
            Promise.resolve(installation({ repositorySelection: "all" })),
        }),
    },
    {
      provider: () =>
        provider({
          listInstallationRepositories: () =>
            Promise.resolve({
              repositories: Array.from({ length: 17 }, (_, index) => ({
                id: String(30_000 + index),
                name: `repo-${index}`,
                nodeId: `R_${index}`,
                owner: "OpenCoven",
              })),
              repositorySelection: "selected",
            }),
        }),
    },
  ];

  for (const current of cases) {
    const store = new MemoryConnectionStore();
    const handlers = createGitHubConnectionHandlers(
      dependencies({
        createProvider: current.provider,
        createStore: () => store,
      })
    );
    // biome-ignore lint/performance/noAwaitInLoops: each authority case owns isolated durable state
    const authorization = await beginUserAuthorization(handlers);
    const response = await handlers.callback(
      oauthCallbackRequest(authorization.state),
      null
    );

    assert.equal(response.status, 409);
    assert.equal(await errorCode(response), "github_installation_unusable");
    assert.deepEqual(store.removals, [
      { installationId: INSTALLATION_ID, tenant: TENANT },
    ]);
    assert.equal(store.replacements.length, 0);
    assertNoStore(response);
  }
});

test("transient provider failures are sanitized and cannot repeat a consumed OAuth exchange", async () => {
  const idempotency = new MemoryIdempotencyStore();
  const store = new MemoryConnectionStore();
  let attempts = 0;
  const handlers = createGitHubConnectionHandlers(
    dependencies({
      createProvider: () =>
        provider({
          getInstallation: () => {
            attempts += 1;
            return attempts === 1
              ? Promise.reject(
                  new GitHubProviderError("github_provider_unavailable", {
                    retryable: true,
                    status: 503,
                  })
                )
              : Promise.resolve(installation());
          },
        }),
      createStore: () => store,
      idempotencyStore: idempotency,
    })
  );
  const authorization = await beginUserAuthorization(handlers);
  const request = oauthCallbackRequest(authorization.state);

  const failed = await handlers.callback(request, null);
  assert.equal(failed.status, 503);
  assert.equal(await errorCode(failed.clone()), "github_provider_unavailable");
  assert.doesNotMatch(await failed.clone().text(), /installation-local-token/u);

  const retried = await handlers.callback(request, null);
  assert.equal(retried.status, 503);
  assert.equal(await errorCode(retried), "github_provider_unavailable");
  assert.equal(attempts, 1);
  assert.equal(store.replacements.length, 0);
});

test("a near-expiry OAuth callback keeps its consumed record through slow bounded processing and cleanup", async () => {
  let currentTime = NOW;
  const idempotency = new MemoryIdempotencyStore();
  const store = new MemoryConnectionStore();
  let proofCalls = 0;
  let releaseProof!: () => void;
  let signalProofStarted!: () => void;
  const proofStarted = new Promise<void>((resolve) => {
    signalProofStarted = resolve;
  });
  const proofGate = new Promise<void>((resolve) => {
    releaseProof = resolve;
  });
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createStore: () => store,
        idempotencyStore: idempotency,
        now: () => currentTime,
      },
      {
        proveInstallationAccess: async () => {
          proofCalls += 1;
          signalProofStarted();
          await proofGate;
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);
  currentTime = new Date(NOW.getTime() + 599_000);
  const request = oauthCallbackRequest(authorization.state);

  const first = handlers.callback(request, null);
  await proofStarted;

  const processingExpiry = idempotency.expiryForOperation(
    "github_user_authorization"
  );
  assert.ok(processingExpiry);
  assert.equal(
    processingExpiry.getTime(),
    currentTime.getTime() + 600_000,
    "processing retention must cover the five-minute route bound plus recovery"
  );

  currentTime = new Date(NOW.getTime() + 601_000);
  await idempotency.cleanupExpired({ before: currentTime, limit: 100 });
  assert.equal(
    idempotency.hasOperation("github_user_authorization"),
    true,
    "global cleanup must not delete a callback while provider work is active"
  );

  releaseProof();
  const response = await first;
  assert.equal(response.status, 303);
  assert.equal(proofCalls, 1);
  assert.equal(store.replacements.length, 1);
});

test("a crash after durable OAuth consumption retries as in-progress without another exchange", async () => {
  const idempotency = new MemoryIdempotencyStore({
    failAfterCompleteOperation: "github_user_authorization",
  });
  let proofCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      { idempotencyStore: idempotency },
      {
        proveInstallationAccess: () => {
          proofCalls += 1;
          return Promise.resolve();
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);
  const request = oauthCallbackRequest(authorization.state);

  const crashed = await handlers.callback(request, null);
  assert.equal(crashed.status, 503);
  assert.equal(await errorCode(crashed), "github_provider_unavailable");
  assert.equal(proofCalls, 0);
  assert.equal(idempotency.hasOperation("github_user_authorization"), true);

  const retry = await handlers.callback(request, null);
  assert.equal(retry.status, 409);
  assert.equal(await errorCode(retry), "request_in_progress");
  assert.equal(proofCalls, 0);
});

test("a near-expiry successful OAuth callback replays its terminal outcome without duplicate work", async () => {
  let currentTime = NOW;
  const idempotency = new MemoryIdempotencyStore();
  const store = new MemoryConnectionStore();
  let proofCalls = 0;
  const handlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createStore: () => store,
        idempotencyStore: idempotency,
        now: () => currentTime,
      },
      {
        proveInstallationAccess: () => {
          proofCalls += 1;
          return Promise.resolve();
        },
      }
    )
  );
  const authorization = await beginUserAuthorization(handlers);
  currentTime = new Date(NOW.getTime() + 599_000);
  const request = oauthCallbackRequest(authorization.state);

  const first = await handlers.callback(request, null);
  const replay = await handlers.callback(request, null);

  assert.equal(first.status, 303);
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get("github-callback-replayed"), "true");
  assert.equal(proofCalls, 1);
  assert.equal(store.replacements.length, 1);
});

test("connection GET revalidates provider authority and returns bounded public metadata only", async () => {
  const store = new MemoryConnectionStore([connection()]);
  const handlers = createGitHubConnectionHandlers(
    dependencies({
      createProvider: () =>
        provider({
          listInstallationRepositories: (_installationId, repositoryIds) => {
            assert.deepEqual(repositoryIds, ["24680"]);
            return Promise.resolve({
              repositories: repositories().repositories.slice(0, 1),
              repositorySelection: "selected",
            });
          },
        }),
      createStore: () => store,
    })
  );

  const response = await handlers.getConnection(
    new Request("https://app.example/api/github/connection"),
    null
  );

  assert.equal(response.status, 200);
  assertNoStore(response);
  const body = (await response.json()) as {
    connected: boolean;
    connections: Record<string, unknown>[];
  };
  assert.equal(body.connected, true);
  assert.deepEqual(body.connections, [
    {
      account: { login: "OpenCoven", type: "Organization" },
      installationId: INSTALLATION_ID,
      repository: {
        id: "24680",
        name: "coven-agents",
        owner: "OpenCoven",
      },
      updatedAt: NOW.toISOString(),
    },
  ]);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /13579|R_one|70000000|token|private.?key/iu);
  assert.equal(store.replacements.length, 1);
  assert.equal(store.replacements[0]?.principal.tenant, TENANT);
});

test("connection GET clears revoked installations and fails closed", async () => {
  const store = new MemoryConnectionStore([connection()]);
  const handlers = createGitHubConnectionHandlers(
    dependencies({
      createProvider: () =>
        provider({
          getInstallation: () =>
            Promise.reject(
              new GitHubProviderError("github_installation_missing", {
                retryable: false,
                status: 404,
              })
            ),
        }),
      createStore: () => store,
    })
  );

  const response = await handlers.getConnection(
    new Request("https://app.example/api/github/connection"),
    null
  );

  assert.equal(response.status, 409);
  assert.equal(await errorCode(response), "github_installation_unusable");
  assert.deepEqual(store.removals, [
    { installationId: INSTALLATION_ID, tenant: TENANT },
  ]);
  assertNoStore(response);
});

test("connection GET preserves authority for ambiguous throttling, malformed, timeout, and 5xx failures", async () => {
  const cases = [
    new GitHubProviderError("github_provider_forbidden", {
      retryable: false,
      status: 403,
    }),
    new GitHubProviderError("github_provider_rejected", {
      retryable: false,
      status: 422,
    }),
    new GitHubProviderError("github_provider_invalid_response", {
      retryable: false,
      status: 502,
    }),
    new GitHubProviderError("github_provider_timeout", {
      retryable: true,
      status: 504,
    }),
    new GitHubProviderError("github_provider_unavailable", {
      retryable: true,
      status: 503,
    }),
  ];

  for (const providerFailure of cases) {
    const store = new MemoryConnectionStore([connection()]);
    const handlers = createGitHubConnectionHandlers(
      dependencies({
        createProvider: () =>
          provider({
            getInstallation: () => Promise.reject(providerFailure),
          }),
        createStore: () => store,
      })
    );

    // biome-ignore lint/performance/noAwaitInLoops: each provider classification owns isolated local authority
    const response = await handlers.getConnection(
      new Request("https://app.example/api/github/connection"),
      null
    );

    assert.equal(response.status, 503);
    assert.equal(await errorCode(response), "github_provider_unavailable");
    assert.deepEqual(store.removals, []);
    assert.deepEqual(store.connections(), [connection()]);
    assertNoStore(response);
  }
});

test("connection GET removes authority after an authenticated suspended installation response", async () => {
  const store = new MemoryConnectionStore([connection()]);
  const handlers = createGitHubConnectionHandlers(
    dependencies({
      createProvider: () =>
        provider({
          getInstallation: () =>
            Promise.resolve(
              installation({ suspendedAt: "2026-08-31T17:00:00.000Z" })
            ),
        }),
      createStore: () => store,
    })
  );

  const response = await handlers.getConnection(
    new Request("https://app.example/api/github/connection"),
    null
  );

  assert.equal(response.status, 409);
  assert.equal(await errorCode(response), "github_installation_unusable");
  assert.deepEqual(store.removals, [
    { installationId: INSTALLATION_ID, tenant: TENANT },
  ]);
  assert.deepEqual(store.connections(), []);
  assertNoStore(response);
});

test("a stale GET refresh cannot resurrect authority after DELETE across store instances", async () => {
  const durable = memoryConnectionDatabase([connection()]);
  const refreshStore = new MemoryConnectionStore(durable);
  const disconnectStore = new MemoryConnectionStore(durable);
  let releaseProvider!: () => void;
  let signalProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    signalProviderStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const refreshHandlers = createGitHubConnectionHandlers(
    dependencies({
      createProvider: () =>
        provider({
          getInstallation: async () => {
            signalProviderStarted();
            await providerGate;
            return installation();
          },
        }),
      createStore: () => refreshStore,
    })
  );
  const disconnectHandlers = createGitHubConnectionHandlers(
    dependencies({ createStore: () => disconnectStore })
  );

  const pendingRefresh = refreshHandlers.getConnection(
    new Request("https://app.example/api/github/connection"),
    null
  );
  await providerStarted;
  const disconnected = await disconnectHandlers.disconnect(
    new Request("https://app.example/api/github/connection", {
      headers: { origin: "https://app.example" },
      method: "DELETE",
    }),
    null
  );
  assert.equal(disconnected.status, 204);
  assert.equal(disconnectStore.generation(), 1);

  releaseProvider();
  const staleRefresh = await pendingRefresh;
  assert.equal(staleRefresh.status, 409);
  assert.equal(await errorCode(staleRefresh), "request_in_progress");
  assert.deepEqual(refreshStore.connections(), []);
  assert.equal(refreshStore.generation(), 1);
  assert.equal(refreshStore.capabilityRevocations(), 1);
});

test("a stale GET removal cannot erase a newer reconnect", async () => {
  const durable = memoryConnectionDatabase([connection()]);
  const refreshStore = new MemoryConnectionStore(durable);
  const reconnectStore = new MemoryConnectionStore(durable);
  let releaseMissing!: () => void;
  let signalLookupStarted!: () => void;
  const lookupStarted = new Promise<void>((resolve) => {
    signalLookupStarted = resolve;
  });
  const missingGate = new Promise<void>((resolve) => {
    releaseMissing = resolve;
  });
  const refreshHandlers = createGitHubConnectionHandlers(
    dependencies({
      createProvider: () =>
        provider({
          getInstallation: async () => {
            signalLookupStarted();
            await missingGate;
            throw new GitHubProviderError("github_installation_missing", {
              retryable: false,
              status: 404,
            });
          },
        }),
      createStore: () => refreshStore,
    })
  );
  const reconnectHandlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createProvider: () =>
          provider({
            listInstallationRepositories: () =>
              Promise.resolve(repositorySelection("86420", "new-authority")),
          }),
        createStore: () => reconnectStore,
        idempotencyStore: new MemoryIdempotencyStore(),
        randomBytes: (size) => new Uint8Array(size).fill(0x33),
      },
      { proveInstallationAccess: () => Promise.resolve() }
    )
  );
  const authorization = await beginUserAuthorization(reconnectHandlers);

  const pendingRefresh = refreshHandlers.getConnection(
    new Request("https://app.example/api/github/connection"),
    null
  );
  await lookupStarted;
  const reconnected = await reconnectHandlers.callback(
    oauthCallbackRequest(authorization.state),
    null
  );
  assert.equal(reconnected.status, 303);
  assert.deepEqual(
    reconnectStore.connections().map(({ repositoryId }) => repositoryId),
    ["86420"]
  );

  releaseMissing();
  const staleRemoval = await pendingRefresh;
  assert.equal(staleRemoval.status, 409);
  assert.equal(await errorCode(staleRemoval), "request_in_progress");
  assert.deepEqual(
    refreshStore.connections().map(({ repositoryId }) => repositoryId),
    ["86420"]
  );
  assert.equal(refreshStore.generation(), 1);
  assert.equal(refreshStore.capabilityRevocations(), 1);
});

test("concurrent reconnects capture one generation and only one can publish authority", async () => {
  const durable = memoryConnectionDatabase([connection()]);
  const firstStore = new MemoryConnectionStore(durable);
  const secondStore = new MemoryConnectionStore(durable);
  let releaseFirstProof!: () => void;
  let releaseSecondProof!: () => void;
  let signalFirstProof!: () => void;
  let signalSecondProof!: () => void;
  const firstProofStarted = new Promise<void>((resolve) => {
    signalFirstProof = resolve;
  });
  const secondProofStarted = new Promise<void>((resolve) => {
    signalSecondProof = resolve;
  });
  const firstProofGate = new Promise<void>((resolve) => {
    releaseFirstProof = resolve;
  });
  const secondProofGate = new Promise<void>((resolve) => {
    releaseSecondProof = resolve;
  });
  const firstHandlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createProvider: () =>
          provider({
            listInstallationRepositories: () =>
              Promise.resolve(repositorySelection("11111", "first-winner")),
          }),
        createStore: () => firstStore,
        idempotencyStore: new MemoryIdempotencyStore(),
        randomBytes: (size) => new Uint8Array(size).fill(0x41),
      },
      {
        proveInstallationAccess: async () => {
          signalFirstProof();
          await firstProofGate;
        },
      }
    )
  );
  const secondHandlers = createGitHubConnectionHandlers(
    dependenciesWithUserAuthorization(
      {
        createProvider: () =>
          provider({
            listInstallationRepositories: () =>
              Promise.resolve(repositorySelection("22222", "stale-loser")),
          }),
        createStore: () => secondStore,
        idempotencyStore: new MemoryIdempotencyStore(),
        randomBytes: (size) => new Uint8Array(size).fill(0x42),
      },
      {
        proveInstallationAccess: async () => {
          signalSecondProof();
          await secondProofGate;
        },
      }
    )
  );
  const [firstAuthorization, secondAuthorization] = await Promise.all([
    beginUserAuthorization(firstHandlers),
    beginUserAuthorization(secondHandlers),
  ]);

  const first = firstHandlers.callback(
    oauthCallbackRequest(firstAuthorization.state),
    null
  );
  const second = secondHandlers.callback(
    oauthCallbackRequest(secondAuthorization.state, SECOND_OAUTH_CODE),
    null
  );
  await Promise.all([firstProofStarted, secondProofStarted]);

  releaseFirstProof();
  const winner = await first;
  assert.equal(winner.status, 303);

  releaseSecondProof();
  const loser = await second;
  assert.equal(loser.status, 409);
  assert.equal(await errorCode(loser), "request_in_progress");
  assert.deepEqual(
    firstStore.connections().map(({ repositoryId }) => repositoryId),
    ["11111"]
  );
  assert.equal(firstStore.generation(), 1);
  assert.equal(firstStore.capabilityRevocations(), 1);
});

test("disconnect enforces same-origin authority, revokes tenant state, and remains idempotent", async () => {
  const store = new MemoryConnectionStore([connection()]);
  const handlers = createGitHubConnectionHandlers(
    dependencies({ createStore: () => store })
  );
  const rejected = await handlers.disconnect(
    new Request("https://app.example/api/github/connection", {
      headers: { origin: "https://evil.example" },
      method: "DELETE",
    }),
    null
  );
  assert.equal(rejected.status, 403);
  assert.equal(await errorCode(rejected), "origin_rejected");
  assert.equal(store.disconnects.length, 0);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: the second call verifies idempotence after the first completes
    const response = await handlers.disconnect(
      new Request("https://app.example/api/github/connection", {
        headers: { origin: "https://app.example" },
        method: "DELETE",
      }),
      null
    );
    assert.equal(response.status, 204);
    assertNoStore(response);
  }
  assert.deepEqual(store.disconnects, [TENANT, TENANT]);
});

function dependencies(
  overrides: Partial<
    Parameters<typeof createGitHubConnectionHandlers>[0] & {
      authorizeSubscriber: () => Promise<
        | RunnerAuthenticatedSubscriber
        | { kind: "subscription_required" | "unauthorized" }
      >;
    }
  > = {}
): Parameters<typeof createGitHubConnectionHandlers>[0] {
  const store = new MemoryConnectionStore();
  return {
    appBasePath: () => "",
    appOrigin: () => "https://app.example",
    auth: {
      authorizeSubscriber:
        overrides.authorizeSubscriber ?? (() => Promise.resolve(subscriber)),
    },
    createProvider: () => provider(),
    createRequestId: () => "request-1",
    createStore: () => store,
    createUserAuthorizationClient: () => ({
      proveInstallationAccess: () => Promise.resolve(),
    }),
    enforceAbuse: () => Promise.resolve({ kind: "allowed" }),
    getConfig: () => CONFIG,
    idempotencyStore: new MemoryIdempotencyStore(),
    now: () => NOW,
    randomBytes: (size) => new Uint8Array(size).fill(0x11),
    ...overrides,
  };
}

function stateFor(
  overrides: Partial<{
    authVersion: number;
    returnPath: string;
    tenant: string;
    userId: string;
  }> = {}
): string {
  return createGitHubInstallState({
    authVersion: overrides.authVersion ?? 4,
    now: NOW,
    randomBytes: (size) => new Uint8Array(size).fill(0x11),
    returnPath: overrides.returnPath ?? "/account?tab=github",
    stateSigningKey: CONFIG.stateSigningKey,
    tenant: overrides.tenant ?? TENANT,
    userId: overrides.userId ?? USER_ID,
  });
}

function callbackRequest(
  state: string,
  basePath = "",
  installationId = INSTALLATION_ID
): Request {
  const query = new URLSearchParams({
    installation_id: installationId,
    setup_action: "install",
    state,
  });
  return new Request(
    `https://app.example${basePath}/api/github/callback?${query}`
  );
}

function oauthCallbackRequest(
  state: string,
  code = OAUTH_CODE,
  basePath = ""
): Request {
  const query = new URLSearchParams({ code, state });
  return new Request(
    `https://app.example${basePath}/api/github/callback?${query}`
  );
}

function installRequest(returnPath: string, basePath = ""): Request {
  const query = new URLSearchParams({ returnTo: returnPath });
  return new Request(
    `https://app.example${basePath}/api/github/install?${query}`
  );
}

function returnPathEncodedBytes(value: string): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") - 2;
}

function nonCanonicalSignatureVariants(state: string): string[] {
  const [version, payload, signature, extra] = state.split(".");
  assert.equal(extra, undefined);
  assert.ok(version);
  assert.ok(payload);
  assert.ok(signature);
  const decoded = Buffer.from(signature, "base64url");
  const prefix = signature.slice(0, -1);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return [...alphabet]
    .filter((character) => character !== signature.at(-1))
    .map((character) => `${version}.${payload}.${prefix}${character}`)
    .filter((candidate) => {
      const candidateSignature = candidate.split(".").at(-1);
      return (
        candidateSignature !== undefined &&
        Buffer.from(candidateSignature, "base64url").equals(decoded)
      );
    });
}

function encodedReturnPath(
  encodedBytes: number,
  unit = "a",
  prefix = "/account?next="
): string {
  const prefixBytes = returnPathEncodedBytes(prefix);
  const unitBytes = returnPathEncodedBytes(unit);
  assert.ok(prefixBytes < encodedBytes);
  assert.ok(unitBytes > 0);
  const available = encodedBytes - prefixBytes;
  const unitCount = Math.floor(available / unitBytes);
  const remainder = available - unitCount * unitBytes;
  const value = `${prefix}${unit.repeat(unitCount)}${"a".repeat(remainder)}`;
  assert.equal(returnPathEncodedBytes(value), encodedBytes);
  return value;
}

async function beginUserAuthorization(
  handlers: ReturnType<typeof createGitHubConnectionHandlers>,
  installState = stateFor()
): Promise<{ codeChallenge: string; state: string }> {
  const response = await handlers.callback(callbackRequest(installState), null);
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  assert.ok(location);
  const authorization = new URL(location);
  assert.equal(
    authorization.origin + authorization.pathname,
    "https://github.com/login/oauth/authorize"
  );
  const state = authorization.searchParams.get("state");
  const codeChallenge = authorization.searchParams.get("code_challenge");
  assert.ok(state);
  assert.ok(codeChallenge);
  return { codeChallenge, state };
}

type UserAuthorizationProofClient = Readonly<{
  proveInstallationAccess: (
    input: Readonly<{
      code: string;
      codeVerifier: string;
      installationId: string;
      redirectUri: string;
    }>
  ) => Promise<void>;
}>;

function dependenciesWithUserAuthorization(
  overrides: Parameters<typeof dependencies>[0],
  client: UserAuthorizationProofClient
): Parameters<typeof createGitHubConnectionHandlers>[0] {
  return {
    ...dependencies(overrides),
    createUserAuthorizationClient: () => client,
  } as Parameters<typeof createGitHubConnectionHandlers>[0];
}

function installation(
  overrides: Partial<GitHubInstallation> = {}
): GitHubInstallation {
  return {
    account: { id: "13579", login: "OpenCoven", type: "Organization" },
    appId: CONFIG.appId,
    appSlug: CONFIG.appSlug,
    id: INSTALLATION_ID,
    permissions: {
      issues: "write",
      metadata: "read",
      organization_projects: "write",
      pull_requests: "write",
    },
    repositorySelection: "selected",
    suspendedAt: null,
    ...overrides,
  };
}

function repositories(): GitHubRepositorySelection {
  return {
    repositories: [
      {
        id: "24680",
        name: "coven-agents",
        nodeId: "R_one",
        owner: "OpenCoven",
      },
      {
        id: "24681",
        name: "coven-web",
        nodeId: "R_two",
        owner: "OpenCoven",
      },
    ],
    repositorySelection: "selected",
  };
}

function repositorySelection(
  repositoryId: string,
  repositoryName: string
): GitHubRepositorySelection {
  return {
    repositories: [
      {
        id: repositoryId,
        name: repositoryName,
        nodeId: `R_${repositoryId}`,
        owner: "OpenCoven",
      },
    ],
    repositorySelection: "selected",
  };
}

function provider(
  overrides: Partial<{
    getInstallation: (installationId: string) => Promise<GitHubInstallation>;
    listInstallationRepositories: (
      installationId: string,
      repositoryIds?: readonly string[]
    ) => Promise<GitHubRepositorySelection>;
  }> = {}
) {
  return {
    getInstallation: () => Promise.resolve(installation()),
    listInstallationRepositories: () => Promise.resolve(repositories()),
    ...overrides,
  };
}

function connection(
  overrides: Partial<GitHubConnectionRecord> = {}
): GitHubConnectionRecord {
  return {
    accountId: "13579",
    accountLogin: "OpenCoven",
    accountType: "Organization",
    createdAt: NOW,
    id: "70000000-0000-4000-8000-000000000001",
    installationId: INSTALLATION_ID,
    repositoryId: "24680",
    repositoryName: "coven-agents",
    repositoryNodeId: "R_one",
    repositoryOwner: "OpenCoven",
    tenant: TENANT,
    updatedAt: NOW,
    version: 0,
    ...overrides,
  };
}

function subscriberFor(
  userId: string,
  tenant: string,
  authVersion: number
): RunnerAuthenticatedSubscriber {
  return {
    authVersion,
    kind: "allowed",
    principal: { kind: "subscriber", tenant, userId },
    session: { kind: "subscriber", tenant, userId },
    userId,
  };
}

type MemoryConnectionDatabase = {
  capabilityRevocations: number;
  connections: GitHubConnectionRecord[];
  generation: number;
};

function memoryConnectionDatabase(
  connections: GitHubConnectionRecord[] = []
): MemoryConnectionDatabase {
  return {
    capabilityRevocations: 0,
    connections: [...connections],
    generation: 0,
  };
}

class MemoryConnectionStore implements GitHubConnectionStore {
  readonly disconnects: string[] = [];
  readonly removals: Array<{ installationId: string; tenant: string }> = [];
  readonly replacements: Array<{
    input: ReplaceGitHubInstallationConnectionsInput;
    principal: RunnerAuthenticatedSubscriber["principal"];
  }> = [];
  readonly #database: MemoryConnectionDatabase;

  constructor(
    source: GitHubConnectionRecord[] | MemoryConnectionDatabase = []
  ) {
    this.#database = Array.isArray(source)
      ? memoryConnectionDatabase(source)
      : source;
  }

  connections(): GitHubConnectionRecord[] {
    return [...this.#database.connections];
  }

  capabilityRevocations(): number {
    return this.#database.capabilityRevocations;
  }

  generation(): number {
    return this.#database.generation;
  }

  disconnectGitHubConnections(
    principal: RunnerAuthenticatedSubscriber["principal"]
  ) {
    this.disconnects.push(principal.tenant);
    const removed = this.#database.connections.length;
    this.#database.connections = [];
    this.#database.generation += 1;
    if (removed > 0) {
      this.#database.capabilityRevocations += 1;
    }
    return Promise.resolve({ removed, revokedCapabilities: removed ? 1 : 0 });
  }

  readGitHubConnectionSnapshot(
    principal: RunnerAuthenticatedSubscriber["principal"],
    limit: number
  ) {
    assert.equal(principal.tenant, TENANT);
    return Promise.resolve({
      connections: this.#database.connections.slice(0, limit),
      generation: this.#database.generation,
    });
  }

  connectGitHubInstallationConnections(
    principal: RunnerAuthenticatedSubscriber["principal"],
    input: ReplaceGitHubInstallationConnectionsInput & {
      expectedGeneration: number;
    }
  ) {
    this.replacements.push({ input, principal });
    if (input.expectedGeneration !== this.#database.generation) {
      return Promise.resolve({ kind: "stale" as const });
    }
    const before = this.#database.connections.filter(
      (value) =>
        value.tenant === principal.tenant &&
        value.installationId === input.installationId
    );
    const connections = this.materializeConnections(principal, input, before);
    const changed = !sameTestConnections(before, connections);
    this.#database.connections = [
      ...this.#database.connections.filter(
        (value) =>
          value.tenant !== principal.tenant ||
          value.installationId !== input.installationId
      ),
      ...connections,
    ];
    this.#database.generation += 1;
    if (changed) {
      this.#database.capabilityRevocations += 1;
    }
    return Promise.resolve({
      changed,
      connections,
      generation: this.#database.generation,
      kind: "connected" as const,
    });
  }

  refreshGitHubInstallationConnections(
    principal: RunnerAuthenticatedSubscriber["principal"],
    input: ReplaceGitHubInstallationConnectionsInput & {
      expectedGeneration: number;
    }
  ) {
    this.replacements.push({ input, principal });
    if (input.expectedGeneration !== this.#database.generation) {
      return Promise.resolve({ kind: "stale" as const });
    }
    const before = this.#database.connections.filter(
      (value) =>
        value.tenant === principal.tenant &&
        value.installationId === input.installationId
    );
    if (before.length === 0) {
      return Promise.resolve({ kind: "stale" as const });
    }
    const connections = this.materializeConnections(principal, input, before);
    const changed = !sameTestConnections(before, connections);
    if (changed) {
      this.#database.connections = [
        ...this.#database.connections.filter(
          (value) =>
            value.tenant !== principal.tenant ||
            value.installationId !== input.installationId
        ),
        ...connections,
      ];
      this.#database.generation += 1;
      this.#database.capabilityRevocations += 1;
    }
    return Promise.resolve({
      changed,
      connections: changed ? connections : before,
      generation: this.#database.generation,
      kind: "refreshed" as const,
    });
  }

  removeGitHubInstallationConnectionsIfCurrent(
    principal: RunnerAuthenticatedSubscriber["principal"],
    input: { expectedGeneration: number; installationId: string }
  ) {
    this.removals.push({
      installationId: input.installationId,
      tenant: principal.tenant,
    });
    if (input.expectedGeneration !== this.#database.generation) {
      return Promise.resolve({ kind: "stale" as const });
    }
    const before = this.#database.connections.length;
    this.#database.connections = this.#database.connections.filter(
      (value) =>
        value.tenant !== principal.tenant ||
        value.installationId !== input.installationId
    );
    const removed = before - this.#database.connections.length;
    if (removed === 0) {
      return Promise.resolve({
        generation: this.#database.generation,
        kind: "unchanged" as const,
      });
    }
    this.#database.generation += 1;
    this.#database.capabilityRevocations += 1;
    return Promise.resolve({
      generation: this.#database.generation,
      kind: "removed" as const,
      removed,
      revokedCapabilities: 1,
    });
  }

  private materializeConnections(
    principal: RunnerAuthenticatedSubscriber["principal"],
    input: ReplaceGitHubInstallationConnectionsInput,
    existing: GitHubConnectionRecord[]
  ): GitHubConnectionRecord[] {
    return input.repositories.map((repository, index) =>
      connection({
        ...repository,
        accountId: input.accountId,
        accountLogin: input.accountLogin,
        accountType: input.accountType,
        createdAt: existing[index]?.createdAt ?? NOW,
        installationId: input.installationId,
        tenant: principal.tenant,
        updatedAt: NOW,
      })
    );
  }
}

function sameTestConnections(
  left: readonly GitHubConnectionRecord[],
  right: readonly GitHubConnectionRecord[]
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class MemoryIdempotencyStore implements IdempotencyStore {
  readonly claims: IdempotencyClaimInput[] = [];
  #failAfterCompleteOperation: string | undefined;
  readonly #records = new Map<
    string,
    {
      claim: Extract<IdempotencyClaimResult, { kind: "claimed" }>["claim"];
      expiresAt: Date;
      response?: IdempotencyCompleteInput["response"];
      state: "completed" | "in_progress";
    }
  >();

  constructor(options: Readonly<{ failAfterCompleteOperation?: string }> = {}) {
    this.#failAfterCompleteOperation = options.failAfterCompleteOperation;
  }

  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.claims.push(input);
    const scope = idempotencyScope(input);
    const record = this.#records.get(scope);
    if (!record) {
      const result = {
        claim: {
          claimExpiresAt: input.claimExpiresAt,
          keyHash: input.keyHash,
          operation: input.operation,
          ownerId: input.ownerId,
          requestHash: input.requestHash,
        },
        kind: "claimed" as const,
      };
      this.#records.set(scope, {
        claim: result.claim,
        expiresAt: input.claimExpiresAt,
        state: "in_progress",
      });
      return Promise.resolve(result);
    }
    if (record.claim.requestHash !== input.requestHash) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (record.state === "in_progress") {
      return Promise.resolve({ kind: "in_progress" });
    }
    assert.ok(record.response);
    return Promise.resolve({
      kind: "completed",
      response: record.response,
    });
  }

  cleanupExpired(input: { before: Date; limit: number }): Promise<void> {
    let removed = 0;
    for (const [scope, record] of this.#records) {
      if (
        removed < input.limit &&
        record.expiresAt.getTime() <= input.before.getTime()
      ) {
        this.#records.delete(scope);
        removed += 1;
      }
    }
    return Promise.resolve();
  }

  complete(input: IdempotencyCompleteInput): Promise<"completed" | "lost"> {
    const record = this.#records.get(idempotencyScope(input.claim));
    if (record?.state !== "in_progress") {
      return Promise.resolve("lost");
    }
    record.state = "completed";
    record.response = input.response;
    record.expiresAt = input.expiresAt;
    if (
      this.#failAfterCompleteOperation &&
      input.claim.operation.includes(this.#failAfterCompleteOperation)
    ) {
      this.#failAfterCompleteOperation = undefined;
      throw new Error("simulated crash after durable callback consumption");
    }
    return Promise.resolve("completed");
  }

  release(input: IdempotencyReleaseInput): Promise<"lost" | "released"> {
    const scope = idempotencyScope(input.claim);
    const record = this.#records.get(scope);
    if (record?.state !== "in_progress") {
      return Promise.resolve("lost");
    }
    this.#records.delete(scope);
    return Promise.resolve("released");
  }

  replaceCompleted(
    input: IdempotencyCompleteInput
  ): Promise<"lost" | "replaced"> {
    const record = this.#records.get(idempotencyScope(input.claim));
    if (record?.state !== "completed") {
      return Promise.resolve("lost");
    }
    record.response = input.response;
    record.expiresAt = input.expiresAt;
    return Promise.resolve("replaced");
  }

  expiryForOperation(operation: string): Date | null {
    for (const record of this.#records.values()) {
      if (record.claim.operation.includes(operation)) {
        return record.expiresAt;
      }
    }
    return null;
  }

  hasOperation(operation: string): boolean {
    return this.expiryForOperation(operation) !== null;
  }
}

function idempotencyScope(input: {
  keyHash: string;
  operation: string;
  ownerId: string;
}): string {
  return `${input.ownerId}\0${input.operation}\0${input.keyHash}`;
}

async function errorCode(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { code: string } };
  return body.error.code;
}

function assertNoStore(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
