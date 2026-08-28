// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import type { RunReservationRecord } from "@/lib/billing/run-reservations";
import {
  acquireRunnerCredential,
  consumeRunnerCredentialReservation,
  type RunnerCredentialDependencies,
  releaseRunnerCredentialResources,
} from "./runner-credential";

const NOW = new Date("2026-08-28T15:00:00.000Z");
const SECRET = "credential-that-must-not-serialize";

function reservation(): RunReservationRecord {
  return {
    consumedAt: null,
    costUnits: 1,
    expiresAt: new Date("2026-08-28T15:05:00.000Z"),
    periodDay: "2026-08-28",
    periodMonth: new Date("2026-08-01T00:00:00.000Z"),
    releasedAt: null,
    reservedAt: NOW,
    runId: "00000000-0000-4000-8000-000000000002",
    state: "reserved",
    tenantHash: "a".repeat(64),
  };
}

function dependencies(calls: string[]): RunnerCredentialDependencies {
  return {
    consumeReservation: async () => {
      calls.push("consume");
      return { kind: "consumed", reservation: reservation() };
    },
    issueLease: async () => {
      calls.push("issue");
    },
    leaseCredential: async (_input, prepare, operation) => {
      calls.push("lease");
      await prepare();
      return await operation({} as never);
    },
    prepareCredential: async () => {
      calls.push("prepare");
      return true;
    },
    readCredential: async () => {
      calls.push("read");
      return SECRET;
    },
    releaseLease: async () => {
      calls.push("release-lease");
      return true;
    },
    releaseLeaseForRun: async () => {
      calls.push("release-lease-for-run");
      return true;
    },
    releaseReservation: async () => {
      calls.push("release-reservation");
      return reservation();
    },
    reserveRun: async () => {
      calls.push("reserve");
      return { kind: "reserved", reservation: reservation() };
    },
  };
}

function input() {
  return {
    globalDailyCap: 500,
    harnessId: "copilot",
    keySecret: "test-abuse-secret",
    now: NOW,
    operationId: "00000000-0000-4000-8000-000000000003",
    periodStart: new Date("2026-08-01T00:00:00.000Z"),
    runId: "00000000-0000-4000-8000-000000000002",
    tenant: "tenant_a",
  };
}

test("runner credential is one-use and never serializes its plaintext", async () => {
  const calls: string[] = [];
  const result = await acquireRunnerCredential(input(), dependencies(calls));

  assert.equal(result.kind, "acquired");
  if (result.kind !== "acquired") {
    throw new Error("Credential acquisition unexpectedly failed.");
  }
  assert.deepEqual(calls, ["reserve", "issue", "lease", "prepare", "read"]);
  assert.equal(JSON.stringify(result.acquisition).includes(SECRET), false);

  const started = await result.acquisition.use((credential) => {
    assert.equal(credential.credential, SECRET);
    return Promise.resolve("started");
  });
  assert.equal(started, "started");
  await assert.rejects(() => result.acquisition.use(() => Promise.resolve()));
  await result.acquisition.abort();
  assert.deepEqual(calls.slice(-2), ["release-lease", "release-reservation"]);
});

test("credential acquisition releases reservation and lease when preparation fails", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  service.prepareCredential = async () => {
    calls.push("prepare");
    return false;
  };

  const result = await acquireRunnerCredential(input(), service);

  assert.equal(result.kind, "unavailable");
  assert.deepEqual(calls, [
    "reserve",
    "issue",
    "lease",
    "prepare",
    "release-lease",
    "release-reservation",
  ]);
  assert.equal(
    result.kind === "unavailable" && result.error.code,
    "credential_unavailable"
  );
});

test("capacity refusal never issues or decrypts a credential", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  service.reserveRun = async () => {
    calls.push("reserve");
    return { kind: "refused", reason: "global_daily_cap" };
  };

  const result = await acquireRunnerCredential(input(), service);

  assert.deepEqual(result, {
    cap: undefined,
    kind: "refused",
    reason: "global_daily_cap",
    used: undefined,
  });
  assert.deepEqual(calls, ["reserve"]);
});

test("an existing reserved run never steals or releases another acquisition", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  service.reserveRun = async () => {
    calls.push("reserve");
    return { kind: "existing", reservation: reservation() };
  };

  const result = await acquireRunnerCredential(input(), service);

  assert.deepEqual(result, { kind: "reservation_pending" });
  assert.deepEqual(calls, ["reserve"]);
});

test("terminal cleanup releases only durable credential resources for its run", async () => {
  const calls: string[] = [];
  await releaseRunnerCredentialResources(
    "00000000-0000-4000-8000-000000000002",
    dependencies(calls)
  );

  assert.deepEqual(calls, ["release-lease-for-run", "release-reservation"]);
});

test("attached runner work consumes its existing reservation idempotently", async () => {
  const calls: string[] = [];
  await consumeRunnerCredentialReservation(
    { runId: "00000000-0000-4000-8000-000000000002", tenant: "tenant_a" },
    dependencies(calls)
  );

  assert.deepEqual(calls, ["consume"]);
});
