import assert from "node:assert/strict";
import test from "node:test";
import { revalidateSubscriberAccess } from "./subscriber-authorization";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

test("guest accounts fail before subscription storage is read", async () => {
  let lookups = 0;
  const decision = await revalidateSubscriberAccess(
    { user: { authVersion: 0, id: USER_ID, type: "demo" } },
    () => {
      lookups += 1;
      return Promise.resolve({
        subscribedUntil: new Date(NOW.getTime() + 60_000),
      });
    },
    NOW
  );

  assert.deepEqual(decision, { kind: "subscription_required" });
  assert.equal(lookups, 0);
});

test("active server-owned subscription authority is allowed", async () => {
  const decision = await revalidateSubscriberAccess(
    { user: { authVersion: 0, id: USER_ID, type: "subscriber" } },
    () =>
      Promise.resolve({
        authVersion: 0,
        subscribedUntil: new Date(NOW.getTime() + 60_000),
      }),
    NOW
  );

  assert.equal(decision.kind, "allowed");
});

test("a revoked subscriber token fails closed immediately", async () => {
  const decision = await revalidateSubscriberAccess(
    { user: { authVersion: 0, id: USER_ID, type: "subscriber" } },
    () => Promise.resolve({ authVersion: 0, subscribedUntil: null }),
    NOW
  );

  assert.deepEqual(decision, { kind: "subscription_required" });
});

test("a subscriber token with a stale auth version is refused", async () => {
  const decision = await revalidateSubscriberAccess(
    { user: { authVersion: 0, id: USER_ID, type: "subscriber" } },
    () =>
      Promise.resolve({
        authVersion: 1,
        subscribedUntil: new Date(NOW.getTime() + 60_000),
      }),
    NOW
  );

  assert.deepEqual(decision, { kind: "subscription_required" });
});

test("a subscription lookup failure fails closed", async () => {
  const decision = await revalidateSubscriberAccess(
    { user: { authVersion: 0, id: USER_ID, type: "subscriber" } },
    () => Promise.reject(new Error("database unavailable")),
    NOW
  );

  assert.deepEqual(decision, { kind: "subscription_required" });
});

test("a missing subscriber row fails closed", async () => {
  const decision = await revalidateSubscriberAccess(
    { user: { authVersion: 0, id: USER_ID, type: "subscriber" } },
    () => Promise.resolve(null),
    NOW
  );

  assert.deepEqual(decision, { kind: "subscription_required" });
});

test("active campaign-only authority reaches the same subscriber decision as dispatch", async () => {
  const access = await revalidateSubscriberAccess(
    { user: { authVersion: 2, id: USER_ID, type: "subscriber" } },
    async () => ({
      authVersion: 2,
      campaignExpiresAt: new Date(NOW.getTime() + 60_000),
      campaignGrantedAt: new Date(NOW.getTime() - 60_000),
      subscribedUntil: null,
    }),
    NOW
  );
  assert.equal(access.kind, "allowed");
});
