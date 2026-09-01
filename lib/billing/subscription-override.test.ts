import assert from "node:assert/strict";
import test from "node:test";
import {
  applySubscriptionOverride,
  MAX_SUBSCRIPTION_OVERRIDE_DAYS,
  MAX_SUBSCRIPTION_OVERRIDE_REFERENCE_LENGTH,
  parseSubscriptionCliArguments,
  readSubscriptionOverrideReference,
  runSubscriptionCli,
  type SubscriptionOverrideAuditRecord,
  type SubscriptionOverrideStore,
  type SubscriptionOverrideTransaction,
} from "./subscription-override";

const NOW = new Date("2026-08-31T20:00:00.000Z");
const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REFERENCE = "case-2026-08-31";
const REFERENCE_DIGEST =
  "ecdec34cdc2aa092362fa4292fab97814b746403ae2dbccd2df8f96f97747eac";

type State = {
  audit: SubscriptionOverrideAuditRecord[];
  user: {
    authVersion: number;
    billingPeriodStart: Date | null;
    id: string;
    subscribedUntil: Date | null;
  };
};

class MemoryOverrideStore implements SubscriptionOverrideStore {
  auditFails = false;
  entitlementChangeBeforeLock: {
    billingPeriodStart: Date | null;
    subscribedUntil: Date | null;
  } | null = null;
  locks: string[] = [];
  state: State = {
    audit: [],
    user: {
      authVersion: 4,
      billingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      id: USER_ID,
      subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
    },
  };
  transactions = 0;
  updates = 0;

  async transaction<T>(
    callback: (transaction: SubscriptionOverrideTransaction) => Promise<T>
  ): Promise<T> {
    this.transactions += 1;
    const draft = structuredClone(this.state);
    const result = await callback({
      findUserForUpdate: (id) => {
        this.locks.push(id);
        if (this.entitlementChangeBeforeLock) {
          draft.user = {
            ...draft.user,
            ...this.entitlementChangeBeforeLock,
          };
        }
        return Promise.resolve(draft.user.id === id ? draft.user : null);
      },
      insertAudit: (record) => {
        if (this.auditFails) {
          throw new Error("audit write failed");
        }
        draft.audit.push(record);
        return Promise.resolve();
      },
      now: () => NOW,
      updateUser: (input) => {
        this.updates += 1;
        if (
          draft.user.id !== input.userId ||
          draft.user.authVersion !== input.expectedAuthVersion ||
          draft.user.billingPeriodStart?.getTime() !==
            input.expectedBillingPeriodStart?.getTime() ||
          draft.user.subscribedUntil?.getTime() !==
            input.expectedSubscribedUntil?.getTime()
        ) {
          return Promise.resolve(false);
        }
        draft.user = {
          ...draft.user,
          authVersion: input.newAuthVersion,
          billingPeriodStart: input.billingPeriodStart,
          subscribedUntil: input.subscribedUntil,
        };
        return Promise.resolve(true);
      },
    });
    this.state = draft;
    return result;
  }
}

function grant(days = 30) {
  return {
    durationDays: days,
    expectedAuthVersion: 4,
    expectedBillingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    expectedSubscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
    operation: "grant" as const,
    referenceDigest: REFERENCE_DIGEST,
    userId: USER_ID,
  };
}

test("grant locks its exact owner and writes bounded entitlement plus immutable audit", async () => {
  const store = new MemoryOverrideStore();

  const result = await applySubscriptionOverride(store, grant());

  assert.deepEqual(result, {
    kind: "applied",
    operation: "grant",
    subscribedUntil: new Date(NOW.getTime() + 30 * 86_400_000),
  });
  assert.deepEqual(store.locks, [USER_ID]);
  assert.equal(store.transactions, 1);
  assert.equal(store.updates, 1);
  assert.equal(store.state.user.authVersion, 5);
  assert.equal(
    store.state.user.billingPeriodStart?.toISOString(),
    NOW.toISOString()
  );
  assert.equal(
    store.state.user.subscribedUntil?.toISOString(),
    "2026-09-30T20:00:00.000Z"
  );
  assert.deepEqual(store.state.audit, [
    {
      action: "grant",
      createdAt: NOW,
      id: store.state.audit[0]?.id,
      newAuthVersion: 5,
      newSubscribedUntil: new Date("2026-09-30T20:00:00.000Z"),
      previousAuthVersion: 4,
      previousSubscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
      referenceDigest: REFERENCE_DIGEST,
      userId: USER_ID,
    },
  ]);
  assert.match(store.state.audit[0]?.id ?? "", /^[0-9a-f-]{36}$/u);
  assert.equal(JSON.stringify(store.state.audit).includes(REFERENCE), false);
});

test("revoke clears paid authority immediately and invalidates exactly one authority version", async () => {
  const store = new MemoryOverrideStore();

  const result = await applySubscriptionOverride(store, {
    expectedAuthVersion: 4,
    expectedBillingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
    expectedSubscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
    operation: "revoke",
    referenceDigest: REFERENCE_DIGEST,
    userId: USER_ID,
  });

  assert.deepEqual(result, {
    kind: "applied",
    operation: "revoke",
    subscribedUntil: null,
  });
  assert.equal(store.state.user.authVersion, 5);
  assert.equal(store.state.user.billingPeriodStart, null);
  assert.equal(store.state.user.subscribedUntil, null);
  assert.deepEqual(store.state.audit[0], {
    action: "revoke",
    createdAt: NOW,
    id: store.state.audit[0]?.id,
    newAuthVersion: 5,
    newSubscribedUntil: null,
    previousAuthVersion: 4,
    previousSubscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
    referenceDigest: REFERENCE_DIGEST,
    userId: USER_ID,
  });
});

test("grant duration is finite and has a defensible maximum", async () => {
  const store = new MemoryOverrideStore();

  await assert.rejects(
    applySubscriptionOverride(store, grant(MAX_SUBSCRIPTION_OVERRIDE_DAYS + 1)),
    /duration/i
  );
  assert.equal(store.transactions, 0);

  await applySubscriptionOverride(store, grant(MAX_SUBSCRIPTION_OVERRIDE_DAYS));
  assert.equal(
    store.state.user.subscribedUntil?.getTime(),
    NOW.getTime() + MAX_SUBSCRIPTION_OVERRIDE_DAYS * 86_400_000
  );
});

test("missing and invalid reference digests fail before a database mutation", async () => {
  const store = new MemoryOverrideStore();

  await assert.rejects(
    applySubscriptionOverride(store, { ...grant(), referenceDigest: "" }),
    /reference/i
  );
  await assert.rejects(
    applySubscriptionOverride(store, {
      ...grant(),
      referenceDigest: "x".repeat(64),
    }),
    /reference/i
  );
  assert.equal(store.transactions, 0);
});

test("an audit failure rolls back the entitlement and authority mutation", async () => {
  const store = new MemoryOverrideStore();
  store.auditFails = true;

  await assert.rejects(
    applySubscriptionOverride(store, grant()),
    /audit write failed/
  );

  assert.equal(store.state.user.authVersion, 4);
  assert.equal(
    store.state.user.subscribedUntil?.toISOString(),
    "2026-09-01T00:00:00.000Z"
  );
  assert.deepEqual(store.state.audit, []);
});

test("a stale authority decision is rejected after the owner lock without another audit", async () => {
  const store = new MemoryOverrideStore();

  assert.equal(
    (await applySubscriptionOverride(store, grant())).kind,
    "applied"
  );
  const stale = await applySubscriptionOverride(store, {
    ...grant(),
    operation: "revoke",
  });

  assert.deepEqual(stale, { kind: "authority_changed" });
  assert.equal(store.state.user.authVersion, 5);
  assert.equal(store.state.audit.length, 1);
  assert.equal(store.updates, 1);
});

test("an entitlement change without an authority-version change is rejected without an update or audit", async () => {
  const store = new MemoryOverrideStore();
  store.entitlementChangeBeforeLock = {
    billingPeriodStart: new Date("2026-08-15T00:00:00.000Z"),
    subscribedUntil: new Date("2026-10-01T00:00:00.000Z"),
  };

  const result = await applySubscriptionOverride(store, grant());

  assert.deepEqual(result, { kind: "authority_changed" });
  assert.equal(store.updates, 0);
  assert.deepEqual(store.state.audit, []);
  assert.equal(store.state.user.authVersion, 4);
  assert.equal(
    store.state.user.billingPeriodStart?.toISOString(),
    "2026-08-15T00:00:00.000Z"
  );
  assert.equal(
    store.state.user.subscribedUntil?.toISOString(),
    "2026-10-01T00:00:00.000Z"
  );
});

test("CLI mutation arguments require stdin references but status needs none", () => {
  assert.deepEqual(
    parseSubscriptionCliArguments([
      "grant",
      "person@example.com",
      "30",
      "--reference-stdin",
    ]),
    {
      durationDays: 30,
      email: "person@example.com",
      kind: "override",
      operation: "grant",
    }
  );
  assert.deepEqual(
    parseSubscriptionCliArguments(["status", "person@example.com"]),
    {
      email: "person@example.com",
      kind: "status",
    }
  );
  assert.throws(
    () => parseSubscriptionCliArguments(["revoke", "person@example.com"]),
    /reference/i
  );
  assert.throws(
    () =>
      parseSubscriptionCliArguments([
        "status",
        "person@example.com",
        "--reference-stdin",
      ]),
    /usage/i
  );
  assert.throws(
    () =>
      parseSubscriptionCliArguments([
        "grant",
        "person@example.com",
        "--reference",
        REFERENCE,
      ]),
    /reference/i
  );
});

async function* referenceInput(
  ...chunks: Uint8Array[]
): AsyncGenerator<Uint8Array> {
  yield* chunks;
}

test("reference stdin accepts one bounded printable UTF-8 value", async () => {
  assert.equal(
    await readSubscriptionOverrideReference(
      referenceInput(Buffer.from(`${REFERENCE}\r\n`))
    ),
    REFERENCE
  );
});

test("reference stdin rejects missing, oversized, and invalid input without buffering it", async () => {
  await assert.rejects(
    readSubscriptionOverrideReference(referenceInput()),
    /reference/i
  );
  let oversizedChunksRead = 0;
  async function* oversizedInput(): AsyncGenerator<Uint8Array> {
    oversizedChunksRead += 1;
    yield await Promise.resolve(
      Buffer.from("x".repeat(MAX_SUBSCRIPTION_OVERRIDE_REFERENCE_LENGTH))
    );
    oversizedChunksRead += 1;
    yield Buffer.from("x");
    oversizedChunksRead += 1;
    throw new Error("reader must stop at the reference cap");
  }
  await assert.rejects(
    readSubscriptionOverrideReference(oversizedInput()),
    /reference/i
  );
  assert.equal(oversizedChunksRead, 2);
  await assert.rejects(
    readSubscriptionOverrideReference(referenceInput(new Uint8Array([0xff]))),
    /reference/i
  );
});

test("CLI reads an audit reference outside argv and never outputs it", async () => {
  const seen: unknown[] = [];
  let referenceReads = 0;
  const args = ["grant", "person@example.com", "30", "--reference-stdin"];
  assert.equal(args.includes(REFERENCE), false);
  const response = await runSubscriptionCli(args, {
    applyOverride: (input) => {
      seen.push(input);
      return Promise.resolve({
        kind: "applied",
        operation: "grant",
        subscribedUntil: new Date("2026-09-30T20:00:00.000Z"),
      });
    },
    findUserByEmail: () =>
      Promise.resolve({
        authVersion: 4,
        billingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
        id: USER_ID,
        subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
      }),
    now: () => NOW,
    readReference: () => {
      referenceReads += 1;
      return readSubscriptionOverrideReference(
        referenceInput(Buffer.from(`${REFERENCE}\n`))
      );
    },
  });

  assert.equal(response.code, 0);
  assert.equal(referenceReads, 1);
  assert.match(response.output, /Existing authority was invalidated/u);
  assert.equal(response.output.includes(REFERENCE), false);
  assert.equal(response.output.includes(USER_ID), false);
  assert.deepEqual(seen, [
    {
      durationDays: 30,
      expectedAuthVersion: 4,
      expectedBillingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
      expectedSubscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
      operation: "grant",
      referenceDigest: REFERENCE_DIGEST,
      userId: USER_ID,
    },
  ]);
});

test("status does not read a reference and retains its read-only response", async () => {
  let referenceReads = 0;
  const response = await runSubscriptionCli(["status", "person@example.com"], {
    applyOverride: () => Promise.reject(new Error("must not mutate")),
    findUserByEmail: () =>
      Promise.resolve({
        authVersion: 4,
        billingPeriodStart: new Date("2026-08-01T00:00:00.000Z"),
        id: USER_ID,
        subscribedUntil: new Date("2026-09-01T00:00:00.000Z"),
      }),
    now: () => NOW,
    readReference: () => {
      referenceReads += 1;
      return Promise.resolve(REFERENCE);
    },
  });

  assert.equal(response.code, 0);
  assert.equal(
    response.output,
    "Subscription status: subscriber (subscribedUntil=2026-09-01T00:00:00.000Z)\n"
  );
  assert.equal(referenceReads, 0);
});
