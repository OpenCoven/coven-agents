import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
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
  type GitHubConnectionStore,
  verifyGitHubInstallState,
} from "./connection";

const NOW = new Date("2026-08-31T18:00:00.000Z");
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_USER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TENANT = "u_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
const OTHER_TENANT = "u_bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb";
const INSTALLATION_ID = "987654321";
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const CONFIG = githubAppConfig({
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

  const callback = await handlers.callback(callbackRequest(state), null);
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
  const request = callbackRequest(state);

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
    3,
    "initial + persistence revalidation + replay auth"
  );
  assert.equal(store.replacements.length, 1);
  assert.equal(store.replacements[0]?.principal.tenant, TENANT);
  assert.deepEqual(store.replacements[0]?.input, {
    accountId: "13579",
    accountLogin: "OpenCoven",
    accountType: "Organization",
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
  assert.equal(idempotency.claims.length, 2);
  assert.doesNotMatch(
    JSON.stringify(idempotency.claims),
    new RegExp(escapeRegExp(state), "u")
  );
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
    // biome-ignore lint/performance/noAwaitInLoops: each authority case owns isolated durable state
    const response = await createGitHubConnectionHandlers(
      dependencies({
        createProvider: current.provider,
        createStore: () => store,
      })
    ).callback(callbackRequest(stateFor()), null);

    assert.equal(response.status, 409);
    assert.equal(await errorCode(response), "github_installation_unusable");
    assert.deepEqual(store.removals, [
      { installationId: INSTALLATION_ID, tenant: TENANT },
    ]);
    assert.equal(store.replacements.length, 0);
    assertNoStore(response);
  }
});

test("transient provider failures are sanitized, retryable, and do not consume state", async () => {
  const state = stateFor();
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

  const failed = await handlers.callback(callbackRequest(state), null);
  assert.equal(failed.status, 503);
  assert.equal(await errorCode(failed.clone()), "github_provider_unavailable");
  assert.doesNotMatch(await failed.clone().text(), /installation-local-token/u);

  const retried = await handlers.callback(callbackRequest(state), null);
  assert.equal(retried.status, 303);
  assert.equal(attempts, 2);
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

function callbackRequest(state: string): Request {
  const query = new URLSearchParams({
    installation_id: INSTALLATION_ID,
    setup_action: "install",
    state,
  });
  return new Request(`https://app.example/api/github/callback?${query}`);
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

class MemoryConnectionStore implements GitHubConnectionStore {
  readonly disconnects: string[] = [];
  readonly removals: Array<{ installationId: string; tenant: string }> = [];
  readonly replacements: Array<{
    input: ReplaceGitHubInstallationConnectionsInput;
    principal: RunnerAuthenticatedSubscriber["principal"];
  }> = [];
  #connections: GitHubConnectionRecord[];

  constructor(connections: GitHubConnectionRecord[] = []) {
    this.#connections = connections;
  }

  disconnectGitHubConnections(
    principal: RunnerAuthenticatedSubscriber["principal"]
  ) {
    this.disconnects.push(principal.tenant);
    const removed = this.#connections.length;
    this.#connections = [];
    return Promise.resolve({ removed, revokedCapabilities: removed ? 1 : 0 });
  }

  listGitHubConnections(
    principal: RunnerAuthenticatedSubscriber["principal"],
    limit: number
  ) {
    assert.equal(principal.tenant, TENANT);
    return Promise.resolve(this.#connections.slice(0, limit));
  }

  removeGitHubInstallationConnections(
    principal: RunnerAuthenticatedSubscriber["principal"],
    installationId: string
  ) {
    this.removals.push({ installationId, tenant: principal.tenant });
    const before = this.#connections.length;
    this.#connections = this.#connections.filter(
      (value) =>
        value.tenant !== principal.tenant ||
        value.installationId !== installationId
    );
    return Promise.resolve({
      removed: before - this.#connections.length,
      revokedCapabilities: 1,
    });
  }

  replaceGitHubInstallationConnections(
    principal: RunnerAuthenticatedSubscriber["principal"],
    input: ReplaceGitHubInstallationConnectionsInput
  ) {
    this.replacements.push({ input, principal });
    const existing = this.#connections.filter(
      (value) =>
        value.tenant === principal.tenant &&
        value.installationId === input.installationId
    );
    const connections = input.repositories.map((repository, index) =>
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
    this.#connections = [
      ...this.#connections.filter(
        (value) =>
          value.tenant !== principal.tenant ||
          value.installationId !== input.installationId
      ),
      ...connections,
    ];
    return Promise.resolve({ changed: true, connections });
  }
}

class MemoryIdempotencyStore implements IdempotencyStore {
  readonly claims: IdempotencyClaimInput[] = [];
  #record:
    | {
        claim: IdempotencyClaimResult & { kind: "claimed" };
        response?: IdempotencyCompleteInput["response"];
        state: "completed" | "in_progress";
      }
    | undefined;

  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult> {
    this.claims.push(input);
    if (!this.#record) {
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
      this.#record = { claim: result, state: "in_progress" };
      return Promise.resolve(result);
    }
    if (
      this.#record.claim.claim.keyHash !== input.keyHash ||
      this.#record.claim.claim.ownerId !== input.ownerId ||
      this.#record.claim.claim.operation !== input.operation ||
      this.#record.claim.claim.requestHash !== input.requestHash
    ) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (this.#record.state === "in_progress") {
      return Promise.resolve({ kind: "in_progress" });
    }
    assert.ok(this.#record.response);
    return Promise.resolve({
      kind: "completed",
      response: this.#record.response,
    });
  }

  cleanupExpired(): Promise<void> {
    return Promise.resolve();
  }

  complete(input: IdempotencyCompleteInput): Promise<"completed" | "lost"> {
    assert.ok(this.#record);
    this.#record.state = "completed";
    this.#record.response = input.response;
    return Promise.resolve("completed");
  }

  release(_input: IdempotencyReleaseInput): Promise<"lost" | "released"> {
    this.#record = undefined;
    return Promise.resolve("released");
  }
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
