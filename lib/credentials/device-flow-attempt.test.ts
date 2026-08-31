import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeviceFlowAttempt,
  requestDeviceFlowStart,
} from "./device-flow-attempt";

test("a lost start response reuses the same idempotency key", () => {
  const generated = ["attempt-one", "attempt-two"];
  const attempt = createDeviceFlowAttempt(() => generated.shift() ?? "extra");

  assert.equal(attempt.key(), "attempt-one");
  assert.equal(attempt.key(), "attempt-one");
  assert.deepEqual(generated, ["attempt-two"]);
});

test("success or explicit reset rotates the next attempt key", () => {
  const generated = ["attempt-one", "attempt-two", "attempt-three"];
  const attempt = createDeviceFlowAttempt(() => generated.shift() ?? "extra");

  assert.equal(attempt.key(), "attempt-one");
  attempt.reset();
  assert.equal(attempt.key(), "attempt-two");
  attempt.reset();
  assert.equal(attempt.key(), "attempt-three");
});

test("a lost response retries the request key and rotates only after success", async () => {
  const generated = ["attempt-one", "attempt-two"];
  const attempt = createDeviceFlowAttempt(() => generated.shift() ?? "extra");
  const requestedKeys: string[] = [];
  let requests = 0;
  const fetcher: typeof fetch = (_input, init) => {
    requests += 1;
    requestedKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
    if (requests === 1) {
      return Promise.reject(new Error("response lost"));
    }
    return Promise.resolve(
      Response.json({
        deviceCode: "device-secret",
        interval: 5,
        userCode: "ABCD-EFGH",
        verificationUri: "https://github.com/login/device",
      })
    );
  };

  await assert.rejects(
    requestDeviceFlowStart({ attempt, fetcher }),
    /response lost/
  );
  const started = await requestDeviceFlowStart({ attempt, fetcher });

  assert.equal(started.userCode, "ABCD-EFGH");
  assert.deepEqual(requestedKeys, ["attempt-one", "attempt-one"]);
  assert.equal(attempt.key(), "attempt-two");
});

test("device flow starts beneath the configured application base path", async () => {
  const previous = process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.NEXT_PUBLIC_BASE_PATH = "/demo";
  const inputs: string[] = [];
  try {
    await requestDeviceFlowStart({
      attempt: createDeviceFlowAttempt(() => "attempt-one"),
      fetcher: (input) => {
        inputs.push(String(input));
        return Promise.resolve(
          Response.json({
            deviceCode: "device-secret",
            interval: 5,
            userCode: "ABCD-EFGH",
            verificationUri: "https://github.com/login/device",
          })
        );
      },
    });
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_BASE_PATH = previous;
    }
  }
  assert.deepEqual(inputs, ["/demo/api/credentials/device"]);
});
