import assert from "node:assert/strict";
import test from "node:test";
import { decideSubscriberAccess } from "./subscriber-access";

const USER_ID = "9c858901-8a57-4791-81fe-4c455b099bc9";

test("signed-out callers are unauthorized", () => {
  assert.deepEqual(decideSubscriberAccess(null), { kind: "unauthorized" });
});

test("signed-in guest accounts require a subscription", () => {
  assert.deepEqual(
    decideSubscriberAccess({
      user: { id: USER_ID, type: "demo" },
    }),
    { kind: "subscription_required" }
  );
});

test("subscriber authority returns the typed account identity", () => {
  assert.deepEqual(
    decideSubscriberAccess({
      user: { authVersion: 0, id: USER_ID, type: "subscriber" },
    }),
    {
      authVersion: 0,
      kind: "allowed",
      session: {
        kind: "subscriber",
        tenant: "u_9c8589018a57479181fe4c455b099bc9",
        userId: USER_ID,
      },
      userId: USER_ID,
    }
  );
});

test("unknown account types fail closed as guest access", () => {
  assert.deepEqual(
    decideSubscriberAccess({
      user: { id: USER_ID, type: "owner" },
    }),
    { kind: "subscription_required" }
  );
});

test("malformed account ids fail closed at the authorization boundary", () => {
  assert.deepEqual(
    decideSubscriberAccess({
      user: { authVersion: 0, id: "not-a-uuid", type: "subscriber" },
    }),
    { kind: "unauthorized" }
  );
});
