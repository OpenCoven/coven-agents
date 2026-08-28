// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import type { RunReservationRecord } from "@/lib/billing/run-reservations";
import {
  acquireRunnerCredential,
  consumeRunnerCredentialReservation,
  type RunnerCredentialDependencies,
  releaseRunnerCredentialResources,
  rollbackRunnerCredentialResources,
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
    compensateReservation: async () => {
      calls.push("compensate");
      return { kind: "compensated", reservation: reservation() };
    },
    consumeReservation: async () => {
      calls.push("consume");
      return { kind: "consumed", reservation: reservation() };
    },
    discardReservation: async () => {
      calls.push("discard-reservation");
      return reservation();
    },
    issueLease: async () => {
      calls.push("issue");
      return { kind: "issued" as const };
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
  assert.deepEqual(calls, ["reserve", "issue", "lease", "prepare", "read"]);
  assert.equal(JSON.stringify(result.acquisition).includes(SECRET), false);
  await result.acquisition.commit();

  const started = await result.acquisition.use((credential) => {
    assert.equal(credential.credential, SECRET);
    return Promise.resolve("started");
  });
  assert.equal(started, "started");
  await assert.rejects(() => result.acquisition.use(() => Promise.resolve()));
  assert.deepEqual(calls, [
    "reserve",
    "issue",
    "lease",
    "prepare",
    "read",
    "consume",
  ]);
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
    "discard-reservation",
  ]);
  assert.equal(
    result.kind === "unavailable" && result.error.code,
    "credential_unavailable"
  );
});

test("uncertain pre-launch cleanup remains an explicit retryable failure", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  service.prepareCredential = async () => {
    calls.push("prepare");
    return false;
  };
  service.releaseLease = async () => {
    calls.push("release-lease");
    return false;
  };
  service.discardReservation = async () => {
    calls.push("discard-reservation");
    return null;
  };

  const result = await acquireRunnerCredential(input(), service);

  assert.equal(result.kind, "unavailable");
  assert.equal(
    result.kind === "unavailable" && result.error.code,
    "cleanup_pending"
  );
  assert.equal(result.kind === "unavailable" && result.error.retryable, true);
  assert.deepEqual(calls, [
    "reserve",
    "issue",
    "lease",
    "prepare",
    "release-lease",
    "discard-reservation",
  ]);
});

test("a transient post-lease credential read failure retires the exact lease and permits retry", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  let failRead = true;
  service.leaseCredential = async (_input, prepare, operation) => {
    calls.push("lease");
    await prepare();
    if (failRead) {
      failRead = false;
      throw new Error("transient credential store failure");
    }
    return await operation({} as never);
  };

  const first = await acquireRunnerCredential(input(), service);
  const second = await acquireRunnerCredential(input(), service);

  assert.equal(first.kind, "unavailable");
  assert.equal(second.kind, "acquired");
  assert.deepEqual(calls, [
    "reserve",
    "issue",
    "lease",
    "prepare",
    "release-lease",
    "discard-reservation",
    "reserve",
    "issue",
    "lease",
    "prepare",
    "read",
  ]);
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

  assert.deepEqual(calls, ["release-lease-for-run", "discard-reservation"]);
});

test("attached runner work consumes its existing reservation idempotently", async () => {
  const calls: string[] = [];
  await consumeRunnerCredentialReservation(
    { runId: "00000000-0000-4000-8000-000000000002", tenant: "tenant_a" },
    dependencies(calls)
  );

  assert.deepEqual(calls, ["consume"]);
});

test("a pre-launch consumed reservation is compensated exactly once", async () => {
  const calls: string[] = [];
  const result = await acquireRunnerCredential(input(), dependencies(calls));

  assert.equal(result.kind, "acquired");
  if (result.kind !== "acquired") {
    throw new Error("Credential acquisition unexpectedly failed.");
  }
  await result.acquisition.commit();
  await result.acquisition.compensate();
  await result.acquisition.compensate();

  assert.deepEqual(calls.slice(-2), ["release-lease", "compensate"]);
});

test("recovery rolls back an unstarted attached accounting transition", async () => {
  const calls: string[] = [];
  await rollbackRunnerCredentialResources(
    { runId: "00000000-0000-4000-8000-000000000002", tenant: "tenant_a" },
    dependencies(calls)
  );

  assert.deepEqual(calls, ["release-lease-for-run", "compensate"]);
});
