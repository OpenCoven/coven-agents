import assert from "node:assert/strict";
import test from "node:test";
import type {
  IdempotencyCompleteInput,
  StoredIdempotencyResponse,
} from "../abuse/idempotency";
import type { SessionAuthority } from "../auth/session-revocation";
import type { CredentialDevicePollClaim } from "./device-poll";
import {
  type CredentialDevicePollCommitDatabase,
  type CredentialDevicePollCommitTransaction,
  commitCredentialDevicePollAuthorized,
} from "./device-poll-commit";

const NOW = new Date("2026-08-31T20:00:00.000Z");
const CLAIM: CredentialDevicePollClaim = {
  claimExpiresAt: new Date(NOW.getTime() + 300_000),
  keyHash: "key-hash",
  operation: "credential_device_poll",
  ownerId: "00000000-0000-4000-8000-000000000001",
  ownerToken: "claim-token",
  recordId: "00000000-0000-4000-8000-000000000010",
  requestHash: "request-hash",
};
const RESPONSE: StoredIdempotencyResponse = {
  envelope: { body: { status: "authorized" }, kind: "plain_json" },
  status: 200,
};

type State = {
  completed: StoredIdempotencyResponse | null;
  credential: string | null;
  fence: boolean;
};

class MemoryDatabase implements CredentialDevicePollCommitDatabase<string> {
  authority: SessionAuthority | null = {
    authVersion: 4,
    subscribedUntil: new Date(NOW.getTime() + 600_000),
  };
  completedInput: IdempotencyCompleteInput | null = null;
  completeSucceeds = true;
  now = NOW;
  state: State = { completed: null, credential: null, fence: true };
  transactions = 0;
  upserts = 0;

  async transaction<T>(
    callback: (
      transaction: CredentialDevicePollCommitTransaction<string>
    ) => Promise<T>
  ): Promise<T> {
    this.transactions += 1;
    const draft = structuredClone(this.state);
    const result = await callback({
      completeClaim: (completionInput) => {
        this.completedInput = completionInput;
        if (!this.completeSucceeds || !draft.fence) {
          return Promise.resolve(false);
        }
        draft.completed = RESPONSE;
        draft.fence = false;
        return Promise.resolve(true);
      },
      currentTime: () => this.now,
      findAuthorityForUpdate: () => Promise.resolve(this.authority),
      findClaimForUpdate: () => Promise.resolve(draft.fence),
      findCompleted: () => Promise.resolve(draft.completed),
      upsertCredential: (input) => {
        this.upserts += 1;
        draft.credential = input.credential;
        return Promise.resolve();
      },
    });
    this.state = draft;
    return result;
  }
}

function completion(): IdempotencyCompleteInput & {
  authVersion: number;
  claim: CredentialDevicePollClaim;
  credential: string;
} {
  return {
    authVersion: 4,
    claim: CLAIM,
    completedAt: NOW,
    credential: "sealed-credential",
    expiresAt: new Date(NOW.getTime() + 1_200_000),
    response: RESPONSE,
  };
}

test("credential upsert rolls back when exact idempotency completion fails", async () => {
  const database = new MemoryDatabase();
  database.completeSucceeds = false;

  await assert.rejects(
    commitCredentialDevicePollAuthorized(database, completion()),
    /claim changed before completion/
  );

  assert.deepEqual(database.state, {
    completed: null,
    credential: null,
    fence: true,
  });
  assert.equal(database.transactions, 1);
  assert.equal(database.upserts, 1);
});

test("one transaction stores the credential and completed response together", async () => {
  const database = new MemoryDatabase();

  assert.equal(
    await commitCredentialDevicePollAuthorized(database, completion()),
    "completed"
  );
  assert.equal(database.state.credential, "sealed-credential");
  assert.deepEqual(database.state.completed, RESPONSE);
  assert.equal(database.transactions, 1);
});

test("a lost fence returns lost without writing the credential", async () => {
  const database = new MemoryDatabase();
  database.state.fence = false;

  assert.equal(
    await commitCredentialDevicePollAuthorized(database, completion()),
    "lost"
  );
  assert.equal(database.upserts, 0);
  assert.equal(database.state.credential, null);
});

test("lost session authority refuses the credential before either durable write", async () => {
  const database = new MemoryDatabase();
  database.authority = null;

  assert.equal(
    await commitCredentialDevicePollAuthorized(database, completion()),
    "authority_lost"
  );
  assert.equal(database.upserts, 0);
  assert.deepEqual(database.state, {
    completed: null,
    credential: null,
    fence: true,
  });
});

test("a claim that expires while waiting for transaction locks cannot commit", async () => {
  const database = new MemoryDatabase();
  database.now = new Date(CLAIM.claimExpiresAt.getTime() + 1);

  assert.equal(
    await commitCredentialDevicePollAuthorized(database, completion()),
    "lost"
  );
  assert.equal(database.upserts, 0);
  assert.equal(database.completedInput, null);
});

test("subscription authority that expires before the locked commit cannot write", async () => {
  const database = new MemoryDatabase();
  database.now = new Date(NOW.getTime() + 10_000);
  database.authority = {
    authVersion: 4,
    subscribedUntil: database.now,
  };

  assert.equal(
    await commitCredentialDevicePollAuthorized(database, completion()),
    "authority_lost"
  );
  assert.equal(database.upserts, 0);
  assert.equal(database.completedInput, null);
});

test("successful completion is timestamped after locks while preserving retention", async () => {
  const database = new MemoryDatabase();
  database.now = new Date(NOW.getTime() + 10_000);
  const input = completion();

  assert.equal(
    await commitCredentialDevicePollAuthorized(database, input),
    "completed"
  );
  assert.equal(
    database.completedInput?.completedAt.getTime(),
    database.now.getTime()
  );
  assert.equal(
    (database.completedInput?.expiresAt.getTime() ?? 0) -
      database.now.getTime(),
    input.expiresAt.getTime() - input.completedAt.getTime()
  );
});

test("an exact completed authorized record replays without another credential write", async () => {
  const database = new MemoryDatabase();
  database.state = {
    completed: RESPONSE,
    credential: "winner-credential",
    fence: false,
  };

  assert.deepEqual(
    await commitCredentialDevicePollAuthorized(database, completion()),
    { kind: "replayed", response: RESPONSE }
  );
  assert.equal(database.upserts, 0);
  assert.equal(database.state.credential, "winner-credential");
});

test("a completed record with an unbounded response is not replayed", async () => {
  const database = new MemoryDatabase();
  database.state = {
    completed: {
      envelope: {
        body: { access: "access-secret", status: "authorized" },
        kind: "plain_json",
      },
      status: 200,
    },
    credential: "winner-credential",
    fence: false,
  };

  assert.equal(
    await commitCredentialDevicePollAuthorized(database, completion()),
    "lost"
  );
  assert.equal(database.upserts, 0);
});
