import assert from "node:assert/strict";
import test from "node:test";
import { provisionConnection, resetProvisionCache } from "./provision";

const OK = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({ endpoint: "https://runner.test", token: "gate" }),
      { status: 200 }
    )
  );

test("repeated calls issue exactly one request", async () => {
  // The defect this fixes: the console fetched from a mount effect, so every
  // remount issued another request -- visible as a stream of identical calls
  // in the network tab.
  resetProvisionCache();
  let calls = 0;
  const counted = () => {
    calls += 1;
    return OK();
  };

  await provisionConnection(counted);
  await provisionConnection(counted);
  await provisionConnection(counted);

  assert.equal(calls, 1);
});

test("concurrent callers share one request rather than racing", async () => {
  resetProvisionCache();
  let calls = 0;
  const counted = () => {
    calls += 1;
    return OK();
  };

  await Promise.all([
    provisionConnection(counted),
    provisionConnection(counted),
    provisionConnection(counted),
  ]);

  assert.equal(calls, 1);
});

test("every caller gets the same answer", async () => {
  resetProvisionCache();
  const first = await provisionConnection(OK);
  const second = await provisionConnection(OK);

  assert.deepEqual(first, second);
  assert.equal(first.kind, "provisioned");
});

test("a network failure is not cached forever", async () => {
  // A blip must not leave the console unable to connect for the life of the
  // page, which is what caching the rejection would do.
  resetProvisionCache();
  let calls = 0;
  const failing = () => {
    calls += 1;
    return Promise.reject(new Error("offline"));
  };

  assert.equal((await provisionConnection(failing)).kind, "unavailable");
  assert.equal((await provisionConnection(failing)).kind, "unavailable");
  assert.equal(calls, 2, "a retry must be possible after a network failure");
});

test("a refusal IS cached, because it will not change on retry", async () => {
  // 403 means no subscription. Retrying every remount would reproduce the
  // spam this exists to stop.
  resetProvisionCache();
  let calls = 0;
  const refused = () => {
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ error: "subscription_required" }), {
        status: 403,
      })
    );
  };

  await provisionConnection(refused);
  await provisionConnection(refused);

  assert.equal(calls, 1);
});
