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
    costUnits: 15,
    durationSeconds: null,
    expiresAt: new Date("2026-08-28T15:05:00.000Z"),
    periodDay: "2026-08-28",
    periodMonth: new Date("2026-08-01T00:00:00.000Z"),
    releasedAt: null,
    reservedAt: NOW,
    reservedUnits: 15,
    runId: "00000000-0000-4000-8000-000000000002",
    settledAt: null,
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
        settleReservation: async (runId, settlement) => {
          calls.push("settle-reservation");
          if (
            draft.reservation?.runId !== runId ||
            draft.reservation.state !== "consumed" ||
            draft.reservation.settledAt !== null
          ) {
            return null;
          }
          draft.reservation = { ...draft.reservation, ...settlement };
          return draft.reservation;
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

test("acquisitions retain an immutable scoped snapshot through replacement and deletion", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  const observedScopes: Array<readonly [string, string]> = [];
  let current: string | null = "credential-revision-one";
  service.readCredential = async (tenant, harnessId) => {
    observedScopes.push([tenant, harnessId]);
    return current;
  };

  const first = await acquireRunnerCredential(input(), service);
  assert.equal(first.kind, "acquired");
  if (first.kind !== "acquired") {
    throw new Error("First credential acquisition unexpectedly failed.");
  }

  current = "credential-revision-two";
  const second = await acquireRunnerCredential(
    {
      ...input(),
      operationId: "00000000-0000-4000-8000-000000000004",
      runId: "00000000-0000-4000-8000-000000000005",
    },
    service
  );
  assert.equal(second.kind, "acquired");
  if (second.kind !== "acquired") {
    throw new Error("Replacement credential acquisition unexpectedly failed.");
  }

  current = null;
  const deleted = await acquireRunnerCredential(
    {
      ...input(),
      operationId: "00000000-0000-4000-8000-000000000006",
      runId: "00000000-0000-4000-8000-000000000007",
    },
    service
  );
  assert.equal(deleted.kind, "unavailable");
  assert.equal(
    deleted.kind === "unavailable" && deleted.error.code,
    "no_credential"
  );
  assert.deepEqual(observedScopes, [
    ["tenant_a", "copilot"],
    ["tenant_a", "copilot"],
    ["tenant_a", "copilot"],
  ]);

  await first.acquisition.commit();
  await second.acquisition.commit();
  assert.equal(
    await first.acquisition.use((credential) => credential.credential),
    "credential-revision-one"
  );
  assert.equal(
    await second.acquisition.use((credential) => credential.credential),
    "credential-revision-two"
  );
  await assert.rejects(() => first.acquisition.use(() => Promise.resolve()));
  await assert.rejects(() => second.acquisition.use(() => Promise.resolve()));
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
    "no_credential"
  );
  assert.equal(result.kind === "unavailable" && result.error.retryable, false);
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
  // No timestamps means no measurable duration: the full reservation stands.
  assert.equal(cleanup.state().reservation?.costUnits, 15);
  assert.equal(cleanup.state().reservation?.settledAt, null);
  assert.equal(cleanup.state().usage, true);
});

test("terminal cleanup settles a launched run to the whole minutes it held", async () => {
  const cleanup = cleanupDatabase();
  const startedAt = new Date("2026-08-28T15:00:30.000Z");
  const completedAt = new Date("2026-08-28T15:04:31.000Z");

  const result = await cleanupRunnerCredentialResourcesAtomically(
    cleanup.database,
    {
      completedAt,
      mode: "terminal",
      runId: "00000000-0000-4000-8000-000000000002",
      startedAt,
    }
  );

  assert.deepEqual(result, { kind: "cleaned" });
  assert.deepEqual(cleanup.calls, [
    "lock-reservation",
    "delete-lease",
    "settle-reservation",
  ]);
  const settled = cleanup.state().reservation;
  assert.equal(settled?.state, "consumed");
  // Four minutes and one second rounds up to five minutes, never down.
  assert.equal(settled?.costUnits, 5);
  assert.equal(settled?.durationSeconds, 241);
  assert.equal(settled?.reservedUnits, 15);
  assert.deepEqual(settled?.settledAt, completedAt);
  assert.equal(cleanup.state().usage, true);
});

test("a replayed terminal cleanup never settles a reservation twice", async () => {
  const cleanup = cleanupDatabase();
  const cleanupInput = {
    completedAt: new Date("2026-08-28T15:02:00.000Z"),
    mode: "terminal" as const,
    runId: "00000000-0000-4000-8000-000000000002",
    startedAt: new Date("2026-08-28T15:00:00.000Z"),
  };

  await cleanupRunnerCredentialResourcesAtomically(
    cleanup.database,
    cleanupInput
  );
  const replay = await cleanupRunnerCredentialResourcesAtomically(
    cleanup.database,
    { ...cleanupInput, completedAt: new Date("2026-08-28T15:59:00.000Z") }
  );

  assert.deepEqual(replay, { kind: "cleaned" });
  assert.equal(cleanup.state().reservation?.costUnits, 2);
  assert.equal(cleanup.state().reservation?.durationSeconds, 120);
  assert.deepEqual(
    cleanup.state().reservation?.settledAt,
    cleanupInput.completedAt
  );
});

test("an unmeasurable run keeps its full reserved charge", async () => {
  const cleanup = cleanupDatabase();

  const result = await cleanupRunnerCredentialResourcesAtomically(
    cleanup.database,
    {
      completedAt: new Date("2026-08-28T14:00:00.000Z"),
      mode: "terminal",
      runId: "00000000-0000-4000-8000-000000000002",
      startedAt: new Date("2026-08-28T15:00:00.000Z"),
    }
  );

  assert.deepEqual(result, { kind: "cleaned" });
  assert.deepEqual(cleanup.calls, ["lock-reservation", "delete-lease"]);
  assert.equal(cleanup.state().reservation?.costUnits, 15);
  assert.equal(cleanup.state().reservation?.settledAt, null);
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

test("blank credential reads are non-retryable and clean pre-launch resources", async () => {
  const calls: string[] = [];
  const service = dependencies(calls);
  service.readCredential = async () => {
    calls.push("read");
    return " \n\t";
  };

  const result = await acquireRunnerCredential(input(), service);

  assert.equal(result.kind, "unavailable");
  assert.equal(
    result.kind === "unavailable" && result.error.code,
    "no_credential"
  );
  assert.equal(result.kind === "unavailable" && result.error.retryable, false);
  assert.deepEqual(calls, [
    "reserve",
    "issue",
    "lease",
    "prepare",
    "read",
    "cleanup:prelaunch",
  ]);
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
  const service = dependencies(calls);
  const inputs: unknown[] = [];
  service.cleanupResources = async (cleanupInput) => {
    calls.push(`cleanup:${cleanupInput.mode}`);
    inputs.push(cleanupInput);
    return { kind: "cleaned" as const };
  };
  const startedAt = new Date("2026-08-28T15:00:00.000Z");
  const completedAt = new Date("2026-08-28T15:03:00.000Z");
  await releaseRunnerCredentialResources(
    { completedAt, id: "00000000-0000-4000-8000-000000000002", startedAt },
    service
  );

  assert.deepEqual(calls, ["cleanup:terminal"]);
  // The run's own timestamps travel with terminal cleanup so the charge can
  // be settled inside the same transaction that retires the lease.
  assert.deepEqual(inputs, [
    {
      completedAt,
      mode: "terminal",
      runId: "00000000-0000-4000-8000-000000000002",
      startedAt,
    },
  ]);
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
