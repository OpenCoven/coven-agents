import {
  type IdempotencyClaimHandle,
  type IdempotencyCompleteInput,
  type IdempotencyCompletionResult,
  type IdempotencyResponse,
  type IdempotencyResult,
  type IdempotencyStore,
  runIdempotentOperation,
} from "../abuse/idempotency";
import type { DeviceExchange } from "./github-device";
import type { StoredCredential } from "./shape";

export const CREDENTIAL_DEVICE_POLL_RETENTION_MS = 20 * 60_000;
export const CREDENTIAL_DEVICE_POLL_OPERATION = "credential_device_poll";
const TRANSACTION_COMMIT_ATTEMPTS = 3;
const ERROR_CAUSE_DEPTH_LIMIT = 5;
const RETRYABLE_POSTGRES_CODES = new Set(["23505", "40001", "40P01"]);

type DevicePollExchange = DeviceExchange | { kind: "unavailable" };

export type CredentialDevicePollClaim = IdempotencyClaimHandle & {
  ownerToken: string;
  recordId: string;
};

export type CredentialDevicePollCommitInput<TCredential> =
  IdempotencyCompleteInput & {
    authVersion: number;
    claim: CredentialDevicePollClaim;
    credential: TCredential;
  };

export type CredentialDevicePollCommitResult =
  | IdempotencyCompletionResult
  | "authority_lost";

export interface CredentialDevicePollStore<TCredential>
  extends IdempotencyStore {
  commitAuthorized: (
    input: CredentialDevicePollCommitInput<TCredential>
  ) => Promise<CredentialDevicePollCommitResult>;
  renew: NonNullable<IdempotencyStore["renew"]>;
}

export async function runCredentialDevicePoll<TCredential>(input: {
  authVersion: number;
  deviceCode: string;
  exchange: () => Promise<DevicePollExchange>;
  idempotencyKey: string | null;
  ownerId: string;
  prepareCredential: (credential: StoredCredential) => Promise<TCredential>;
  revalidateAuthority: () => Promise<boolean>;
  store: CredentialDevicePollStore<TCredential>;
}): Promise<IdempotencyResult> {
  let preparedCredential: TCredential | undefined;

  try {
    return await runIdempotentOperation({
      claimLease: {},
      completeSuccessfulResponse: async (
        completion
      ): Promise<IdempotencyCompletionResult> => {
        if (preparedCredential === undefined) {
          throw new Error(
            "Credential device-poll completed without a prepared credential."
          );
        }
        const claim = exactCredentialDevicePollClaim(completion.claim);
        const result = await withTransactionRetry(() =>
          input.store.commitAuthorized({
            ...completion,
            authVersion: input.authVersion,
            claim,
            credential: preparedCredential as TCredential,
          })
        );
        if (result === "authority_lost") {
          throw new CredentialDevicePollAuthorityLostError();
        }
        return result;
      },
      idempotencyKey: input.idempotencyKey,
      operation: CREDENTIAL_DEVICE_POLL_OPERATION,
      ownerId: input.ownerId,
      perform: async (): Promise<IdempotencyResponse> => {
        const exchange = await input.exchange();
        if (exchange.kind === "unavailable") {
          return {
            body: { error: "github_unconfigured" },
            status: 503,
          };
        }
        if (!(await input.revalidateAuthority())) {
          return {
            body: { error: "subscription_required" },
            status: 403,
          };
        }
        if (exchange.kind !== "authorized") {
          return {
            body: { status: exchange.kind },
            status: 200,
          };
        }

        preparedCredential = await input.prepareCredential(exchange.credential);
        return {
          body: { status: "authorized" },
          status: 200,
        };
      },
      request: { deviceCode: input.deviceCode },
      retentionMs: CREDENTIAL_DEVICE_POLL_RETENTION_MS,
      shouldCacheResponse: ({ body }) =>
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        body.status === "authorized",
      store: input.store,
    });
  } catch (error) {
    if (error instanceof CredentialDevicePollAuthorityLostError) {
      return {
        kind: "response",
        replayed: false,
        response: {
          body: { error: "subscription_required" },
          status: 403,
        },
      };
    }
    return {
      kind: "response",
      replayed: false,
      response: {
        body: { error: "credential_storage_unavailable" },
        status: 503,
      },
    };
  }
}

class CredentialDevicePollAuthorityLostError extends Error {}

function exactCredentialDevicePollClaim(
  claim: IdempotencyClaimHandle
): CredentialDevicePollClaim {
  if (
    claim.operation !== CREDENTIAL_DEVICE_POLL_OPERATION ||
    typeof claim.ownerToken !== "string" ||
    !claim.ownerToken ||
    typeof claim.recordId !== "string" ||
    !claim.recordId
  ) {
    throw new Error("Credential device-poll claim is not exactly fenced.");
  }
  return claim as CredentialDevicePollClaim;
}

async function withTransactionRetry<T>(
  operation: () => Promise<T>,
  attemptsRemaining = TRANSACTION_COMMIT_ATTEMPTS
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (attemptsRemaining <= 1 || !isRetryableTransactionFailure(error)) {
      throw error;
    }
    return await withTransactionRetry(operation, attemptsRemaining - 1);
  }
}

function isRetryableTransactionFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;

  for (let depth = 0; depth < ERROR_CAUSE_DEPTH_LIMIT; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return false;
    }
    seen.add(current);
    if (
      "code" in current &&
      typeof current.code === "string" &&
      RETRYABLE_POSTGRES_CODES.has(current.code)
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
