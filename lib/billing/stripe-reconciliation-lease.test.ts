// biome-ignore-all lint/suspicious/useAwait: dependency doubles keep async signatures for clarity.
import assert from "node:assert/strict";
import test from "node:test";
import type {
  StripeReconciliationLease,
  StripeReconciliationStore,
  StripeReconciliationUser,
} from "./stripe-reconciliation";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

test("lease takeover fences stale renew, commit, and release while preserving a crash cursor", async () => {
  const store = new FencedStore([
    {
      authVersion: 1,
      billingPeriodStart: null,
      id: USER_ID,
      stripeCustomerId: "cus_lease",
      stripeSubscriptionId: null,
      subscribedUntil: null,
    },
  ]);
  const first = await acquired(
    store.acquire({ leaseTtlMs: 10, owner: "first" })
  );
  assert.deepEqual(await store.acquire({ leaseTtlMs: 10, owner: "second" }), {
    kind: "held",
  });

  store.cursor = USER_ID;
  store.now = 10;
  const second = await acquired(
    store.acquire({ leaseTtlMs: 10, owner: "second" })
  );
  assert.equal(second.cursor, USER_ID);
  assert.equal(second.fence, first.fence + 1);
  assert.deepEqual(await store.renew({ lease: first, leaseTtlMs: 10 }), {
    kind: "lost",
  });
  assert.equal(
    await store.commit({
      lease: first,
      mutation: { subscribedUntil: new Date("2026-10-01T00:00:00.000Z") },
      nextCursor: USER_ID,
      snapshot: store.users[0] as StripeReconciliationUser,
    }),
    "lost"
  );
  assert.equal(await store.release(first), "lost");
  assert.equal(await store.release(second), "released");
});

test("commit changes the cursor and user together only for an exact null-safe snapshot", async () => {
  const current: StripeReconciliationUser = {
    authVersion: 4,
    billingPeriodStart: null,
    id: USER_ID,
    stripeCustomerId: "cus_lease",
    stripeSubscriptionId: null,
    subscribedUntil: null,
  };
  const store = new FencedStore([current]);
  const lease = await acquired(
    store.acquire({ leaseTtlMs: 10, owner: "owner" })
  );

  assert.equal(
    await store.commit({
      lease,
      mutation: { stripeSubscriptionId: "sub_lease" },
      nextCursor: USER_ID,
      snapshot: { ...current },
    }),
    "committed"
  );
  assert.equal(store.cursor, USER_ID);
  assert.equal(store.users[0]?.stripeSubscriptionId, "sub_lease");

  const beforeConflictCursor = store.cursor;
  assert.equal(
    await store.commit({
      lease,
      mutation: { subscribedUntil: new Date("2026-10-01T00:00:00.000Z") },
      nextCursor: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      snapshot: current,
    }),
    "conflict"
  );
  assert.equal(store.cursor, beforeConflictCursor);
  assert.equal(store.users[0]?.subscribedUntil, null);

  const wrapped = await store.wrapCursor(lease);
  assert.equal(wrapped.kind, "wrapped");
  assert.equal(store.cursor, null);
});

async function acquired(
  result: ReturnType<StripeReconciliationStore["acquire"]>
): Promise<StripeReconciliationLease> {
  const resolved = await result;
  assert.notEqual(resolved.kind, "held");
  return (resolved as { lease: StripeReconciliationLease }).lease;
}

class FencedStore implements StripeReconciliationStore {
  cursor: string | null = null;
  fence = 0;
  now = 0;
  owner: string | null = null;
  expiresAt = 0;
  users: StripeReconciliationUser[];

  constructor(users: StripeReconciliationUser[]) {
    this.users = users;
  }

  async acquire(input: {
    leaseTtlMs: number;
    owner: string;
  }): Promise<
    { kind: "acquired"; lease: StripeReconciliationLease } | { kind: "held" }
  > {
    if (this.owner && this.expiresAt > this.now) {
      return { kind: "held" };
    }
    this.fence += 1;
    this.owner = input.owner;
    this.expiresAt = this.now + input.leaseTtlMs;
    return {
      kind: "acquired",
      lease: { cursor: this.cursor, fence: this.fence, owner: input.owner },
    };
  }

  async commit(input: {
    lease: StripeReconciliationLease;
    mutation: Partial<
      Pick<
        StripeReconciliationUser,
        | "billingPeriodStart"
        | "stripeCustomerId"
        | "stripeSubscriptionId"
        | "subscribedUntil"
      >
    > | null;
    nextCursor: string;
    snapshot: StripeReconciliationUser;
  }): Promise<"committed" | "conflict" | "lost"> {
    if (!this.owns(input.lease)) {
      return "lost";
    }
    const current = this.users.find((row) => row.id === input.snapshot.id);
    if (!current || !sameSnapshot(current, input.snapshot)) {
      return "conflict";
    }
    this.users[this.users.indexOf(current)] = { ...current, ...input.mutation };
    this.cursor = input.nextCursor;
    return "committed";
  }

  async release(
    lease: StripeReconciliationLease
  ): Promise<"lost" | "released"> {
    if (lease.owner !== this.owner || lease.fence !== this.fence) {
      return "lost";
    }
    this.owner = null;
    this.expiresAt = 0;
    return "released";
  }

  async renew(input: {
    lease: StripeReconciliationLease;
    leaseTtlMs: number;
  }): Promise<
    { kind: "lost" } | { kind: "renewed"; lease: StripeReconciliationLease }
  > {
    if (!this.owns(input.lease)) {
      return { kind: "lost" };
    }
    this.expiresAt = this.now + input.leaseTtlMs;
    return { kind: "renewed", lease: input.lease };
  }

  async scanUsers(input: {
    after: string | null;
    limit: number;
  }): Promise<StripeReconciliationUser[]> {
    return this.users
      .filter((row) => row.id > (input.after ?? ""))
      .slice(0, input.limit);
  }

  async wrapCursor(
    lease: StripeReconciliationLease
  ): Promise<
    { kind: "lost" } | { kind: "wrapped"; lease: StripeReconciliationLease }
  > {
    if (!this.owns(lease)) {
      return { kind: "lost" };
    }
    this.cursor = null;
    return { kind: "wrapped", lease: { ...lease, cursor: null } };
  }

  private owns(lease: StripeReconciliationLease): boolean {
    return (
      lease.owner === this.owner &&
      lease.fence === this.fence &&
      this.expiresAt > this.now
    );
  }
}

function sameSnapshot(
  left: StripeReconciliationUser,
  right: StripeReconciliationUser
): boolean {
  return (
    left.authVersion === right.authVersion &&
    left.billingPeriodStart?.getTime() ===
      right.billingPeriodStart?.getTime() &&
    left.subscribedUntil?.getTime() === right.subscribedUntil?.getTime() &&
    left.stripeCustomerId === right.stripeCustomerId &&
    left.stripeSubscriptionId === right.stripeSubscriptionId
  );
}
