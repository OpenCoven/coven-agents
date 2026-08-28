import assert from "node:assert/strict";
import test from "node:test";
import { base64UrlEncode } from "@opencoven/agent-contracts";
import { createIdentityMinter, IDENTITY_REFRESH_MARGIN_MS } from "./identity";

function tokenExpiringIn(seconds: number): string {
  const claims = {
    authVersion: 0,
    exp: Math.floor(Date.now() / 1000) + seconds,
    kid: "legacy",
    plan: "demo",
    sub: "user-1",
    tenant: "u_3f2504e04f8911d39a0c0305e82c3301",
  };
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );
  return `${payload}.signature-not-checked-here`;
}

function minterOver(tokens: string[]): {
  calls: () => number;
  mint: () => Promise<string>;
} {
  let calls = 0;
  const mint = createIdentityMinter((_input, _init) => {
    const token = tokens[Math.min(calls, tokens.length - 1)];
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ token }), { status: 200 })
    );
  });
  return { calls: () => calls, mint };
}

test("a freshly minted token is reused rather than re-minted", async () => {
  const { calls, mint } = minterOver([tokenExpiringIn(900)]);

  const first = await mint();
  const second = await mint();

  assert.equal(first, second);
  assert.equal(calls(), 1, "a valid token must not be re-minted");
});

test("run-scoped identities are bound in the mint request and never cached", async () => {
  const requests: Array<{ body?: string; headers?: Record<string, string> }> =
    [];
  const mint = createIdentityMinter((_input, init) => {
    requests.push(init ?? {});
    return Promise.resolve(
      Response.json({ token: tokenExpiringIn(900) }, { status: 200 })
    );
  });
  const run = {
    agentId: "11111111-1111-4111-8111-111111111111",
    harnessId: "copilot",
    operationId: "22222222-2222-4222-8222-222222222222",
  };

  await mint(run);
  await mint(run);

  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[0]?.body ?? "{}"), { run });
  assert.equal(requests[0]?.headers?.["content-type"], "application/json");
});

test("a token close to expiry is replaced before it is refused", async () => {
  // Refreshing only once expired would guarantee at least one 401 per token
  // lifetime, and that 401 would arrive mid-run.
  const nearlyExpired = tokenExpiringIn(
    Math.floor(IDENTITY_REFRESH_MARGIN_MS / 1000) - 5
  );
  const fresh = tokenExpiringIn(900);
  const { calls, mint } = minterOver([nearlyExpired, fresh]);

  const first = await mint();
  const second = await mint();

  assert.equal(first, nearlyExpired);
  assert.equal(second, fresh);
  assert.equal(calls(), 2);
});

test("an already expired token is never handed out", async () => {
  const expired = tokenExpiringIn(-60);
  const fresh = tokenExpiringIn(900);
  const { mint } = minterOver([expired, fresh]);

  await mint();
  const second = await mint();

  assert.equal(second, fresh);
});

test("a failed mint throws rather than yielding an empty token", async () => {
  // An empty string would be sent as `Bearer ` and read as a malformed token,
  // producing a confusing 401 instead of the real cause.
  const mint = createIdentityMinter(
    async () =>
      new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
  );

  await assert.rejects(() => mint(), /identity/i);
});

test("a response without a token throws", async () => {
  const mint = createIdentityMinter(
    async () => new Response(JSON.stringify({}), { status: 200 })
  );

  await assert.rejects(() => mint());
});

test("an unparseable token is not cached", async () => {
  // Caching something we cannot read the expiry of would pin a bad token
  // until reload.
  let calls = 0;
  const mint = createIdentityMinter(() => {
    calls += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ token: "not-a-token" }), { status: 200 })
    );
  });

  await assert.rejects(() => mint());
  await assert.rejects(() => mint());

  assert.equal(calls, 2, "a token that cannot be read must not be cached");
});
