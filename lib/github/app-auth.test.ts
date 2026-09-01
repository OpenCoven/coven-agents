import assert from "node:assert/strict";
import { createPrivateKey, generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import {
  createGitHubAppClient,
  createGitHubAppJwt,
  GitHubProviderError,
  githubInstallationTokenRequest,
} from "./app-auth";

const NOW = Date.parse("2026-08-31T18:00:00.000Z");
const APP_ID = "123456";
const APP_SLUG = "opencoven-delivery";
const keys = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const APP_SIGNER = createPrivateKey(keys.privateKey);
const INSTALLATION_ID = "987654321";
const INSTALLATION_TOKEN = "installation-local-token";

test("GitHub App JWT is a verifiable RS256 token with safely bounded claims", () => {
  const jwt = createGitHubAppJwt(
    { appId: APP_ID, privateKey: APP_SIGNER },
    NOW
  );
  const [encodedHeader, encodedPayload, encodedSignature, extra] =
    jwt.split(".");
  assert.equal(extra, undefined);
  assert.ok(encodedHeader);
  assert.ok(encodedPayload);
  assert.ok(encodedSignature);

  const header = decodeSegment(encodedHeader);
  const payload = decodeSegment(encodedPayload);
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(payload.iss, APP_ID);
  assert.equal(payload.iat, Math.floor(NOW / 1000) - 60);
  assert.equal(payload.exp, Math.floor(NOW / 1000) + 540);
  assert.ok(Number(payload.exp) - Number(payload.iat) <= 600);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      keys.publicKey,
      Buffer.from(encodedSignature, "base64url")
    ),
    true
  );
});

test("installation token requests always narrow permissions and safely supported repository ids", () => {
  assert.deepEqual(githubInstallationTokenRequest({ metadata: "read" }), {
    permissions: { metadata: "read" },
  });
  assert.deepEqual(
    githubInstallationTokenRequest({ issues: "write", metadata: "read" }, [
      "123",
      "456",
    ]),
    {
      permissions: { issues: "write", metadata: "read" },
      repository_ids: [123, 456],
    }
  );
  assert.throws(
    () =>
      githubInstallationTokenRequest({ metadata: "read" }, [
        "18446744073709551615",
      ]),
    /safe decimal/u
  );
});

test("installation metadata is authenticated with a fresh app JWT and preserves decimal ids", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      response(installationBody({ id: "18446744073709551615" })),
    ])
  );

  const installation = await client.getInstallation("18446744073709551615");

  assert.deepEqual(installation, {
    account: {
      id: "18446744073709551614",
      login: "OpenCoven",
      type: "Organization",
    },
    appId: APP_ID,
    appSlug: APP_SLUG,
    id: "18446744073709551615",
    permissions: {
      issues: "write",
      metadata: "read",
      organization_projects: "write",
      pull_requests: "write",
    },
    repositorySelection: "selected",
    suspendedAt: null,
  });
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.url,
    "https://api.github.com/app/installations/18446744073709551615"
  );
  assert.match(
    requests[0]?.headers.get("authorization") ?? "",
    /^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u
  );
});

test("installation metadata rejects a target identity that disagrees with the account", async () => {
  for (const overrides of [{ target_id: "999" }, { target_type: "User" }]) {
    const client = clientFor(
      sequenceFetch([], [response(installationBody(overrides))])
    );
    // biome-ignore lint/performance/noAwaitInLoops: each identity mismatch owns a one-response provider sequence
    await assert.rejects(
      client.getInstallation(INSTALLATION_ID),
      (error: unknown) =>
        error instanceof GitHubProviderError &&
        error.code === "github_provider_invalid_response"
    );
  }
});

test("repository enumeration exchanges a metadata-only token immediately before bounded calls", async () => {
  const requests: CapturedRequest[] = [];
  const client = clientFor(
    sequenceFetch(requests, [
      response({
        expires_at: "2026-08-31T19:00:00.000Z",
        token: INSTALLATION_TOKEN,
      }),
      response({
        repositories: [repositoryBody()],
        repository_selection: "selected",
        total_count: 1,
      }),
    ])
  );

  const result = await client.listInstallationRepositories(INSTALLATION_ID, [
    "24680",
  ]);

  assert.deepEqual(result, {
    repositories: [
      {
        id: "24680",
        name: "coven-agents",
        nodeId: "R_kgDOExample",
        owner: "OpenCoven",
      },
    ],
    repositorySelection: "selected",
  });
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0]?.url,
    `https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`
  );
  assert.equal(requests[0]?.method, "POST");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ""), {
    permissions: { metadata: "read" },
    repository_ids: [24_680],
  });
  assert.equal(
    requests[1]?.headers.get("authorization"),
    `Bearer ${INSTALLATION_TOKEN}`
  );
  assert.equal(
    requests[1]?.url,
    "https://api.github.com/installation/repositories?page=1&per_page=100"
  );
});

test("provider requests time out through an abort signal", async () => {
  const client = clientFor(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true }
        );
      }),
    { timeoutMs: 5 }
  );

  await assert.rejects(
    client.getInstallation(INSTALLATION_ID),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "github_provider_timeout" &&
      error.retryable
  );
});

test("provider timeout covers a response body that never completes", {
  timeout: 100,
}, async () => {
  const client = clientFor(
    () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start() {
              // The timeout must bound a provider that sent headers and stalled.
            },
          }),
          { status: 200 }
        )
      ),
    { timeoutMs: 5 }
  );

  await assert.rejects(
    client.getInstallation(INSTALLATION_ID),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "github_provider_timeout"
  );
});

test("provider response bytes and JSON parsing are strictly bounded", async () => {
  const excessive = clientFor(
    sequenceFetch([], [new Response("x".repeat(257), { status: 200 })]),
    { maxResponseBytes: 256 }
  );
  await assert.rejects(
    excessive.getInstallation(INSTALLATION_ID),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "github_provider_response_too_large"
  );

  const malformed = clientFor(
    sequenceFetch([], [new Response("{", { status: 200 })])
  );
  await assert.rejects(
    malformed.getInstallation(INSTALLATION_ID),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "github_provider_invalid_json"
  );
});

test("repository pagination fails closed when the page bound is exhausted", async () => {
  const client = clientFor(
    sequenceFetch(
      [],
      [
        response({
          expires_at: "2026-08-31T19:00:00.000Z",
          token: INSTALLATION_TOKEN,
        }),
        response({
          repositories: [repositoryBody({ id: 1, name: "one" })],
          repository_selection: "selected",
          total_count: 10,
        }),
        response({
          repositories: [repositoryBody({ id: 2, name: "two" })],
          repository_selection: "selected",
          total_count: 10,
        }),
      ]
    ),
    { maxPages: 2, maxRepositories: 100 }
  );

  await assert.rejects(
    client.listInstallationRepositories(INSTALLATION_ID),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "github_provider_pagination_exhausted"
  );
});

test("repository enumeration rejects excessive installation scope", async () => {
  const client = clientFor(
    sequenceFetch(
      [],
      [
        response({
          expires_at: "2026-08-31T19:00:00.000Z",
          token: INSTALLATION_TOKEN,
        }),
        response({
          repositories: [repositoryBody()],
          repository_selection: "selected",
          total_count: 17,
        }),
      ]
    )
  );

  await assert.rejects(
    client.listInstallationRepositories(INSTALLATION_ID),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "github_repository_limit"
  );
});

test("provider statuses are classified without exposing response bodies or unsafe request ids", async () => {
  const cases = [
    [401, "github_provider_unauthorized", false],
    [403, "github_provider_forbidden", true],
    [404, "github_installation_missing", false],
    [409, "github_provider_conflict", false],
    [422, "github_provider_rejected", true],
    [429, "github_provider_rate_limited", true],
    [500, "github_provider_unavailable", true],
  ] as const;

  for (const [status, code, retryable] of cases) {
    const client = clientFor(
      sequenceFetch(
        [],
        [
          new Response(
            JSON.stringify({
              message: `private provider detail ${INSTALLATION_TOKEN}`,
            }),
            {
              headers: {
                "x-github-request-id":
                  status === 500 ? "unsafe request id/value" : "ABC1:234",
              },
              status,
            }
          ),
        ]
      )
    );

    // biome-ignore lint/performance/noAwaitInLoops: each case owns a one-response provider sequence
    await assert.rejects(
      client.getInstallation(INSTALLATION_ID),
      (error: unknown) => {
        assert.ok(error instanceof GitHubProviderError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.equal(error.requestId, status === 500 ? null : "ABC1:234");
        const serialized = `${error.message}\n${JSON.stringify(error)}`;
        assert.doesNotMatch(serialized, /private provider detail/u);
        assert.doesNotMatch(serialized, new RegExp(INSTALLATION_TOKEN, "u"));
        return true;
      }
    );
  }
});

test("explicit rate headers classify ambiguous 403 and 422 responses as throttling", async () => {
  for (const status of [403, 422]) {
    const client = clientFor(
      sequenceFetch(
        [],
        [
          new Response(JSON.stringify({ message: INSTALLATION_TOKEN }), {
            headers: {
              "retry-after": "60",
              "x-github-request-id": "ABC1:234",
            },
            status,
          }),
        ]
      )
    );

    // biome-ignore lint/performance/noAwaitInLoops: each status owns an isolated provider sequence
    await assert.rejects(
      client.getInstallation(INSTALLATION_ID),
      (error: unknown) =>
        error instanceof GitHubProviderError &&
        error.code === "github_provider_rate_limited" &&
        error.requestId === "ABC1:234" &&
        error.retryable
    );
  }
});

test("only a 404 from the exact installation endpoint confirms installation absence", async () => {
  const missingInstallation = clientFor(
    sequenceFetch([], [new Response(null, { status: 404 })])
  );
  await assert.rejects(
    missingInstallation.getInstallation(INSTALLATION_ID),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "github_installation_missing" &&
      !error.retryable
  );

  const ambiguousRepositoryLookup = clientFor(
    sequenceFetch([], [new Response(null, { status: 404 })])
  );
  await assert.rejects(
    ambiguousRepositoryLookup.listInstallationRepositories(INSTALLATION_ID, [
      "24680",
    ]),
    (error: unknown) =>
      error instanceof GitHubProviderError &&
      error.code === "github_provider_not_found" &&
      !error.retryable
  );
});

test("installation tokens cannot escape through returned records or downstream errors", async () => {
  const client = clientFor(
    sequenceFetch(
      [],
      [
        response({
          expires_at: "2026-08-31T19:00:00.000Z",
          token: INSTALLATION_TOKEN,
        }),
        new Response(JSON.stringify({ message: INSTALLATION_TOKEN }), {
          status: 503,
        }),
      ]
    )
  );

  await assert.rejects(
    client.listInstallationRepositories(INSTALLATION_ID),
    (error: unknown) => {
      const serialized = `${String(error)}\n${JSON.stringify(error)}`;
      assert.doesNotMatch(serialized, new RegExp(INSTALLATION_TOKEN, "u"));
      return true;
    }
  );
});

type CapturedRequest = {
  body: string | null;
  headers: Headers;
  method: string;
  url: string;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function clientFor(
  fetchImpl: FetchLike,
  overrides: Partial<{
    maxPages: number;
    maxRepositories: number;
    maxResponseBytes: number;
    timeoutMs: number;
  }> = {}
) {
  return createGitHubAppClient({
    appId: APP_ID,
    appSlug: APP_SLUG,
    fetch: fetchImpl,
    maxPages: overrides.maxPages,
    maxRepositories: overrides.maxRepositories,
    maxResponseBytes: overrides.maxResponseBytes,
    now: () => NOW,
    privateKey: APP_SIGNER,
    timeoutMs: overrides.timeoutMs,
  });
}

function sequenceFetch(
  captured: CapturedRequest[],
  responses: Response[]
): FetchLike {
  return (input, init = {}) => {
    captured.push({
      body: typeof init.body === "string" ? init.body : null,
      headers: new Headers(init.headers),
      method: init.method ?? "GET",
      url: input,
    });
    const next = responses.shift();
    assert.ok(next, `Unexpected request to ${input}`);
    return Promise.resolve(next);
  };
}

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function installationBody(overrides: Record<string, unknown> = {}) {
  return {
    account: {
      id: "18446744073709551614",
      login: "OpenCoven",
      type: "Organization",
    },
    app_id: APP_ID,
    app_slug: APP_SLUG,
    id: INSTALLATION_ID,
    permissions: {
      issues: "write",
      metadata: "read",
      organization_projects: "write",
      pull_requests: "write",
    },
    repository_selection: "selected",
    suspended_at: null,
    target_id: "18446744073709551614",
    target_type: "Organization",
    ...overrides,
  };
}

function repositoryBody(overrides: Record<string, unknown> = {}) {
  const name =
    typeof overrides.name === "string" ? overrides.name : "coven-agents";
  return {
    full_name: `OpenCoven/${name}`,
    id: 24_680,
    name,
    node_id: "R_kgDOExample",
    owner: { login: "OpenCoven" },
    ...overrides,
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(segment, "base64url").toString("utf8")
  ) as Record<string, unknown>;
}
