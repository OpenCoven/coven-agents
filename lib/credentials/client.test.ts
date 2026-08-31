import assert from "node:assert/strict";
import test from "node:test";
import {
  createCredentialRefreshFence,
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

test("the browser credential summary uses the configured application base path", async () => {
  resetCredentialCache();
  const previous = process.env.NEXT_PUBLIC_BASE_PATH;
  process.env.NEXT_PUBLIC_BASE_PATH = "/demo";
  const paths: string[] = [];
  try {
    await fetchHasCredential((input) => {
      paths.push(input);
      return Promise.resolve(
        Response.json({ harnessIds: [] }, { status: 200 })
      );
    });
  } finally {
    if (previous === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_PATH;
    } else {
      process.env.NEXT_PUBLIC_BASE_PATH = previous;
    }
  }
  assert.deepEqual(paths, ["/demo/api/credentials"]);
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

test("a subscription-refused credential summary is exposed to the authority owner", async () => {
  resetCredentialCache();

  assert.equal(
    await fetchHasCredential(() =>
      Promise.resolve(
        Response.json({ error: "subscription_required" }, { status: 403 })
      )
    ),
    "subscription_required"
  );
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

test("credential refresh fencing rejects stale epochs, overlapping reads, and unmounted updates", () => {
  const fence = createCredentialRefreshFence();
  fence.activate();

  const mountRefresh = fence.beginRefresh();
  assert.equal(fence.isCurrent(mountRefresh), true);

  fence.advanceMutation();
  assert.equal(fence.isCurrent(mountRefresh), false);
  const authoritativeRefresh = fence.beginRefresh();
  assert.equal(fence.isCurrent(authoritativeRefresh), true);

  const overlappingRefresh = fence.beginRefresh();
  assert.equal(fence.isCurrent(authoritativeRefresh), false);
  assert.equal(fence.isCurrent(overlappingRefresh), true);

  fence.deactivate();
  assert.equal(fence.isCurrent(overlappingRefresh), false);

  fence.activate();
  const refreshAfterFailedMutation = fence.beginRefresh();
  assert.equal(fence.isCurrent(refreshAfterFailedMutation), true);
});
