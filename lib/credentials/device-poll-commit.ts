import type { StoredIdempotencyResponse } from "../abuse/idempotency";
import {
  type SessionAuthority,
  sessionAuthorityMatches,
} from "../auth/session-revocation";
import type {
  CredentialDevicePollCommitInput,
  CredentialDevicePollCommitResult,
} from "./device-poll";

export interface CredentialDevicePollCommitTransaction<TCredential> {
  completeClaim: (
    input: CredentialDevicePollCommitInput<TCredential>
  ) => Promise<boolean>;
  currentTime: () => Date;
  findAuthorityForUpdate: (
    input: CredentialDevicePollCommitInput<TCredential>
  ) => Promise<SessionAuthority | null>;
  findClaimForUpdate: (
    input: CredentialDevicePollCommitInput<TCredential>
  ) => Promise<boolean>;
  findCompleted: (
    input: CredentialDevicePollCommitInput<TCredential>
  ) => Promise<StoredIdempotencyResponse | null>;
  upsertCredential: (
    input: CredentialDevicePollCommitInput<TCredential>
  ) => Promise<void>;
}

export interface CredentialDevicePollCommitDatabase<TCredential> {
  transaction: <T>(
    callback: (
      transaction: CredentialDevicePollCommitTransaction<TCredential>
    ) => Promise<T>
  ) => Promise<T>;
}

export async function commitCredentialDevicePollAuthorized<TCredential>(
  database: CredentialDevicePollCommitDatabase<TCredential>,
  input: CredentialDevicePollCommitInput<TCredential>
): Promise<CredentialDevicePollCommitResult> {
  assertAuthorizedResponse(input.response);

  return await database.transaction(async (transaction) => {
    if (!(await transaction.findClaimForUpdate(input))) {
      const completed = await transaction.findCompleted({
        ...input,
        completedAt: transaction.currentTime(),
      });
      return isAuthorizedResponse(completed)
        ? { kind: "replayed", response: completed }
        : "lost";
    }
    const authority = await transaction.findAuthorityForUpdate(input);
    const completedAt = transaction.currentTime();
    assertValidDate(completedAt);
    if (input.claim.claimExpiresAt.getTime() <= completedAt.getTime()) {
      return "lost";
    }
    if (
      !authority ||
      !sessionAuthorityMatches({
        database: authority,
        now: completedAt,
        tokenAuthVersion: input.authVersion,
      })
    ) {
      return "authority_lost";
    }

    const retentionMs = input.expiresAt.getTime() - input.completedAt.getTime();
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      throw new Error("Credential device-poll retention is invalid.");
    }
    const lockedCompletion = {
      ...input,
      completedAt,
      expiresAt: new Date(completedAt.getTime() + retentionMs),
    };
    await transaction.upsertCredential(lockedCompletion);
    if (!(await transaction.completeClaim(lockedCompletion))) {
      throw new Error(
        "Credential device-poll claim changed before completion."
      );
    }
    return "completed";
  });
}

function assertValidDate(value: Date): void {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Credential device-poll commit time is invalid.");
  }
}

function assertAuthorizedResponse(response: StoredIdempotencyResponse): void {
  if (!isAuthorizedResponse(response)) {
    throw new Error("Credential device-poll completion must be bounded.");
  }
}

function isAuthorizedResponse(
  response: StoredIdempotencyResponse | null
): response is StoredIdempotencyResponse {
  if (
    response?.status !== 200 ||
    response.envelope.kind !== "plain_json" ||
    typeof response.envelope.body !== "object" ||
    response.envelope.body === null ||
    Array.isArray(response.envelope.body)
  ) {
    return false;
  }

  const keys = Object.keys(response.envelope.body);
  return (
    keys.length === 1 &&
    keys[0] === "status" &&
    response.envelope.body.status === "authorized"
  );
}
