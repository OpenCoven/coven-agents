import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import postgres from "postgres";
import { ownerBearerDigest } from "../runner/owner-credential";
import { tenantForUser } from "../session";

const url = process.env.OWNER_CREDENTIAL_TEST_URL;

test("scoped issuance persists only the digest and revocation takes effect on the next lookup", {
  skip: !url,
}, async () => {
  assert.ok(url && process.env.POSTGRES_URL === url);
  const {
    issueOwnerCredential,
    listOwnerCredentials,
    revokeOwnerCredential,
    findAuthorizedOwnerCredential,
  } = await import("./owner-credentials");
  const sql = postgres(url, { max: 1 });
  const userId = randomUUID();
  const agentId = randomUUID();
  const tenant = tenantForUser(userId);
  const owner = { authVersion: 0, tenant, userId };
  try {
    await sql`insert into "User" (id,email) values (${userId}, 'fixture@example.invalid')`;
    await sql`insert into "RunnerAgent" (id,tenant,name,instructions,model,runtime) values (${agentId},${tenant},'fixture','fixture','auto','copilot')`;
    const issued = await issueOwnerCredential(owner, agentId, ["run:read"]);
    assert.ok(issued);
    const digest = ownerBearerDigest(`Bearer ${issued.secret}`);
    assert.ok(digest);
    const [row] =
      await sql`select * from "RunnerOwnerCredential" where id = ${issued.id}`;
    assert.equal(row.digest, digest);
    assert.equal(JSON.stringify(row).includes(issued.secret), false);
    const [listed] = await listOwnerCredentials(owner, agentId);
    assert.equal("digest" in listed || "secret" in listed, false);
    const lookup = () =>
      findAuthorizedOwnerCredential(digest, "run:read", { agentId });
    assert.equal((await lookup())?.id, issued.id);
    assert.equal(
      await findAuthorizedOwnerCredential(digest, "run:start", { agentId }),
      null
    );
    assert.equal(
      await findAuthorizedOwnerCredential(digest, "run:read", {
        agentId: randomUUID(),
      }),
      null
    );
    await sql`update "User" set "authVersion"=1 where id=${userId}`;
    assert.equal(await lookup(), null);
    await sql`update "User" set "authVersion"=0 where id=${userId}`;
    assert.equal(await revokeOwnerCredential(owner, agentId, issued.id), true);
    assert.equal(await lookup(), null);
  } finally {
    await sql.end();
    const { db } = await import("./queries");
    await db.$client.end();
  }
});
