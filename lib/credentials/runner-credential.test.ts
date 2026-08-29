// biome-ignore-all lint/suspicious/useAwait: Dependency doubles keep async signatures for readability.
import assert from "node:assert/strict";
import test from "node:test";
import type { RunReservationRecord } from "@/lib/billing/run-reservations";
import type { CredentialLease } from "@/lib/db/schema";
import {
  acquireRunnerCredential,
  cleanupRunnerCredentialResourcesAtomically,
  consumeRunnerCredentialReservation,
  type RunnerCredentialCleanupDatabase,
  type RunnerCredentialCleanupTransaction,
  type RunnerCredentialDependencies,
  releaseRunnerCredentialResources,
  rollbackRunnerCredentialResources,
} from "./runner-credential";

const NOW = new Date("2026-08-28T15:00:00.000Z");
const SECRET = "credential-that-must-not-serialize";

function reservation(
  overrides: Partial<RunReservationRecord> = {}
): RunReservationRecord {
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
    ...overrides,
  };
}

function dependencies(calls: string[]): RunnerCredentialDependencies {
  return {
    cleanupResources: async (cleanupInput) => {
      calls.push(`cleanup:${cleanupInput.mode}`);
      return { kind: "cleaned" as const };
    },
    consumeReservation: async () => {
      calls.push("consume");
      return { kind: "consumed", reservation: reservation() };
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
    reserveRun: async () => {
      calls.push("reserve");
      return { kind: "reserved", reservation: reservation() };
    },
  };
}

function cleanupDatabase(
  options: { failReservationDelete?: boolean; pauseAfterLock?: boolean } = {}
) {
  const calls: string[] = [];
  let reservationLocked = false;
  let notifyReservationLocked: () => void = () => undefined;
  const reservationLockReached = new Promise<void>((resolve) => {
    notifyReservationLocked = resolve;
  });
  let resumeAfterLock: () => void = () => undefined;
  const lockPause = new Promise<void>((resolve) => {
    resumeAfterLock = resolve;
  });
  let state: {
    lease: CredentialLease | null;
    reservation: RunReservationRecord | null;
    usage: boolean;
  } = {
    lease: {
      consumedAt: NOW,
      expiresAt: new Date("2026-08-28T15:02:00.000Z"),
      harnessId: "copilot",
      issuedAt: NOW,
      operationIdHash: "o".repeat(64),
      requestIdHash: "r".repeat(64),
      runId: "00000000-0000-4000-8000-000000000002",
      tenantHash: "a".repeat(64),
    },
    reservation: reservation({ consumedAt: NOW, state: "consumed" }),
    usage: true,
  };
  const database: RunnerCredentialCleanupDatabase = {
    transaction: async <T>(
      callback: (transaction: RunnerCredentialCleanupTransaction) => Promise<T>
    ): Promise<T> => {
      const draft = {
        lease: state.lease ? { ...state.lease } : null,
        reservation: state.reservation ? { ...state.reservation } : null,
        usage: state.usage,
      };
      const result = await callback({
        deleteLeaseForRun: async (runId) => {
          calls.push("delete-lease");
          if (draft.lease?.runId !== runId) {
            return null;
          }
          const deleted = draft.lease;
          draft.lease = null;
          return deleted;
        },
        deleteReservation: async (runId) => {
          calls.push("delete-reservation");
          if (
            options.failReservationDelete ||
            draft.reservation?.runId !== runId
          ) {
            return null;
          }
          const deleted = draft.reservation;
          draft.reservation = null;
          return deleted;
        },
        deleteUsageForRun: async (runId, tenant) => {
          calls.push("delete-usage");
          assert.equal(runId, "00000000-0000-4000-8000-000000000002");
          assert.equal(tenant, "tenant_a");
          draft.usage = false;
        },
        lockReservation: async (runId) => {
          calls.push("lock-reservation");
          reservationLocked = true;
          notifyReservationLocked();
          if (options.pauseAfterLock) {
            await lockPause;
          }
          return draft.reservation?.runId === runId ? draft.reservation : null;
        },
      });
      state = draft;
      return result;
    },
  };
  return {
    calls,
    canConcurrentConsumerProceed: () => !reservationLocked,
    database,
    resumeAfterLock,
    state: () => state,
    waitForReservationLock: () => reservationLockReached,
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
    "cleanup:prelaunch",
  ]);
  assert.equal(
    result.kind === "unavailable" && result.error.code,
    "credential_unavailable"
  );
});

test("pre-launch compensation locks before lease revocation and discards atomically", async () => {
  const cleanup = cleanupDatabase();

  const result = await cleanupRunnerCredentialResourcesAtomically(
    cleanup.database,
    {
      mode: "prelaunch",
      runId: "00000000-0000-4000-8000-000000000002",
      tenant: "tenant_a",
    }
  );

  assert.deepEqual(result, { kind: "cleaned" });
  assert.deepEqual(cleanup.calls, [
    "lock-reservation",
    "delete-lease",
    "delete-usage",
    "delete-reservation",
  ]);
  assert.deepEqual(cleanup.state(), {
    lease: null,
    reservation: null,
    usage: false,
  });
});

test("a concurrent consumer is blocked while atomic cleanup owns the reservation", async () => {
  const cleanup = cleanupDatabase({ pauseAfterLock: true });
  const pending = cleanupRunnerCredentialResourcesAtomically(cleanup.database, {
    mode: "prelaunch",
    runId: "00000000-0000-4000-8000-000000000002",
    tenant: "tenant_a",
  });

  await cleanup.waitForReservationLock();
  assert.equal(cleanup.canConcurrentConsumerProceed(), false);
  cleanup.resumeAfterLock();

  assert.deepEqual(await pending, { kind: "cleaned" });
});

test("atomic compensation leaves resources intact when reservation discard fails", async () => {
  const cleanup = cleanupDatabase({ failReservationDelete: true });

  const result = await cleanupRunnerCredentialResourcesAtomically(
    cleanup.database,
    {
      mode: "prelaunch",
      runId: "00000000-0000-4000-8000-000000000002",
      tenant: "tenant_a",
    }
  );

  assert.deepEqual(result, { kind: "cleanup_pending", retryable: true });
  assert.deepEqual(cleanup.calls, [
    "lock-reservation",
    "delete-lease",
    "delete-usage",
    "delete-reservation",
  ]);
  assert.notEqual(cleanup.state().lease, null);
  assert.notEqual(cleanup.state().reservation, null);
  assert.equal(cleanup.state().usage, true);
});

test("terminal credential cleanup preserves a consumed charge", async () => {
  const cleanup = cleanupDatabase();

  const result = await cleanupRunnerCredentialResourcesAtomically(
    cleanup.database,
    {
      mode: "terminal",
      runId: "00000000-0000-4000-8000-000000000002",
    }
  );

  assert.deepEqual(result, { kind: "cleaned" });
  assert.deepEqual(cleanup.calls, ["lock-reservation", "delete-lease"]);
  assert.equal(cleanup.state().lease, null);
  assert.notEqual(cleanup.state().reservation, null);
  assert.equal(cleanup.state().usage, true);
});

test("uncertain pre-launch cleanup remains an explicit retryable failure", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  service.prepareCredential = async () => {
    calls.push("prepare");
    return false;
  };
  service.cleanupResources = async (cleanupInput) => {
    calls.push(`cleanup:${cleanupInput.mode}`);
    return { kind: "cleanup_pending", retryable: true };
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
    "cleanup:prelaunch",
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
    "cleanup:prelaunch",
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

test("tenant cap refusals preserve bounded accounting metadata", async () => {
  await Promise.all(
    (["tenant_daily_cap", "tenant_monthly_cap"] as const).map(
      async (reason) => {
        const calls: string[] = [];
        const service = dependencies(calls);
        service.reserveRun = async () => {
          calls.push("reserve");
          return { cap: 25, kind: "refused", reason, used: 25 };
        };

        assert.deepEqual(await acquireRunnerCredential(input(), service), {
          cap: 25,
          kind: "refused",
          reason,
          used: 25,
        });
        assert.deepEqual(calls, ["reserve"]);
      }
    )
  );
});

test("credential issue failures release pre-launch resources without reading plaintext", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  service.issueLease = async () => {
    calls.push("issue");
    throw new Error("private credential transport detail");
  };

  const result = await acquireRunnerCredential(input(), service);

  assert.equal(result.kind, "unavailable");
  assert.equal(
    result.kind === "unavailable" && result.error.code,
    "credential_unavailable"
  );
  assert.equal(JSON.stringify(result).includes("private credential"), false);
  assert.deepEqual(calls, ["reserve", "issue", "cleanup:prelaunch"]);
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

  assert.deepEqual(calls, ["cleanup:terminal"]);
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

  assert.deepEqual(calls.slice(-1), ["cleanup:prelaunch"]);
});

test("recovery rolls back an unstarted attached accounting transition", async () => {
  const calls: string[] = [];
  await rollbackRunnerCredentialResources(
    { runId: "00000000-0000-4000-8000-000000000002", tenant: "tenant_a" },
    dependencies(calls)
  );

  assert.deepEqual(calls, ["cleanup:prelaunch"]);
});
