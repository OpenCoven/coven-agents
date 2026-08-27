import assert from "node:assert/strict";
import test from "node:test";
import {
  type RunReservationRecord,
  tenantHashForReservation,
} from "@/lib/billing/run-reservations";
import { CredentialLeaseDeniedError } from "@/lib/credentials/leases";
import {
  CapReachedError,
  fetchTenantCredential,
} from "@/worker/src/tenant-credentials";
import {
  authorizeInternalRequest,
  type CredentialLendingDependencies,
  credentialRunScopeMatches,
  legacyCredentialLendingEnabled,
  lendCredentialWithLease,
  lendCredentialWithReservation,
} from "./route";

const NOW = new Date("2026-08-25T18:00:00.000Z");
const PERIOD_START = new Date("2026-08-20T12:00:00.000Z");
const RESETS_AT = new Date("2026-09-20T12:00:00.000Z");

const RESERVATION: RunReservationRecord = {
  consumedAt: null,
  costUnits: 1,
  expiresAt: new Date(NOW.getTime() + 300_000),
  periodDay: "2026-08-25",
  periodMonth: PERIOD_START,
  releasedAt: null,
  reservedAt: NOW,
  runId: "run-1",
  state: "reserved",
  tenantHash: tenantHashForReservation(
    "tenant_acme",
    "fixed-test-abuse-key-secret"
  ),
};

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://app.test/api/internal/credential", {
    headers,
    method: "POST",
  });
}

test("a request without the service token is refused", () => {
  assert.equal(authorizeInternalRequest(request(), "service-secret"), false);
});

test("a browser session cannot substitute for the service token", () => {
  // The whole point: a credential must not be reachable from a browser, so a
  // valid user session must not be sufficient here.
  assert.equal(
    authorizeInternalRequest(
      request({ cookie: "authjs.session-token=a-valid-looking-session" }),
      "service-secret"
    ),
    false
  );
});

test("the matching service token is accepted", () => {
  assert.equal(
    authorizeInternalRequest(
      request({ "x-service-token": "service-secret" }),
      "service-secret"
    ),
    true
  );
});

test("an unconfigured service token never authorizes", () => {
  // A deployment that forgot to set the secret must refuse everything rather
  // than accept everything, including a request that also sends nothing.
  assert.equal(
    authorizeInternalRequest(request({ "x-service-token": "" }), ""),
    false
  );
  assert.equal(authorizeInternalRequest(request(), ""), false);
});

test("credential scope binds the signed agent, harness, and operation", () => {
  const scope = {
    agentId: "11111111-1111-4111-8111-111111111111",
    harnessId: "copilot",
    operationId: "22222222-2222-4222-8222-222222222222",
  };
  const scopedRequest = {
    ...scope,
    requestId: "request-1",
    runId: scope.operationId,
  };

  assert.equal(credentialRunScopeMatches(scope, scopedRequest), true);
  assert.equal(
    credentialRunScopeMatches(scope, {
      ...scopedRequest,
      harnessId: "claude",
    }),
    false
  );
  assert.equal(
    credentialRunScopeMatches(scope, {
      ...scopedRequest,
      operationId: "33333333-3333-4333-8333-333333333333",
    }),
    false
  );
  assert.equal(
    credentialRunScopeMatches(scope, {
      ...scopedRequest,
      requestId: undefined,
    }),
    false
  );
  assert.equal(
    credentialRunScopeMatches(scope, {
      ...scopedRequest,
      runId: "33333333-3333-4333-8333-333333333333",
    }),
    false
  );
});

test("legacy lending is fail-closed unless explicitly enabled", () => {
  assert.equal(legacyCredentialLendingEnabled(undefined), false);
  assert.equal(legacyCredentialLendingEnabled("false"), false);
  assert.equal(legacyCredentialLendingEnabled("true"), true);
});

test("a token of the wrong length is refused without comparing content", () => {
  assert.equal(
    authorizeInternalRequest(
      request({ "x-service-token": "short" }),
      "service-secret"
    ),
    false
  );
});

test("an oversized credential body is rejected before any credential work", async () => {
  const previous = process.env.RUNNER_SERVICE_TOKEN;
  process.env.RUNNER_SERVICE_TOKEN = "service-secret";
  try {
    const response = await (await import("./route")).POST(
      new Request("https://app.test/api/internal/credential", {
        body: "x".repeat(8193),
        headers: {
          "content-length": "8193",
          "x-service-token": "service-secret",
        },
        method: "POST",
      })
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "request_too_large" });
  } finally {
    if (previous === undefined) {
      delete process.env.RUNNER_SERVICE_TOKEN;
    } else {
      process.env.RUNNER_SERVICE_TOKEN = previous;
    }
  }
});

test("an oversized identity token is rejected before database or reservation work", async () => {
  const previous = process.env.RUNNER_SERVICE_TOKEN;
  process.env.RUNNER_SERVICE_TOKEN = "service-secret";
  try {
    const response = await (await import("./route")).POST(
      new Request("https://app.test/api/internal/credential", {
        body: JSON.stringify({
          harnessId: "copilot",
          requestId: "request-1",
          runId: "run-1",
          tenant: "tenant_acme",
        }),
        headers: {
          authorization: `Bearer ${"x".repeat(8193)}`,
          "content-type": "application/json",
          "x-service-token": "service-secret",
        },
        method: "POST",
      })
    );
    assert.equal(response.status, 401);
  } finally {
    if (previous === undefined) {
      delete process.env.RUNNER_SERVICE_TOKEN;
    } else {
      process.env.RUNNER_SERVICE_TOKEN = previous;
    }
  }
});

function lendingInput(
  overrides: Partial<Parameters<typeof lendCredentialWithReservation>[0]> = {}
) {
  return {
    globalDailyCap: "500",
    harnessId: "claude",
    keySecret: "fixed-test-abuse-key-secret",
    now: NOW,
    operationId: "22222222-2222-4222-8222-222222222222",
    periodStart: PERIOD_START,
    requestId: "request-1",
    resetsAt: RESETS_AT,
    runId: "run-1",
    tenant: "tenant_acme",
    ...overrides,
  };
}

function lendingDependencies(
  events: string[],
  overrides: Partial<CredentialLendingDependencies> = {}
): CredentialLendingDependencies {
  return {
    consumeLegacy: () => {
      events.push("consume-legacy");
      return Promise.resolve({
        kind: "consumed",
        reservation: { ...RESERVATION, consumedAt: NOW, state: "consumed" },
      });
    },
    issue: () => {
      events.push("issue");
      return Promise.resolve();
    },
    lease: async (_input, prepare, operation) => {
      events.push("lease");
      await prepare();
      return await operation({} as never);
    },
    prepareCredential: () => {
      events.push("prepare");
      return Promise.resolve(true);
    },
    readCredential: () => {
      events.push("read");
      return Promise.resolve("credential-secret");
    },
    readCredentialLegacy: () => {
      events.push("read-legacy");
      return Promise.resolve("credential-secret");
    },
    release: () => {
      events.push("release");
      return Promise.resolve({
        ...RESERVATION,
        releasedAt: NOW,
        state: "released",
      });
    },
    reserve: () => {
      events.push("reserve");
      return Promise.resolve({
        kind: "reserved",
        reservation: RESERVATION,
      });
    },
    ...overrides,
  };
}

test("the one-use lease is consumed before credential read", async () => {
  const events: string[] = [];
  const dependencies = lendingDependencies(events);

  const issued = await lendCredentialWithReservation(
    lendingInput(),
    dependencies
  );
  const response = await lendCredentialWithLease(lendingInput(), dependencies);

  assert.equal(issued.status, 201);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { credential: "credential-secret" });
  assert.deepEqual(events, ["reserve", "issue", "lease", "prepare", "read"]);
});

test("the worker contract completes issuance before credential consumption", async () => {
  const events: string[] = [];
  const dependencies = lendingDependencies(events);

  const credential = await fetchTenantCredential(
    {
      agentId: "11111111-1111-4111-8111-111111111111",
      harnessId: "claude",
      operationId: "22222222-2222-4222-8222-222222222222",
      requestId: "request-1",
      runId: "run-1",
      tenant: "tenant_acme",
    },
    {
      endpoint: "https://app.test",
      fetchImpl: (url) =>
        new URL(url).searchParams.get("phase") === "issue"
          ? lendCredentialWithReservation(lendingInput(), dependencies)
          : lendCredentialWithLease(lendingInput(), dependencies),
      identityToken: "identity",
      serviceToken: "service",
    }
  );

  assert.equal(credential, "credential-secret");
  assert.deepEqual(events, ["reserve", "issue", "lease", "prepare", "read"]);
});

test("missing global capacity configuration fails before credential read", async () => {
  const events: string[] = [];

  const response = await lendCredentialWithReservation(
    lendingInput({ globalDailyCap: undefined }),
    lendingDependencies(events)
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "capacity_unavailable" });
  assert.deepEqual(events, []);
});

test("missing HMAC configuration fails before credential read", async () => {
  const events: string[] = [];

  const response = await lendCredentialWithReservation(
    lendingInput({ keySecret: undefined }),
    lendingDependencies(events)
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "capacity_unavailable" });
  assert.deepEqual(events, []);
});

test("tenant cap refusals are stable and do not read a credential", async () => {
  await Promise.all(
    (["tenant_daily_cap", "tenant_monthly_cap"] as const).map(
      async (reason) => {
        const events: string[] = [];
        const cap = reason === "tenant_daily_cap" ? 50 : 750;
        const response = await lendCredentialWithReservation(
          lendingInput(),
          lendingDependencies(events, {
            reserve: () => {
              events.push("reserve");
              return Promise.resolve({
                cap,
                kind: "refused",
                reason,
                used: cap,
              });
            },
          })
        );

        assert.equal(response.status, 429);
        assert.deepEqual(await response.json(), {
          cap,
          error: "cap_reached",
          reason,
          resetsAt:
            reason === "tenant_daily_cap"
              ? "2026-08-26T00:00:00.000Z"
              : RESETS_AT.toISOString(),
          used: cap,
        });
        assert.deepEqual(events, ["reserve"]);
      }
    )
  );
});

test("a run id already counted in usage is rejected before credential work", async () => {
  const events: string[] = [];
  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events, {
      reserve: () => {
        events.push("reserve");
        return Promise.resolve({
          kind: "conflict",
          reason: "run_already_counted",
        });
      },
    })
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "reservation_unavailable",
  });
  assert.deepEqual(events, ["reserve"]);
});

test("tenant cap payloads round-trip through the worker contract", async () => {
  const cases = [
    {
      cap: 50,
      reason: "tenant_daily_cap",
      resetsAt: "2026-08-26T00:00:00.000Z",
      used: 50,
    },
    {
      cap: 750,
      reason: "tenant_monthly_cap",
      resetsAt: RESETS_AT.toISOString(),
      used: 750,
    },
  ] as const;

  await Promise.all(
    cases.map(async (expected) => {
      const events: string[] = [];
      const input = {
        ...lendingInput(),
        now: NOW,
      };

      await assert.rejects(
        () =>
          fetchTenantCredential(
            {
              agentId: "11111111-1111-4111-8111-111111111111",
              harnessId: "claude",
              operationId: "22222222-2222-4222-8222-222222222222",
              requestId: "request-1",
              runId: "run-1",
              tenant: "tenant_acme",
            },
            {
              endpoint: "https://app.test",
              fetchImpl: () =>
                lendCredentialWithReservation(
                  input,
                  lendingDependencies(events, {
                    reserve: () => {
                      events.push("reserve");
                      return Promise.resolve({
                        cap: expected.cap,
                        kind: "refused",
                        reason: expected.reason,
                        used: expected.used,
                      } as never);
                    },
                  })
                ),
              identityToken: "identity",
              serviceToken: "service",
            }
          ),
        (error: unknown) =>
          error instanceof CapReachedError &&
          error.cap === expected.cap &&
          error.used === expected.used &&
          error.resetsAt === expected.resetsAt
      );
      assert.deepEqual(events, ["reserve"]);
    })
  );
});

test("global refusal exposes no global capacity number", async () => {
  const events: string[] = [];
  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events, {
      reserve: () => {
        events.push("reserve");
        return Promise.resolve({
          kind: "refused",
          reason: "global_daily_cap",
        });
      },
    })
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body, { error: "capacity_unavailable" });
  assert.doesNotMatch(JSON.stringify(body), /500|globalDailyCap|capacity":/);
  assert.deepEqual(events, ["reserve"]);
});

test("global admission closure stays generic through the worker contract", async () => {
  const events: string[] = [];
  const fetchImpl = () =>
    lendCredentialWithReservation(
      { ...lendingInput(), now: NOW },
      lendingDependencies(events, {
        reserve: () => {
          events.push("reserve");
          return Promise.resolve({
            kind: "refused",
            reason: "global_daily_cap",
          });
        },
      })
    );

  const response = await fetchImpl();
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.deepEqual(body, { error: "capacity_unavailable" });
  assert.doesNotMatch(
    JSON.stringify(body),
    /"(?:cap|reason|used)"|global|500/i
  );

  await assert.rejects(
    () =>
      fetchTenantCredential(
        {
          agentId: "11111111-1111-4111-8111-111111111111",
          harnessId: "claude",
          operationId: "22222222-2222-4222-8222-222222222222",
          requestId: "request-1",
          runId: "run-1",
          tenant: "tenant_acme",
        },
        {
          endpoint: "https://app.test",
          fetchImpl,
          identityToken: "identity",
          serviceToken: "service",
        }
      ),
    (error: unknown) => !(error instanceof CapReachedError)
  );
  assert.deepEqual(events, ["reserve", "reserve"]);
});

test("a missing credential releases the reservation", async () => {
  const events: string[] = [];
  const dependencies = lendingDependencies(events, {
    readCredential: () => {
      events.push("read");
      return Promise.resolve(null);
    },
  });
  await lendCredentialWithReservation(lendingInput(), dependencies);
  const response = await lendCredentialWithLease(lendingInput(), dependencies);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no_credential" });
  assert.deepEqual(events, [
    "reserve",
    "issue",
    "lease",
    "prepare",
    "read",
    "release",
  ]);
});

test("a revoked credential is removed before the final lending transaction", async () => {
  const events: string[] = [];
  const dependencies = lendingDependencies(events, {
    prepareCredential: () => {
      events.push("prepare");
      return Promise.resolve(false);
    },
  });
  await lendCredentialWithReservation(lendingInput(), dependencies);
  const response = await lendCredentialWithLease(lendingInput(), dependencies);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no_credential" });
  assert.deepEqual(events, ["reserve", "issue", "lease", "prepare", "release"]);
});

test("a credential read failure releases the reservation and stays bounded", async () => {
  const events: string[] = [];
  const dependencies = lendingDependencies(events, {
    readCredential: () => {
      events.push("read");
      return Promise.reject(new Error("sensitive decrypt detail"));
    },
  });
  await lendCredentialWithReservation(lendingInput(), dependencies);
  const response = await lendCredentialWithLease(lendingInput(), dependencies);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "credential_unavailable",
  });
  assert.deepEqual(events, [
    "reserve",
    "issue",
    "lease",
    "prepare",
    "read",
    "release",
  ]);
});

test("a failed atomic lease transaction releases any still-active reservation", async () => {
  const events: string[] = [];
  const dependencies = lendingDependencies(events, {
    lease: async (_input, prepare, operation) => {
      events.push("lease");
      await prepare();
      await operation({} as never);
      throw new Error("lease transaction failed");
    },
  });
  await lendCredentialWithReservation(lendingInput(), dependencies);
  const response = await lendCredentialWithLease(lendingInput(), dependencies);

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "credential_unavailable",
  });
  assert.deepEqual(events, [
    "reserve",
    "issue",
    "lease",
    "prepare",
    "read",
    "release",
  ]);
});

test("a previously released duplicate never reads a credential", async () => {
  const events: string[] = [];
  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events, {
      reserve: () => {
        events.push("reserve");
        return Promise.resolve({
          kind: "existing",
          reservation: {
            ...RESERVATION,
            releasedAt: NOW,
            state: "released",
          },
        });
      },
    })
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "reservation_unavailable",
  });
  assert.deepEqual(events, ["reserve"]);
});

test("a previously consumed duplicate cannot issue another lease", async () => {
  const events: string[] = [];
  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events, {
      reserve: () => {
        events.push("reserve");
        return Promise.resolve({
          kind: "existing",
          reservation: {
            ...RESERVATION,
            consumedAt: NOW,
            state: "consumed",
          },
        });
      },
    })
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "reservation_unavailable",
  });
  assert.deepEqual(events, ["reserve"]);
});

test("a losing concurrent issuance cannot release the winning reservation", async () => {
  const events: string[] = [];
  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events, {
      issue: () => {
        events.push("issue");
        return Promise.reject(
          new CredentialLeaseDeniedError("run_already_leased")
        );
      },
    })
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "credential_lease_unavailable",
  });
  assert.deepEqual(events, ["reserve", "issue"]);
});

test("a replayed credential lease is denied before credential decryption", async () => {
  const events: string[] = [];
  const dependencies = lendingDependencies(events, {
    lease: () => {
      events.push("lease");
      return Promise.reject(new CredentialLeaseDeniedError("replayed"));
    },
  });
  await lendCredentialWithReservation(lendingInput(), dependencies);
  const response = await lendCredentialWithLease(lendingInput(), dependencies);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "credential_lease_unavailable",
  });
  assert.deepEqual(events, ["reserve", "issue", "lease"]);
});
