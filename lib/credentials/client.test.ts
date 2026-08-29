import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchHasCredential,
  resetCredentialCache,
  updateCredentialEligibility,
} from "./client";

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

test("successful credential refreshes replace cached run eligibility", async () => {
  resetCredentialCache();
  let calls = 0;
  const empty = () => {
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ harnessIds: [] }), { status: 200 })
    );
  };

  assert.equal(await fetchHasCredential(empty), false);
  assert.equal(updateCredentialEligibility(["copilot"]), true);
  assert.equal(await fetchHasCredential(empty), true);
  assert.equal(updateCredentialEligibility([]), false);
  assert.equal(await fetchHasCredential(empty), false);
  assert.equal(calls, 1);
});

test("an older in-flight summary cannot overwrite a successful credential update", async () => {
  resetCredentialCache();
  let resolveResponse!: (response: Response) => void;
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });

  const pending = fetchHasCredential(() => response);
  assert.equal(updateCredentialEligibility(["copilot"]), true);
  resolveResponse(
    new Response(JSON.stringify({ harnessIds: [] }), { status: 200 })
  );

  assert.equal(await pending, true);
  assert.equal(await fetchHasCredential(), true);
});
