import "server-only";
import {
  and,
  arrayContains,
  desc,
  eq,
  gt,
  isNull,
  lte,
  sql,
} from "drizzle-orm";
import {
  issueOwnerSecret,
  type OwnerCredentialScope,
  ownerCredentialLifetimeMs,
} from "../runner/owner-credential";
import { db } from "./queries";
import {
  runnerOwnerCredential as credential,
  runnerAgent,
  runnerRun,
  user,
} from "./schema";

type Owner = { tenant: string; userId: string; authVersion: number };

const metadata = {
  agentId: credential.agentId,
  expiresAt: credential.expiresAt,
  id: credential.id,
  issuedAt: credential.issuedAt,
  revokedAt: credential.revokedAt,
  scopes: credential.scopes,
};

function owned(owner: Owner, agentId: string) {
  return and(
    eq(credential.userId, owner.userId),
    eq(credential.tenant, owner.tenant),
    eq(credential.agentId, agentId)
  );
}

export function listOwnerCredentials(owner: Owner, agentId: string) {
  return db
    .select(metadata)
    .from(credential)
    .where(owned(owner, agentId))
    .orderBy(desc(credential.issuedAt));
}

export async function revokeOwnerCredential(
  owner: Owner,
  agentId: string,
  id: string
) {
  const rows = await db
    .update(credential)
    .set({
      revokedAt: sql`coalesce(${credential.revokedAt}, clock_timestamp())`,
    })
    .where(and(owned(owner, agentId), eq(credential.id, id)))
    .returning({ id: credential.id });
  return rows.length === 1;
}

export function issueOwnerCredential(
  owner: Owner,
  agentId: string,
  scopes: OwnerCredentialScope[]
) {
  return db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: runnerAgent.id })
      .from(runnerAgent)
      .innerJoin(
        user,
        and(eq(user.id, owner.userId), eq(user.authVersion, owner.authVersion))
      )
      .where(
        and(eq(runnerAgent.id, agentId), eq(runnerAgent.tenant, owner.tenant))
      )
      .for("share");
    if (!agent) {
      return null;
    }
    const issuedAt = new Date();
    const { secret, digest } = issueOwnerSecret();
    const [record] = await tx
      .insert(credential)
      .values({
        ...owner,
        agentId,
        digest,
        expiresAt: new Date(issuedAt.getTime() + ownerCredentialLifetimeMs),
        issuedAt,
        scopes,
      })
      .returning(metadata);
    return { ...record, secret };
  });
}

type Target = { agentId: string } | { runId: string };

function activeWithScope(scope: OwnerCredentialScope) {
  return and(
    arrayContains(credential.scopes, [scope]),
    isNull(credential.revokedAt),
    lte(credential.issuedAt, sql`clock_timestamp()`),
    gt(credential.expiresAt, sql`clock_timestamp()`)
  );
}

export async function mayDispatchOwnerRun(
  id: string,
  agentId: string,
  tenant: string,
  authVersion: number
) {
  const [record] = await db
    .select({ id: credential.id })
    .from(credential)
    .innerJoin(
      user,
      and(
        eq(user.id, credential.userId),
        eq(user.authVersion, credential.authVersion)
      )
    )
    .where(
      and(
        eq(credential.id, id),
        eq(credential.agentId, agentId),
        eq(credential.tenant, tenant),
        eq(credential.authVersion, authVersion),
        activeWithScope("run:start")
      )
    );
  return Boolean(record);
}

export async function findAuthorizedOwnerCredential(
  digest: string,
  scope: OwnerCredentialScope,
  target: Target
) {
  const targetMatches =
    "agentId" in target
      ? eq(credential.agentId, target.agentId)
      : sql`exists (select 1 from ${runnerRun} where ${runnerRun.id} = ${target.runId} and ${runnerRun.agentId} = ${credential.agentId} and ${runnerRun.tenant} = ${credential.tenant})`;
  const [record] = await db
    .select({
      authVersion: credential.authVersion,
      email: user.email,
      id: credential.id,
      tenant: credential.tenant,
      userId: credential.userId,
    })
    .from(credential)
    .innerJoin(
      user,
      and(
        eq(user.id, credential.userId),
        eq(user.authVersion, credential.authVersion)
      )
    )
    .where(
      and(eq(credential.digest, digest), activeWithScope(scope), targetMatches)
    );
  return record ?? null;
}
