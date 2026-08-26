import assert from "node:assert/strict";
import test from "node:test";
import {
  type RunReservationRecord,
  tenantHashForReservation,
} from "@/lib/billing/run-reservations";
import {
  CapReachedError,
  fetchTenantCredential,
} from "@/worker/src/tenant-credentials";
import {
  authorizeInternalRequest,
  type CredentialLendingDependencies,
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

test("a token of the wrong length is refused without comparing content", () => {
  assert.equal(
    authorizeInternalRequest(
      request({ "x-service-token": "short" }),
      "service-secret"
    ),
    false
  );
});

function lendingInput(
  overrides: Partial<Parameters<typeof lendCredentialWithReservation>[0]> = {}
) {
  return {
    globalDailyCap: "500",
    harnessId: "claude",
    keySecret: "fixed-test-abuse-key-secret",
    now: NOW,
    periodStart: PERIOD_START,
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
    consume: () => {
      events.push("consume");
      return Promise.resolve({
        kind: "consumed",
        reservation: RESERVATION,
      });
    },
    readCredential: () => {
      events.push("read");
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

test("reservation precedes credential read and consumption follows it", async () => {
  const events: string[] = [];

  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { credential: "credential-secret" });
  assert.deepEqual(events, ["reserve", "read", "consume"]);
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
            { harnessId: "claude", runId: "run-1", tenant: "tenant_acme" },
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
        { harnessId: "claude", runId: "run-1", tenant: "tenant_acme" },
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
  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events, {
      readCredential: () => {
        events.push("read");
        return Promise.resolve(null);
      },
    })
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "no_credential" });
  assert.deepEqual(events, ["reserve", "read", "release"]);
});

test("a credential read failure releases the reservation and stays bounded", async () => {
  const events: string[] = [];
  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events, {
      readCredential: () => {
        events.push("read");
        return Promise.reject(new Error("sensitive decrypt detail"));
      },
    })
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "credential_unavailable",
  });
  assert.deepEqual(events, ["reserve", "read", "release"]);
});

test("a failed consumption releases any still-active reservation", async () => {
  const events: string[] = [];
  const response = await lendCredentialWithReservation(
    lendingInput(),
    lendingDependencies(events, {
      consume: () => {
        events.push("consume");
        return Promise.resolve({ kind: "missing" });
      },
    })
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "credential_unavailable",
  });
  assert.deepEqual(events, ["reserve", "read", "consume", "release"]);
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
