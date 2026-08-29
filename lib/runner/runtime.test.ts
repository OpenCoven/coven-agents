import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { SubscriberSession } from "@/lib/session";

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
