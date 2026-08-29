import assert from "node:assert/strict";
import test from "node:test";
import { fetchHasCredential, resetCredentialCache } from "./client";

test("the browser credential summary is fetched once", async () => {
  resetCredentialCache();
  let calls = 0;
  const counted = () => {
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ harnessIds: ["copilot"] }), { status: 200 })
    );
  };

  assert.equal(await fetchHasCredential(counted), true);
  assert.equal(await fetchHasCredential(counted), true);
  assert.equal(calls, 1);
});

test("an unreadable credential summary is not cached", async () => {
  resetCredentialCache();
  let calls = 0;
  const failing = () => {
    calls += 1;
    return Promise.resolve(new Response("nope", { status: 500 }));
  };

  assert.equal(await fetchHasCredential(failing), null);
  assert.equal(await fetchHasCredential(failing), null);
  assert.equal(calls, 2);
});
