import assert from "node:assert/strict";
import test from "node:test";
import { runDaytonaSnapshot } from "../../../scripts/daytona-snapshot";

test("snapshot CLI verify is read-only and checks the existing profile", async () => {
  await Promise.all(
    [4, undefined, 1, 8].map(async (memory) => {
      const messages: string[] = [];
      const calls: string[] = [];
      const code = await runDaytonaSnapshot(
        {
          DAYTONA_API_KEY: "test-api-key",
          DAYTONA_SNAPSHOT: "coven-agents-copilot-2",
          NODE_ENV: "test",
        },
        {
          error: (message) => messages.push(message),
          log: (message) => messages.push(message),
        },
        ["--verify"],
        {
          create: () => {
            calls.push("create");
            return Promise.reject(new Error("must not mutate"));
          },
          get: (name) => {
            calls.push("get");
            return Promise.resolve({
              cpu: 2,
              disk: 10,
              mem: memory,
              name,
              state: "active",
            });
          },
        }
      );
      assert.equal(code, memory === 4 ? 0 : 1);
      assert.deepEqual(calls, ["get"]);
      assert.ok(messages.every((message) => message.length < 256));
    })
  );
});

test("snapshot CLI errors never echo provider credentials or unbounded input", async () => {
  const messages: string[] = [];
  const code = await runDaytonaSnapshot(
    {
      DAYTONA_API_KEY: "test-api-key",
      DAYTONA_SNAPSHOT: "coven-agents-copilot-2",
      NODE_ENV: "test",
    },
    {
      error: (message) => messages.push(message),
      log: (message) => messages.push(message),
    },
    ["--verify"],
    {
      create: () => Promise.reject(new Error("must not mutate")),
      get: () =>
        Promise.reject(new Error(`test-api-key${"x".repeat(100_000)}`)),
    }
  );
  assert.equal(code, 1);
  assert.ok(messages.every((message) => message.length < 256));
  assert.equal(messages.join("").includes("test-api-key"), false);
});
