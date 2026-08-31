import type { StoredIdempotencyResponse } from "../abuse/idempotency";
import type {
  CredentialDevicePollCommitInput,
  CredentialDevicePollCommitResult,
} from "./device-poll";

export interface CredentialDevicePollCommitTransaction<TCredential> {
  completeClaim: (
    input: CredentialDevicePollCommitInput<TCredential>
  ) => Promise<boolean>;
  findAuthorityForUpdate: (
    input: CredentialDevicePollCommitInput<TCredential>
  ) => Promise<boolean>;
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
      const completed = await transaction.findCompleted(input);
      return isAuthorizedResponse(completed)
        ? { kind: "replayed", response: completed }
        : "lost";
    }
    if (!(await transaction.findAuthorityForUpdate(input))) {
      return "authority_lost";
    }

    await transaction.upsertCredential(input);
    if (!(await transaction.completeClaim(input))) {
      throw new Error(
        "Credential device-poll claim changed before completion."
      );
    }
    return "completed";
  });
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
