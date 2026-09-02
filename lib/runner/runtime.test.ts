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

test("guarded hermetic composition builds a service without Daytona configuration", () => {
  const script = [
    'const runtime = await import("./lib/runner/runtime.ts");',
    "const instance = runtime.createProductionRunnerRuntime({",
    "databaseFor: () => ({ transaction: () => Promise.reject(new Error('not requested')) })",
    "});",
    `await instance.createSubscriberService(${JSON.stringify(subscriber)});`,
    "process.stdout.write(JSON.stringify({ hermetic: true }));",
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
        COVEN_HERMETIC_RUNNER: "1",
        DAYTONA_API_KEY: "",
        DAYTONA_SNAPSHOT: "",
        E2E_HERMETIC_RUNNER: "1",
        NODE_ENV: "development",
        POSTGRES_URL: "postgres://localhost:5432/not-used",
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { hermetic: true });
});

test("hermetic provider files retain no Daytona SDK boundary", () => {
  for (const path of [
    "./hermetic/composition.ts",
    "./hermetic/executor.ts",
    "./hermetic/reconcile.ts",
    "./hermetic/resource-lifecycle.ts",
    "./hermetic/sandbox.ts",
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /@daytona\/sdk/u);
  }
  const runtime = readFileSync(
    new URL("./runtime.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(runtime, /(?:@daytona\/sdk|["']\.\/daytona\/)/u);
  assert.match(runtime, /hermeticPersistentResourceLifecycle/u);
});

test("hermetic inventory is deterministic and has no Daytona configuration access", () => {
  const lifecycle = readFileSync(
    new URL("./hermetic/resource-lifecycle.ts", import.meta.url),
    "utf8"
  );

  assert.match(lifecycle, /NO_HOSTED_RESOURCE_INVENTORY/u);
  assert.match(lifecycle, /inventory:\s*\(\)\s*=>/u);
  assert.doesNotMatch(
    lifecycle,
    /(?:@daytona\/sdk|daytonaSandboxConfiguration|DAYTONA_|process\.env)/u
  );
});

test("core runtime has no diagnostic composition dependency", () => {
  const runtime = readFileSync(
    new URL("./runtime.ts", import.meta.url),
    "utf8"
  );

  assert.doesNotMatch(runtime, /diagnostic|OPERATOR_DIAGNOSTIC/u);
});

test("production reconciliation wires durable team projection and claim hooks", () => {
  const runtime = readFileSync(
    new URL("./runtime.ts", import.meta.url),
    "utf8"
  );

  assert.match(runtime, /import\(["']@\/lib\/teams\/orchestrate["']\)/u);
  assert.match(runtime, /import\(["']@\/lib\/teams\/store["']\)/u);
  assert.match(runtime, /createTeamOrchestrator/u);
  assert.match(runtime, /projectTeamRuns/u);
  assert.match(runtime, /claimTeamRuns/u);
  assert.match(runtime, /dispatchClaim/u);
});

test("production dispatch issues hash-only GitHub step capabilities from persisted broker policy", () => {
  const composition = readFileSync(
    new URL("./daytona/composition.ts", import.meta.url),
    "utf8"
  );
  assert.match(composition, /issueGitHubStepCapability/u);
  assert.match(composition, /createGitHubGatewayStore/u);
  assert.match(composition, /githubBrokerPolicy/u);
  assert.match(composition, /refreshGitHubConnectionAuthority/u);
  assert.match(composition, /authVersion: policy\.authVersion/u);
  assert.doesNotMatch(composition, /retainsProjectAuthorityProof/u);
  assert.match(composition, /revokeCapability/u);
  assert.match(composition, /api\/internal\/github-tool/u);
  assert.doesNotMatch(
    composition,
    /COPILOT_GITHUB_TOKEN.*github|github.*COPILOT_GITHUB_TOKEN/iu
  );
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
      terminalLeaseCleaned: 0,
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
    terminalLeaseCleaned: 0,
  });
  assert.equal(reconcileCalls, 1);

  releaseFirst?.();
  assert.equal((await first).execution, "executed");
  assert.equal(activeLease, null);
});
