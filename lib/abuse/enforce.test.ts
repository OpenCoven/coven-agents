import assert from "node:assert/strict";
import test from "node:test";
import {
  abuseAdmissionResponse,
  createAbusePolicyEnforcer,
  enforceAbusePolicy,
} from "./enforce";
import type { AbuseStore } from "./store";

test("missing IPs share one unknown bucket", async () => {
  const store = new RecordingStore();

  assert.deepEqual(
    await enforceAbusePolicy({
      ip: null,
      route: "checkout",
      store,
      userId: "user-1",
    }),
    { kind: "allowed" }
  );

  assert.deepEqual(store.calls, [
    ["checkout:burst:ip:unknown", 2, 300],
    ["checkout:sustained:ip:unknown", 3, 3600],
    ["checkout:burst:user:user-1", 2, 300],
    ["checkout:sustained:user:user-1", 3, 3600],
  ]);
});

test("every required subject consumes burst and sustained budgets", async () => {
  const store = new RecordingStore();

  assert.deepEqual(
    await enforceAbusePolicy({
      ip: "203.0.113.4",
      route: "internal_credential",
      store,
      tenant: "tenant-1",
    }),
    { kind: "allowed" }
  );

  assert.deepEqual(store.calls, [
    ["internal_credential:burst:ip:203.0.113.4", 10, 60],
    ["internal_credential:sustained:ip:203.0.113.4", 60, 3600],
    ["internal_credential:burst:tenant:tenant-1", 10, 60],
    ["internal_credential:sustained:tenant:tenant-1", 60, 3600],
  ]);
});

test("denials stop after one subject and return its maximum retry", async () => {
  const store = new RecordingStore((key) => ({
    allowed: false,
    remaining: 0,
    retryAfterSeconds: key.includes(":sustained:") ? 300 : 45,
  }));

  assert.deepEqual(
    await enforceAbusePolicy({
      ip: "203.0.113.4",
      route: "checkout",
      store,
      userId: "user-1",
    }),
    {
      kind: "denied",
      responseStatus: 429,
      retryAfterSeconds: 300,
    }
  );
  assert.deepEqual(store.calls, [
    ["checkout:burst:ip:203.0.113.4", 2, 300],
    ["checkout:sustained:ip:203.0.113.4", 3, 3600],
  ]);
});

test("missing required identity is explicitly unavailable", async () => {
  const store = new RecordingStore();

  assert.deepEqual(
    await enforceAbusePolicy({
      ip: "203.0.113.4",
      route: "checkout",
      store,
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
  assert.equal(store.calls.length, 0);
});

test("production store configuration and consume outages fail closed", async () => {
  const configurationFailure = createAbusePolicyEnforcer({
    getStore: () => {
      throw new Error("secret configuration leaked");
    },
    isProduction: true,
  });
  const consumeFailure: AbuseStore = {
    consume: () => Promise.reject(new Error("redis details leaked")),
  };

  assert.deepEqual(
    await configurationFailure({
      ip: "203.0.113.4",
      route: "checkout",
      userId: "user-1",
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
  assert.deepEqual(
    await configurationFailure({
      ip: "203.0.113.4",
      route: "checkout",
      store: consumeFailure,
      userId: "user-1",
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
});

test("development without configured Redis explicitly allows requests", async () => {
  let storeRequests = 0;
  const developmentEnforcer = createAbusePolicyEnforcer({
    getStore: (): undefined => {
      storeRequests += 1;
    },
    isProduction: false,
  });

  assert.deepEqual(
    await developmentEnforcer({
      ip: "203.0.113.4",
      route: "checkout",
      userId: "user-1",
    }),
    { kind: "allowed" }
  );
  assert.equal(storeRequests, 1);
});

test("production without configured Redis fails closed", async () => {
  const productionEnforcer = createAbusePolicyEnforcer({
    getStore: () => undefined,
    isProduction: true,
  });

  assert.deepEqual(
    await productionEnforcer({
      ip: "203.0.113.4",
      route: "checkout",
      userId: "user-1",
    }),
    { kind: "unavailable", responseStatus: 503 }
  );
});

test("rate-limit responses are generic and non-cacheable", async () => {
  const response = abuseAdmissionResponse({
    kind: "denied",
    responseStatus: 429,
    retryAfterSeconds: 300,
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "300");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "rate_limited",
    message: "Too many requests. Try again later.",
  });
});

test("unavailable responses hide limiter internals", async () => {
  const response = abuseAdmissionResponse({
    kind: "unavailable",
    responseStatus: 503,
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    error: "abuse_control_unavailable",
    message: "Please try again later.",
  });
});

class RecordingStore implements AbuseStore {
  readonly calls: [string, number, number][] = [];
  private readonly result: (
    key: string
  ) => Awaited<ReturnType<AbuseStore["consume"]>>;

  constructor(
    result: (
      key: string
    ) => Awaited<ReturnType<AbuseStore["consume"]>> = () => ({
      allowed: true,
      remaining: 1,
      retryAfterSeconds: 60,
    })
  ) {
    this.result = result;
  }

  consume(
    key: string,
    limit: number,
    windowSeconds: number
  ): ReturnType<AbuseStore["consume"]> {
    this.calls.push([key, limit, windowSeconds]);
    return Promise.resolve(this.result(key));
  }
}
