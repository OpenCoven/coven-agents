import assert from "node:assert/strict";
import test from "node:test";
import { runEphemeralDiagnostic } from "./production";
import { RunnerServiceError } from "./service";

test("ephemeral diagnostics delete the sandbox after a bounded probe", async () => {
  const calls: string[] = [];

  const result = await runEphemeralDiagnostic({
    create: () => {
      calls.push("create");
      return Promise.resolve({
        delete: () => {
          calls.push("delete");
          return Promise.resolve();
        },
        execute: () => {
          calls.push("execute");
          return Promise.resolve({ exitCode: 0, result: "coven-agents" });
        },
      });
    },
  });

  assert.deepEqual(result, {
    exitCode: 0,
    ok: true,
    output: "coven-agents",
  });
  assert.deepEqual(calls, ["create", "execute", "delete"]);
});

test("ephemeral diagnostics clean up after probe failure and hide provider output", async () => {
  const calls: string[] = [];

  await assert.rejects(
    runEphemeralDiagnostic({
      create: () => {
        calls.push("create");
        return Promise.resolve({
          delete: () => {
            calls.push("delete");
            return Promise.resolve();
          },
          execute: () => {
            calls.push("execute");
            return Promise.reject(new Error("provider=private-detail"));
          },
        });
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunnerServiceError);
      assert.equal(error.code, "diagnostic_unavailable");
      assert.equal(error.message.includes("private-detail"), false);
      return true;
    }
  );

  assert.deepEqual(calls, ["create", "execute", "delete"]);
});

test("ephemeral diagnostics bound malformed provider exit codes and output", async () => {
  const result = await runEphemeralDiagnostic({
    create: () =>
      Promise.resolve({
        delete: () => Promise.resolve(),
        execute: () =>
          Promise.resolve({
            exitCode: Number.POSITIVE_INFINITY,
            result: "provider-private-output",
          }),
      }),
  });

  assert.deepEqual(result, { exitCode: 1, ok: false, output: "" });
});
