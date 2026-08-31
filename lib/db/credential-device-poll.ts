import "server-only";

import { and, eq, gt, sql } from "drizzle-orm";
import { sessionAuthorityMatches } from "@/lib/auth/session-revocation";
import type { databaseFor } from "@/lib/db/access";
import { tenantForUser } from "@/lib/session";
import { parseStoredIdempotencyResponseEnvelope } from "../abuse/idempotency-response";
import {
  CREDENTIAL_DEVICE_POLL_OPERATION,
  type CredentialDevicePollCommitInput,
} from "../credentials/device-poll";
import type { CredentialDevicePollCommitDatabase } from "../credentials/device-poll-commit";
import type { PreparedCredentialWrite } from "../credentials/store";
import { idempotencyRecord, tenantCredential, user } from "./schema";

type ProductionDatabase = ReturnType<typeof databaseFor>;
type CommitInput = CredentialDevicePollCommitInput<PreparedCredentialWrite>;

export function drizzleCredentialDevicePollDatabase(
  database: ProductionDatabase
): CredentialDevicePollCommitDatabase<PreparedCredentialWrite> {
  return {
    transaction: (callback) =>
      database.transaction(async (transaction) =>
        callback({
          async completeClaim(input) {
            const completed = await transaction
              .update(idempotencyRecord)
              .set({
                expiresAt: input.expiresAt,
                responseJson: input.response.envelope,
                responseStatus: input.response.status,
                state: "completed",
                updatedAt: input.completedAt,
              })
              .where(liveClaimFence(input))
              .returning({ id: idempotencyRecord.id });
            return completed.length === 1;
          },
          async findAuthorityForUpdate(input) {
            const [owner] = await transaction
              .select({
                authVersion: user.authVersion,
                subscribedUntil: user.subscribedUntil,
              })
              .from(user)
              .where(eq(user.id, input.claim.ownerId))
              .for("update")
              .limit(1);
            return Boolean(
              owner &&
                sessionAuthorityMatches({
                  database: owner,
                  now: input.completedAt,
                  tokenAuthVersion: input.authVersion,
                })
            );
          },
          async findClaimForUpdate(input) {
            const [claim] = await transaction
              .select({ id: idempotencyRecord.id })
              .from(idempotencyRecord)
              .where(liveClaimFence(input))
              .for("update")
              .limit(1);
            return claim !== undefined;
          },
          async findCompleted(input) {
            const [completed] = await transaction
              .select({
                responseJson: idempotencyRecord.responseJson,
                responseStatus: idempotencyRecord.responseStatus,
              })
              .from(idempotencyRecord)
              .where(
                and(
                  exactClaimScope(input),
                  eq(idempotencyRecord.state, "completed"),
                  gt(idempotencyRecord.expiresAt, input.completedAt),
                  sql`left(${idempotencyRecord.requestHash}, 64) = ${input.claim.requestHash}`
                )
              )
              .limit(1);
            if (
              completed?.responseJson === null ||
              completed?.responseJson === undefined ||
              completed.responseStatus === null ||
              completed.responseStatus === undefined
            ) {
              return null;
            }
            return {
              envelope: parseStoredIdempotencyResponseEnvelope(
                completed.responseJson
              ),
              status: completed.responseStatus,
            };
          },
          async upsertCredential(input) {
            assertCredentialOwner(input);
            const { credential } = input;
            await transaction
              .insert(tenantCredential)
              .values(credential)
              .onConflictDoUpdate({
                set: {
                  aadVersion: credential.aadVersion,
                  ciphertext: credential.ciphertext,
                  credentialRevision: credential.credentialRevision,
                  envelopeRevision: credential.envelopeRevision,
                  iv: credential.iv,
                  kekVersion: credential.kekVersion,
                  updatedAt: input.completedAt,
                  wrappedKey: credential.wrappedKey,
                },
                target: [tenantCredential.tenant, tenantCredential.harnessId],
              });
          },
        })
      ),
  };
}

function liveClaimFence(input: CommitInput) {
  return and(
    exactClaimScope(input),
    eq(idempotencyRecord.requestHash, storedIdempotencyClaimHash(input.claim)),
    eq(idempotencyRecord.state, "in_progress"),
    eq(idempotencyRecord.expiresAt, input.claim.claimExpiresAt),
    gt(idempotencyRecord.expiresAt, input.completedAt)
  );
}

function exactClaimScope(input: CommitInput) {
  return and(
    eq(idempotencyRecord.id, input.claim.recordId),
    eq(idempotencyRecord.ownerId, input.claim.ownerId),
    eq(idempotencyRecord.operation, input.claim.operation),
    eq(idempotencyRecord.keyHash, input.claim.keyHash)
  );
}

function storedIdempotencyClaimHash(input: {
  ownerToken: string;
  requestHash: string;
}): string {
  return `${input.requestHash}:${input.ownerToken}`;
}

function assertCredentialOwner(input: CommitInput): void {
  if (
    input.claim.operation !== CREDENTIAL_DEVICE_POLL_OPERATION ||
    input.credential.harnessId !== "copilot" ||
    input.credential.tenant !== tenantForUser(input.claim.ownerId)
  ) {
    throw new Error("Credential device-poll owner scope does not match.");
  }
}
