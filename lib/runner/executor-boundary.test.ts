import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const admissionPath = fileURLToPath(new URL("./admission.ts", import.meta.url));
const executorPath = fileURLToPath(new URL("./executor.ts", import.meta.url));
const attemptReconcilePath = fileURLToPath(
  new URL("./attempt-reconcile.ts", import.meta.url)
);
const deferredDaytonaRecoveryPath = fileURLToPath(
  new URL("./reconcile.ts", import.meta.url)
);
const daytonaExecutorPath = fileURLToPath(
  new URL("./daytona/executor.ts", import.meta.url)
);
const agentRoutePath = fileURLToPath(
  new URL("../../app/api/agents/route.ts", import.meta.url)
);

test("core admission cannot import Daytona process or sandbox modules", () => {
  const admission = readFileSync(admissionPath, "utf8");

  assert.doesNotMatch(
    admission,
    /from\s+["']\.\/daytona\/(?:process|sandbox)["']/u
  );
  assert.doesNotMatch(
    admission,
    /\b(?:DaytonaProcessSandbox|DaytonaStartedProcess|DaytonaProcessError|startDaytonaProcess|inspectRestrictedWorkspace|ensureDaytonaSandboxForDispatch)\b/u
  );
});

test("core attempt reconciliation cannot expose or import Daytona boundaries", () => {
  const attemptReconcile = readFileSync(attemptReconcilePath, "utf8");

  assert.doesNotMatch(attemptReconcile, /@daytona\/sdk/u);
  assert.doesNotMatch(
    attemptReconcile,
    /from\s+["']\.\/daytona\/(?:process|sandbox|client|names)["']/u
  );
  assert.doesNotMatch(
    attemptReconcile,
    /\b(?:DaytonaProcessSandbox|DaytonaLogSnapshot|snapshotDaytonaProcess|stopDaytonaProcess|classifyDaytonaProviderError)\b/u
  );
});

test("Daytona sandbox recovery remains explicitly deferred outside core attempts", () => {
  const reconcile = readFileSync(deferredDaytonaRecoveryPath, "utf8");

  assert.match(
    reconcile,
    /reconcileDaytonaSandboxes/u,
    "provider-specific warm/provision/decommission recovery remains deferred"
  );
});

test("only the Daytona adapter selects hosted provider provenance", () => {
  const executor = readFileSync(executorPath, "utf8");
  const admission = readFileSync(admissionPath, "utf8");
  const daytonaExecutor = readFileSync(daytonaExecutorPath, "utf8");
  const agentRoute = readFileSync(agentRoutePath, "utf8");

  assert.doesNotMatch(executor, /provider\s*:\s*["']daytona["']/u);
  assert.doesNotMatch(executor, /DAYTONA_|snapshotName|target/u);
  assert.doesNotMatch(admission, /provider\s*:\s*["']daytona["']/u);
  assert.doesNotMatch(agentRoute, /executionProvenance|DAYTONA_|provider/u);
  assert.match(
    daytonaExecutor,
    /pinnedSnapshot:\s*configuration\.snapshotName[\s\S]*provider:\s*"daytona"/u
  );
});
