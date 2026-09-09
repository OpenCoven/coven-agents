import assert from "node:assert/strict";
import test from "node:test";
import {
  type AnalyticsDependencies,
  analyticsResponse,
} from "@/lib/analytics/response";

const session = {
  user: {
    authVersion: 4,
    id: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    type: "subscriber" as const,
  },
};

test("lapsed analytics access is denied before admission or history reads", async () => {
  const calls: string[] = [];
  const dependencies: AnalyticsDependencies = {
    authenticate: () => Promise.resolve(session),
    authorize: () => {
      calls.push("authorize");
      return Promise.resolve({ kind: "subscription_required" });
    },
    enforceAbuse: () => {
      calls.push("abuse");
      return Promise.resolve({ kind: "allowed" });
    },
    readDurations: () => {
      calls.push("durations");
      return Promise.resolve({
        longestSeconds: null,
        medianSeconds: null,
        settledRuns: 0,
        unsettledRuns: 0,
      });
    },
    readHistory: () => {
      calls.push("history");
      return Promise.resolve([]);
    },
  };

  const response = await analyticsResponse(
    new Request("https://app.test/api/analytics"),
    dependencies,
    null
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "subscription_required",
    message:
      "Guest accounts can explore the safe replay and account setup. Live and persistent features need an active subscription.",
  });
  assert.deepEqual(calls, ["authorize"]);
});
