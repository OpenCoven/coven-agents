import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SubscriberSession } from "@/lib/session";
import type { RunnerReconciliationLease } from "./types";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const subscriber: SubscriberSession = {
  kind: "subscriber",
  tenant: "u_9c8589018a57479181fe4c455b099bc9",
  userId: "9c858901-8a57-4791-81fe-4c455b099bc9",
};

test("core runtime composes subscriber and operator services without diagnostics", async () => {
  const { createProductionRunnerRuntime } = await import("./runtime");
  const runtime = createProductionRunnerRuntime({
    databaseFor: () =>
      ({
        transaction: () =>
          Promise.reject(new Error("database work was not requested")),
      }) as never,
  });

  const [subscriberService, operatorService] = await Promise.all([
    runtime.createSubscriberService(subscriber),
    runtime.createOperatorService(),
  ]);

  assert.equal(typeof subscriberService.createAgent, "function");
  assert.equal(typeof subscriberService.dispatchClaim, "function");
  assert.equal(typeof operatorService.reconcileAndDispatch, "function");
  assert.throws(
    () => subscriberService.diagnoseSandbox(),
    /diagnostic is unavailable/i
  );
  assert.throws(
    () => operatorService.diagnoseSandbox(),
    /diagnostic is unavailable/i
  );
});

test("importing the core runtime constructs neither database nor Daytona clients", () => {
  const script = [
    'const runtime = await import("./lib/runner/runtime.ts");',
    "runtime.createProductionRunnerRuntime();",
    "process.stdout.write(JSON.stringify({ imported: true }));",
  ].join("");
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      script,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DAYTONA_API_KEY: "",
        DAYTONA_SNAPSHOT: "",
        POSTGRES_URL: "not a postgres url",
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { imported: true });
});

test("core runtime has no diagnostic composition dependency", () => {
  const runtime = readFileSync(
    new URL("./runtime.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(runtime, /diagnostic|OPERATOR_DIAGNOSTIC/u);
});

test("concurrent leased reconciliation skips before reconciliation work", async () => {
  const { runLeasedReconciliation } = await import("./runtime");
  let activeLease: RunnerReconciliationLease | null = null;
  let reconcileCalls = 0;
  let releaseFirst: (() => void) | undefined;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const store = {
    acquireReconciliationLease: (
      _operator: unknown,
      input: { ownerToken: string }
    ) => {
      if (activeLease) {
        return Promise.resolve({ kind: "held" as const });
      }
      activeLease = {
        expiresAt: new Date("2026-08-28T21:40:00.000Z"),
        fence: 1,
        ownerToken: input.ownerToken,
      };
      return Promise.resolve({
        kind: "acquired" as const,
        lease: activeLease,
      });
    },
    releaseReconciliationLease: (
      _operator: unknown,
      lease: RunnerReconciliationLease
    ) => {
      if (
        activeLease?.ownerToken !== lease.ownerToken ||
        activeLease.fence !== lease.fence
      ) {
        return Promise.resolve({ kind: "stale" as const });
      }
      activeLease = null;
      return Promise.resolve({ kind: "released" as const });
    },
  };
  const reconcile = async () => {
    reconcileCalls += 1;
    signalStarted?.();
    await finish;
    return {
      adopted: 0,
      deferred: 0,
      dispatched: 1,
      expiredScanned: 0,
      failures: 0,
      logEvents: 0,
      requeued: 0,
      sandboxRecovered: 0,
      terminalCleaned: 0,
      terminalized: 0,
    };
  };

  const first = runLeasedReconciliation({
    ownerToken: () => "owner-get",
    reconcile,
    store,
  });
  await started;
  const second = await runLeasedReconciliation({
    ownerToken: () => "owner-post",
    reconcile,
    store,
  });

  assert.deepEqual(second, {
    adopted: 0,
    deferred: 0,
    dispatched: 0,
    execution: "skipped",
    expiredScanned: 0,
    failures: 0,
    logEvents: 0,
    reason: "overlap",
    requeued: 0,
    sandboxRecovered: 0,
    terminalCleaned: 0,
    terminalized: 0,
  });
  assert.equal(reconcileCalls, 1);

  releaseFirst?.();
  assert.equal((await first).execution, "executed");
  assert.equal(activeLease, null);
});
