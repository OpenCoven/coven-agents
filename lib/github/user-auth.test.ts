import assert from "node:assert/strict";
import { createSecretKey } from "node:crypto";
import test from "node:test";
import { GitHubProviderError } from "./app-auth";
import { createGitHubUserAuthorizationClient } from "./user-auth";

const APP_ID = "123456";
const APP_SLUG = "opencoven-delivery";
const CLIENT_ID = "Iv1.0123456789abcdef";
const CLIENT_SECRET_VALUE = `github-app-client-${"0123456789abcdef".repeat(3)}`;
const CODE = "oauth-code-0123456789abcdef";
const SECOND_CODE = "oauth-code-fedcba9876543210";
const CODE_VERIFIER = "A".repeat(43);
const INSTALLATION_ID = "987654321";
const OTHER_INSTALLATION_ID = "987654322";
const REDIRECT_URI = "https://app.example/api/github/callback";
const USER_TOKEN = `ghu_${"A".repeat(32)}`;
const SECOND_USER_TOKEN = `ghu_${"C".repeat(32)}`;

test("user authorization proves an exact accessible installation and revokes its complete token pair", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      jsonResponse(tokenBody()),
      jsonResponse(installationsBody([INSTALLATION_ID])),
      new Response(null, { status: 204 }),
    ])
  );

  const authority = await client.proveInstallationAccess(proofInput());

  assert.equal(requests.length, 6);
  assert.deepEqual(authority, {
    repositories: [
      {
        id: "24680",
        name: "coven-agents",
        nodeId: "R_24680",
        owner: "OpenCoven",
        permission: "write",
      },
    ],
    user: { id: "112233", login: "BunsDev" },
  });
  assert.deepEqual(
    requests.map(({ redirect }) => redirect),
    ["error", "error", "error", "error", "error", "error"]
  );
  assert.equal(requests[0]?.url, "https://github.com/login/oauth/access_token");
  assert.equal(requests[0]?.method, "POST");
  assert.equal(
    requests[0]?.headers.get("content-type"),
    "application/x-www-form-urlencoded"
  );
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(requests[0]?.body ?? "")),
    {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET_VALUE,
      code: CODE,
      code_verifier: CODE_VERIFIER,
      redirect_uri: REDIRECT_URI,
    }
  );

  assert.equal(
    requests[1]?.url,
    "https://api.github.com/user/installations?page=1&per_page=100"
  );
  assert.equal(
    requests[1]?.headers.get("authorization"),
    `Bearer ${USER_TOKEN}`
  );
  const cleanup = requests.filter(({ method }) => method === "DELETE");
  assert.equal(cleanup.length, 2);
  assert.ok(
    cleanup.every(
      ({ url }) =>
        url === `https://api.github.com/applications/${CLIENT_ID}/token`
    )
  );
  assert.ok(
    cleanup.every(({ headers }) =>
      /^Basic /u.test(headers.get("authorization") ?? "")
    )
  );
  assert.deepEqual(
    cleanup.map(({ body }) => JSON.parse(body ?? "{}").access_token).sort(),
    [`ghr_${"B".repeat(32)}`, USER_TOKEN].sort()
  );
  assert.equal(
    requests.some(({ url }) => url.endsWith("/grant")),
    false
  );
});

test("user authorization enumerates exact installation repositories and derives safe collaborator ceilings", async () => {
  for (const [role, permissions] of [
    [
      "read",
      { admin: false, maintain: false, pull: true, push: false, triage: false },
    ],
    [
      "triage",
      { admin: false, maintain: false, pull: true, push: false, triage: true },
    ],
    [
      "write",
      { admin: false, maintain: false, pull: true, push: true, triage: true },
    ],
    [
      "maintain",
      { admin: false, maintain: true, pull: true, push: true, triage: true },
    ],
    [
      "admin",
      { admin: true, maintain: true, pull: true, push: true, triage: true },
    ],
  ] as const) {
    const requests: CapturedRequest[] = [];
    const client = clientFor(
      authorityFetch(requests, userRepositoriesBody(permissions))
    );

    // biome-ignore lint/performance/noAwaitInLoops: each collaborator role owns an isolated OAuth proof
    const authority = (await client.proveInstallationAccess(
      proofInput()
    )) as unknown as {
      repositories: Array<{
        id: string;
        permission: string;
      }>;
      user: { id: string; login: string };
    };

    assert.equal(
      requests.some(
        ({ url }) =>
          url ===
          `https://api.github.com/user/installations/${INSTALLATION_ID}/repositories?page=1&per_page=100`
      ),
      true
    );
    assert.deepEqual(
      {
        repositories: authority.repositories.map(({ id, permission }) => ({
          id,
          permission,
        })),
        user: authority.user,
      },
      {
        repositories: [{ id: "24680", permission: role }],
        user: { id: "112233", login: "BunsDev" },
      }
    );
  }
});

test("user repository pages accept an omitted selection but reject explicit all access", async () => {
  const { repository_selection: _repositorySelection, ...firstPage } =
    userRepositoriesBody(
      { admin: false, pull: true, push: true },
      { repositoryId: "24680", totalCount: 2 }
    );
  const client = clientFor(
    authorityFetch(
      [],
      firstPage,
      userRepositoriesBody(
        { admin: false, pull: true, push: false },
        { repositoryId: "24681", totalCount: 2 }
      )
    )
  );

  const authority = await client.proveInstallationAccess(proofInput());

  assert.deepEqual(
    authority.repositories.map(({ id, permission }) => ({ id, permission })),
    [
      { id: "24680", permission: "write" },
      { id: "24681", permission: "read" },
    ]
  );

  const allRepositories = userRepositoriesBody({
    admin: false,
    pull: true,
    push: true,
  });
  allRepositories.repository_selection = "all";
  await assert.rejects(
    clientFor(authorityFetch([], allRepositories)).proveInstallationAccess(
      proofInput()
    ),
    providerError("github_provider_invalid_response", false)
  );
});

test("user repository enumeration fails closed when bounded pagination is exhausted", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    authorityFetch(
      requests,
      userRepositoriesBody(
        { admin: false, pull: true, push: false },
        { repositoryId: "24680", totalCount: 3 }
      ),
      userRepositoriesBody(
        { admin: false, pull: true, push: false },
        { repositoryId: "24681", totalCount: 3 }
      )
    ),
    { maxPages: 2 }
  );

  await assert.rejects(
    client.proveInstallationAccess(proofInput()),
    providerError("github_provider_pagination_exhausted", false)
  );
  assert.equal(
    requests.filter(({ url }) =>
      url.includes(`/user/installations/${INSTALLATION_ID}/repositories?`)
    ).length,
    2
  );
});

test("user repository permission hashes cannot claim elevated roles without effective push authority", async () => {
  for (const permissions of [
    {
      admin: true,
      maintain: false,
      pull: true,
      push: false,
      triage: true,
    },
    {
      admin: false,
      maintain: true,
      pull: true,
      push: false,
      triage: true,
    },
  ]) {
    const client = clientFor(
      authorityFetch([], userRepositoriesBody(permissions))
    );
    // biome-ignore lint/performance/noAwaitInLoops: each malformed permission hash owns an isolated OAuth proof
    await assert.rejects(
      client.proveInstallationAccess(proofInput()),
      providerError("github_provider_invalid_response", false)
    );
  }
});

test("an inaccessible exact installation repository endpoint is classified as denied authority", async () => {
  const client = clientFor(
    authorityFetch([], new Response(null, { status: 404 }))
  );

  await assert.rejects(
    client.proveInstallationAccess(proofInput()),
    providerError("github_user_installation_inaccessible", false)
  );
});

test("user authorization accepts canonical loopback callback URLs for development", async () => {
  const client = clientFor(
    sequenceFetch(
      [],
      [
        jsonResponse(tokenBody()),
        jsonResponse(installationsBody([INSTALLATION_ID])),
        new Response(null, { status: 204 }),
      ]
    )
  );

  await client.proveInstallationAccess({
    ...proofInput(),
    redirectUri: "http://localhost:3036/api/github/callback",
  });
});

test("a foreign valid installation is inaccessible and never accepted by app identity alone", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      jsonResponse(tokenBody()),
      jsonResponse(installationsBody([OTHER_INSTALLATION_ID])),
      new Response(null, { status: 204 }),
    ])
  );

  await assert.rejects(
    client.proveInstallationAccess(proofInput()),
    providerError("github_user_installation_inaccessible", false)
  );
  assert.equal(requests.length, 4);
});

test("user installation pagination finds the exact installation on a later bounded page", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      jsonResponse(tokenBody()),
      jsonResponse(installationsBody([OTHER_INSTALLATION_ID], 2)),
      jsonResponse(installationsBody([INSTALLATION_ID], 2)),
      new Response(null, { status: 204 }),
    ])
  );

  await client.proveInstallationAccess(proofInput());

  assert.equal(
    requests[2]?.url,
    "https://api.github.com/user/installations?page=2&per_page=100"
  );
});

test("endless and excessive user installation pagination fails closed", async () => {
  const endless = clientFor(
    sequenceFetch(
      [],
      [
        jsonResponse(tokenBody()),
        jsonResponse(installationsBody(["1"], 3)),
        jsonResponse(installationsBody(["2"], 3)),
        new Response(null, { status: 204 }),
      ]
    ),
    { maxInstallations: 10, maxPages: 2 }
  );
  await assert.rejects(
    endless.proveInstallationAccess(proofInput()),
    providerError("github_provider_pagination_exhausted", false)
  );

  const excessive = clientFor(
    sequenceFetch(
      [],
      [
        jsonResponse(tokenBody()),
        jsonResponse(installationsBody(["1"], 11)),
        new Response(null, { status: 204 }),
      ]
    ),
    { maxInstallations: 10 }
  );
  await assert.rejects(
    excessive.proveInstallationAccess(proofInput()),
    providerError("github_provider_response_too_large", false)
  );
});

test("user installation responses are byte-bounded, well-formed, and time-bounded", async () => {
  const oversized = clientFor(
    sequenceFetch(
      [],
      [
        jsonResponse(tokenBody()),
        new Response("x".repeat(257), { status: 200 }),
        new Response(null, { status: 204 }),
      ]
    ),
    { maxResponseBytes: 256 }
  );
  await assert.rejects(
    oversized.proveInstallationAccess(proofInput()),
    providerError("github_provider_response_too_large", false)
  );

  const malformed = clientFor(
    sequenceFetch(
      [],
      [
        jsonResponse(tokenBody()),
        jsonResponse({ installations: "not-an-array", total_count: 1 }),
        new Response(null, { status: 204 }),
      ]
    )
  );
  await assert.rejects(
    malformed.proveInstallationAccess(proofInput()),
    providerError("github_provider_invalid_response", false)
  );

  const malformedAfterMatch = clientFor(
    sequenceFetch(
      [],
      [
        jsonResponse(tokenBody()),
        jsonResponse({
          installations: [
            installationsBody([INSTALLATION_ID]).installations[0],
            { id: "not-an-installation" },
          ],
          total_count: 2,
        }),
        new Response(null, { status: 204 }),
      ]
    )
  );
  await assert.rejects(
    malformedAfterMatch.proveInstallationAccess(proofInput()),
    providerError("github_provider_invalid_response", false)
  );

  const requests: CapturedRequest[] = [];
  const timedOut = clientFor(userInstallationTimeoutFetch(requests), {
    timeoutMs: 5,
  });
  await assert.rejects(
    timedOut.proveInstallationAccess(proofInput()),
    providerError("github_provider_timeout", true)
  );
  assert.equal(
    requests.at(-1)?.url,
    `https://api.github.com/applications/${CLIENT_ID}/token`
  );
});

test("OAuth code exchange timeout, status errors, oversize, and malformed JSON fail closed", async () => {
  const cases: Array<{
    client: ReturnType<typeof clientFor>;
    code: string;
  }> = [
    {
      client: clientFor(abortableTimeoutFetch(), { timeoutMs: 5 }),
      code: "github_provider_timeout",
    },
    {
      client: clientFor(
        sequenceFetch(
          [],
          [new Response(JSON.stringify({ error: USER_TOKEN }), { status: 400 })]
        )
      ),
      code: "github_oauth_exchange_rejected",
    },
    {
      client: clientFor(
        sequenceFetch(
          [],
          [
            jsonResponse({
              error: "bad_verification_code",
              error_description: USER_TOKEN,
            }),
          ]
        )
      ),
      code: "github_oauth_exchange_rejected",
    },
    {
      client: clientFor(
        sequenceFetch([], [new Response("x".repeat(257), { status: 200 })]),
        { maxResponseBytes: 256 }
      ),
      code: "github_provider_response_too_large",
    },
    {
      client: clientFor(
        sequenceFetch([], [new Response("{", { status: 200 })])
      ),
      code: "github_provider_invalid_json",
    },
    {
      client: clientFor(
        sequenceFetch(
          [],
          [
            jsonResponse({
              access_token: "not-a-user-token",
              token_type: "bearer",
            }),
            new Response(null, { status: 204 }),
          ]
        )
      ),
      code: "github_provider_invalid_response",
    },
  ];

  for (const current of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: each exchange failure owns an isolated client
    await assert.rejects(
      current.client.proveInstallationAccess(proofInput()),
      (error: unknown) => {
        assert.ok(error instanceof GitHubProviderError);
        assert.equal(error.code, current.code);
        assert.doesNotMatch(
          `${String(error)}\n${JSON.stringify(error)}`,
          new RegExp(USER_TOKEN, "u")
        );
        return true;
      }
    );
  }
});

test("valid token candidates in a malformed exchange response are revoked before failure", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      jsonResponse({ ...tokenBody(), scope: "unexpected" }),
      new Response(null, { status: 204 }),
    ])
  );

  await assert.rejects(
    client.proveInstallationAccess(proofInput()),
    providerError("github_provider_invalid_response", false)
  );
  assert.equal(requests.length, 3);
  const cleanup = requests.filter(({ method }) => method === "DELETE");
  assert.deepEqual(
    cleanup.map(({ body }) => JSON.parse(body ?? "{}").access_token).sort(),
    [`ghr_${"B".repeat(32)}`, USER_TOKEN].sort()
  );
});

test("a valid refresh candidate is revoked when its access-token companion is malformed", async () => {
  const refreshToken = `ghr_${"B".repeat(32)}`;
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      jsonResponse({
        access_token: { malformed: true },
        expires_in: 28_800,
        refresh_token: refreshToken,
        refresh_token_expires_in: 15_897_600,
        scope: "",
        token_type: "bearer",
      }),
      new Response(null, { status: 204 }),
    ])
  );

  await assert.rejects(
    client.proveInstallationAccess(proofInput()),
    providerError("github_provider_invalid_response", false)
  );
  const cleanup = requests.filter(({ method }) => method === "DELETE");
  assert.deepEqual(
    cleanup.map(({ body }) => JSON.parse(body ?? "{}").access_token),
    [refreshToken]
  );
});

test("a bounded malformed token candidate is revoked without being used", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      jsonResponse({
        access_token: "malformed-user-token-candidate",
        scope: "",
        token_type: "bearer",
      }),
      new Response(null, { status: 204 }),
    ])
  );

  await assert.rejects(
    client.proveInstallationAccess(proofInput()),
    providerError("github_provider_invalid_response", false)
  );
  assert.equal(requests.length, 2);
  assert.equal(
    requests[1]?.url,
    `https://api.github.com/applications/${CLIENT_ID}/token`
  );
  assert.equal(
    requests.some(({ url }) => url.includes("/user/installations")),
    false
  );
});

test("OAuth and user-installation response bodies remain inside the request timeout", async () => {
  const exchangeBody = clientFor(
    sequenceFetch(
      [],
      [
        delayedJsonResponse(tokenBody(), 20),
        jsonResponse(installationsBody([INSTALLATION_ID])),
        new Response(null, { status: 204 }),
      ]
    ),
    { timeoutMs: 5 }
  );
  await assert.rejects(
    exchangeBody.proveInstallationAccess(proofInput()),
    providerError("github_provider_timeout", true)
  );

  const userBody = clientFor(
    sequenceFetch(
      [],
      [
        jsonResponse(tokenBody()),
        delayedJsonResponse(installationsBody([INSTALLATION_ID]), 20),
        new Response(null, { status: 204 }),
      ]
    ),
    { timeoutMs: 5 }
  );
  await assert.rejects(
    userBody.proveInstallationAccess(proofInput()),
    providerError("github_provider_timeout", true)
  );
});

test("user tokens and provider bodies cannot leak through lookup or revocation errors", async () => {
  for (const responses of [
    [
      jsonResponse(tokenBody()),
      new Response(JSON.stringify({ message: USER_TOKEN }), { status: 503 }),
      new Response(null, { status: 204 }),
    ],
    [
      jsonResponse(tokenBody()),
      jsonResponse(installationsBody([INSTALLATION_ID])),
      new Response(JSON.stringify({ message: USER_TOKEN }), { status: 503 }),
    ],
  ]) {
    const client = clientFor(sequenceFetch([], responses));
    // biome-ignore lint/performance/noAwaitInLoops: each leakage boundary owns an isolated client
    await assert.rejects(
      client.proveInstallationAccess(proofInput()),
      (error: unknown) => {
        const serialized = `${String(error)}\n${JSON.stringify(error)}`;
        assert.doesNotMatch(serialized, new RegExp(USER_TOKEN, "u"));
        assert.doesNotMatch(serialized, /client-secret/u);
        return true;
      }
    );
  }
});

test("concurrent user proofs revoke only their own token authority", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(concurrentTokenFetch(requests));

  await Promise.all([
    client.proveInstallationAccess(proofInput()),
    client.proveInstallationAccess({
      ...proofInput(),
      code: SECOND_CODE,
    }),
  ]);

  const cleanup = requests.filter(({ method }) => method === "DELETE");
  assert.equal(cleanup.length, 4);
  assert.deepEqual(
    cleanup.map(({ body }) => JSON.parse(body ?? "{}").access_token).sort(),
    [
      `ghr_${"B".repeat(32)}`,
      `ghr_${"D".repeat(32)}`,
      SECOND_USER_TOKEN,
      USER_TOKEN,
    ].sort()
  );
  assert.ok(
    cleanup.every(
      ({ url }) =>
        url === `https://api.github.com/applications/${CLIENT_ID}/token`
    )
  );
});

test("user-token revocation waits for every in-flight authority request to settle", async () => {
  let cleanupCalls = 0;
  let releaseRepositories!: () => void;
  let signalRepositoriesStarted!: () => void;
  const repositoriesStarted = new Promise<void>((resolve) => {
    signalRepositoriesStarted = resolve;
  });
  const repositoryGate = new Promise<void>((resolve) => {
    releaseRepositories = resolve;
  });
  const client = clientFor(async (input, init = {}) => {
    if (input === "https://github.com/login/oauth/access_token") {
      return jsonResponse(tokenBody());
    }
    if (input.includes("/user/installations?")) {
      return jsonResponse(installationsBody([INSTALLATION_ID]));
    }
    if (
      input.startsWith(
        `https://api.github.com/user/installations/${INSTALLATION_ID}/repositories?`
      )
    ) {
      signalRepositoriesStarted();
      await repositoryGate;
      return jsonResponse(
        userRepositoriesBody({
          admin: false,
          pull: true,
          push: false,
        })
      );
    }
    if (input === "https://api.github.com/user") {
      return new Response(null, { status: 503 });
    }
    if (init.method === "DELETE") {
      cleanupCalls += 1;
      return new Response(null, { status: 204 });
    }
    assert.fail(`Unexpected request to ${input}`);
  });

  const pending = client.proveInstallationAccess(proofInput()).then(
    () => null,
    (error: unknown) => error
  );
  await repositoriesStarted;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(cleanupCalls, 0);
  releaseRepositories();
  assert.equal(
    providerError("github_provider_unavailable", true)(await pending),
    true
  );
  assert.equal(cleanupCalls, 2);
});

test("expiring-token refresh authority is retained only until both tokens are revoked", async () => {
  const refreshToken = `ghr_${"B".repeat(32)}`;
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      jsonResponse(tokenBody(USER_TOKEN, refreshToken)),
      jsonResponse(installationsBody([INSTALLATION_ID])),
      new Response(null, { status: 204 }),
    ])
  );

  await client.proveInstallationAccess(proofInput());

  assert.equal(requests.length, 6);
  const authorityRequests = JSON.stringify(
    requests
      .filter(({ method }) => method !== "DELETE")
      .map(({ body, headers, method, url }) => ({
        body,
        headers: Object.fromEntries(headers),
        method,
        url,
      }))
  );
  assert.doesNotMatch(authorityRequests, new RegExp(refreshToken, "u"));
  const cleanup = requests.filter(({ method }) => method === "DELETE");
  assert.deepEqual(
    cleanup.map(({ body }) => JSON.parse(body ?? "{}").access_token).sort(),
    [refreshToken, USER_TOKEN].sort()
  );
  const serializedCleanup = JSON.stringify(
    cleanup.map(({ body, headers, method, url }) => ({
      body,
      headers: Object.fromEntries(headers),
      method,
      url,
    }))
  );
  assert.match(serializedCleanup, new RegExp(refreshToken, "u"));
});

test("both token revocations are attempted before a cleanup failure is surfaced", async () => {
  const refreshToken = `ghr_${"B".repeat(32)}`;
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      jsonResponse(tokenBody(USER_TOKEN, refreshToken)),
      jsonResponse(installationsBody([INSTALLATION_ID])),
      new Response(null, { status: 503 }),
      new Response(null, { status: 204 }),
    ])
  );

  await assert.rejects(
    client.proveInstallationAccess(proofInput()),
    providerError("github_provider_unavailable", true)
  );
  const cleanup = requests.filter(({ method }) => method === "DELETE");
  assert.deepEqual(
    cleanup.map(({ body }) => JSON.parse(body ?? "{}").access_token).sort(),
    [refreshToken, USER_TOKEN].sort()
  );
});

test("user authorization errors retain only canonical GitHub request ids", async () => {
  for (const [requestId, expected] of [
    ["ABC1:234", "ABC1:234"],
    ["unsafe request id/value", null],
  ] as const) {
    const client = clientFor(
      sequenceFetch(
        [],
        [
          new Response(JSON.stringify({ message: USER_TOKEN }), {
            headers: { "x-github-request-id": requestId },
            status: 503,
          }),
        ]
      )
    );
    // biome-ignore lint/performance/noAwaitInLoops: each request id owns an isolated provider response
    await assert.rejects(
      client.proveInstallationAccess(proofInput()),
      (error: unknown) => {
        assert.ok(error instanceof GitHubProviderError);
        assert.equal(error.requestId, expected);
        assert.doesNotMatch(
          `${String(error)}\n${JSON.stringify(error)}`,
          new RegExp(USER_TOKEN, "u")
        );
        return true;
      }
    );
  }
});

type CapturedRequest = {
  body: string | null;
  headers: Headers;
  method: string;
  redirect: RequestRedirect | undefined;
  url: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function clientFor(
  fetchImpl: FetchLike,
  overrides: Partial<{
    maxInstallations: number;
    maxPages: number;
    maxResponseBytes: number;
    timeoutMs: number;
  }> = {}
) {
  return createGitHubUserAuthorizationClient({
    appId: APP_ID,
    appSlug: APP_SLUG,
    clientId: CLIENT_ID,
    clientSecret: createSecretKey(Buffer.from(CLIENT_SECRET_VALUE, "utf8")),
    fetch: fetchImpl,
    maxInstallations: overrides.maxInstallations,
    maxPages: overrides.maxPages,
    maxResponseBytes: overrides.maxResponseBytes,
    timeoutMs: overrides.timeoutMs,
  });
}

function proofInput() {
  return {
    code: CODE,
    codeVerifier: CODE_VERIFIER,
    installationId: INSTALLATION_ID,
    redirectUri: REDIRECT_URI,
  };
}

function tokenBody(
  accessToken = USER_TOKEN,
  refreshToken = `ghr_${"B".repeat(32)}`
) {
  return {
    access_token: accessToken,
    expires_in: 28_800,
    refresh_token: refreshToken,
    refresh_token_expires_in: 15_897_600,
    scope: "",
    token_type: "bearer",
  };
}

function installationsBody(ids: readonly string[], totalCount = ids.length) {
  return {
    installations: ids.map((id) => ({
      app_id: APP_ID,
      app_slug: APP_SLUG,
      client_id: CLIENT_ID,
      id,
    })),
    total_count: totalCount,
  };
}

function userRepositoriesBody(
  permissions: Readonly<{
    admin: boolean;
    maintain?: boolean;
    pull: boolean;
    push: boolean;
    triage?: boolean;
  }>,
  options: Readonly<{
    repositoryId?: string;
    totalCount?: number;
  }> = {}
) {
  const repositoryId = options.repositoryId ?? "24680";
  return {
    repositories: [
      {
        full_name: "OpenCoven/coven-agents",
        id: repositoryId,
        name: "coven-agents",
        node_id: `R_${repositoryId}`,
        owner: { login: "OpenCoven" },
        permissions,
      },
    ],
    repository_selection: "selected",
    total_count: options.totalCount ?? 1,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function delayedJsonResponse(body: unknown, delayMs: number): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        globalThis.setTimeout(() => {
          controller.enqueue(bytes);
          controller.close();
        }, delayMs);
      },
    }),
    {
      headers: { "content-type": "application/json" },
      status: 200,
    }
  );
}

function sequenceFetch(
  captured: CapturedRequest[],
  responses: Response[]
): FetchLike {
  return (input, init = {}) => {
    captured.push(capturedRequest(input, init));
    if (input === "https://api.github.com/user") {
      return Promise.resolve(jsonResponse({ id: "112233", login: "BunsDev" }));
    }
    if (
      input.startsWith(
        `https://api.github.com/user/installations/${INSTALLATION_ID}/repositories?`
      )
    ) {
      return Promise.resolve(
        jsonResponse(
          userRepositoriesBody({
            admin: false,
            maintain: false,
            pull: true,
            push: true,
            triage: true,
          })
        )
      );
    }
    const next = responses.shift();
    if (!next && init.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    assert.ok(next, `Unexpected request to ${input}`);
    return Promise.resolve(next);
  };
}

function authorityFetch(
  captured: CapturedRequest[],
  ...repositoryPages: unknown[]
): FetchLike {
  return (input, init = {}) => {
    captured.push(capturedRequest(input, init));
    if (input === "https://github.com/login/oauth/access_token") {
      return Promise.resolve(jsonResponse(tokenBody()));
    }
    if (input === "https://api.github.com/user") {
      return Promise.resolve(jsonResponse({ id: "112233", login: "BunsDev" }));
    }
    if (
      input.startsWith(
        `https://api.github.com/user/installations/${INSTALLATION_ID}/repositories?`
      )
    ) {
      const next = repositoryPages.shift();
      assert.ok(next, `Unexpected repository authority request to ${input}`);
      return Promise.resolve(
        next instanceof Response ? next : jsonResponse(next)
      );
    }
    if (input.includes("/user/installations?")) {
      return Promise.resolve(
        jsonResponse(installationsBody([INSTALLATION_ID]))
      );
    }
    if (init.method === "DELETE") {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    assert.fail(`Unexpected request to ${input}`);
  };
}

function userInstallationTimeoutFetch(captured: CapturedRequest[]): FetchLike {
  return (input, init = {}) => {
    captured.push(capturedRequest(input, init));
    if (input === "https://github.com/login/oauth/access_token") {
      return Promise.resolve(jsonResponse(tokenBody()));
    }
    if (input.includes("/user/installations")) {
      return abortable(init);
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  };
}

function concurrentTokenFetch(captured: CapturedRequest[]): FetchLike {
  const active = new Set([USER_TOKEN, SECOND_USER_TOKEN]);
  let signalFirstCleanup!: () => void;
  const firstCleanup = new Promise<void>((resolve) => {
    signalFirstCleanup = resolve;
  });

  return async (input, init = {}) => {
    captured.push(capturedRequest(input, init));
    if (input === "https://github.com/login/oauth/access_token") {
      const code = new URLSearchParams(
        typeof init.body === "string" ? init.body : ""
      ).get("code");
      return jsonResponse(
        tokenBody(
          code === SECOND_CODE ? SECOND_USER_TOKEN : USER_TOKEN,
          code === SECOND_CODE
            ? `ghr_${"D".repeat(32)}`
            : `ghr_${"B".repeat(32)}`
        )
      );
    }
    if (input === "https://api.github.com/user") {
      return jsonResponse({ id: "112233", login: "BunsDev" });
    }
    if (
      input.startsWith(
        `https://api.github.com/user/installations/${INSTALLATION_ID}/repositories?`
      )
    ) {
      return jsonResponse(
        userRepositoriesBody({
          admin: false,
          maintain: false,
          pull: true,
          push: true,
          triage: true,
        })
      );
    }
    if (input.includes("/user/installations?")) {
      const token = new Headers(init.headers)
        .get("authorization")
        ?.split(" ")
        .at(-1);
      if (token === SECOND_USER_TOKEN) {
        await firstCleanup;
      }
      return active.has(token ?? "")
        ? jsonResponse(installationsBody([INSTALLATION_ID]))
        : new Response(null, { status: 401 });
    }
    if (init.method === "DELETE") {
      const token = JSON.parse(
        typeof init.body === "string" ? init.body : "{}"
      ).access_token;
      if (input.endsWith("/grant")) {
        active.clear();
      } else if (typeof token === "string") {
        active.delete(token);
      }
      if (token === USER_TOKEN) {
        signalFirstCleanup();
      }
      return new Response(null, { status: 204 });
    }
    assert.fail(`Unexpected request to ${input}`);
  };
}

function abortableTimeoutFetch(): FetchLike {
  return (_input, init = {}) => abortable(init);
}

function abortable(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true }
    );
  });
}

function capturedRequest(input: string, init: RequestInit): CapturedRequest {
  return {
    body: typeof init.body === "string" ? init.body : null,
    headers: new Headers(init.headers),
    method: init.method ?? "GET",
    redirect: init.redirect,
    url: input,
  };
}

function providerError(code: string, retryable: boolean) {
  return (error: unknown) =>
    error instanceof GitHubProviderError &&
    error.code === code &&
    error.retryable === retryable;
}
