# Tenant Identity and Credential Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every caller a verified tenant identity and its own harness credential, so no customer can ever execute as the owner.

**Architecture:** The Next app holds an Ed25519 private key and mints a short-lived signed token carrying `{ sub, tenant, plan, exp }`. The worker holds only the public key, verifies offline, and uses the verified `tenant` claim as `callerTenant`. Harness credentials move from Worker secrets to a per-tenant encrypted store that the app owns; the worker borrows one credential per run over an internal service call. A demo session is a signed cookie with no database row, and the database handle is typed so a demo session cannot obtain one.

**Tech Stack:** Next.js 16, Cloudflare Workers, Drizzle + Postgres, Zod, WebCrypto (Ed25519, AES-GCM, AES-KW), `tsx --test` with `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-24-tenant-identity-and-credential-isolation-design.md`

---

## Design decisions this plan locks in

**Tokens are not JWTs.** The token is `base64url(payload).base64url(signature)`
with Ed25519 hardcoded. JWT's algorithm-confusion attacks (`alg: none`,
HS256-for-RS256 substitution) exist because a JWT declares its own algorithm.
A fixed format with one algorithm cannot express that attack. Both ends are
ours, so JWT interop buys nothing, and this needs no new dependency in either
runtime.

**The two tokens use different headers.** `Authorization: Bearer <identity
token>` carries identity. The retained deployment gate moves to
`X-Runner-Token`. They cannot share a header, and identity belongs in the
standard one.

**Verify before parse.** Signature is checked over the raw payload segment
bytes before the payload is decoded or trusted. Expiry is checked after
parsing. Never the other way round.

## File structure

| File | Responsibility |
| --- | --- |
| `packages/agent-contracts/src/identity.ts` (create) | Claims schema, base64url helpers, token encode/decode. Shared by app and worker so both agree on the format. |
| `lib/agents/runner-token.ts` (create) | Mints a token. App side only; holds the private key. |
| `app/api/runner-token/route.ts` (create) | Session-authenticated mint endpoint. |
| `worker/src/identity.ts` (create) | Verifies a token with the public key. No minting capability. |
| `worker/src/routes.ts` (modify) | `callerTenant` from claims; runner token moves to `X-Runner-Token`. |
| `lib/db/schema.ts` (modify) | `tenantCredential` table. |
| `lib/credentials/envelope.ts` (create) | Envelope encryption: per-tenant DEK wrapped by a KEK. |
| `lib/credentials/store.ts` (create) | Read/write/delete a tenant credential. |
| `app/api/credentials/route.ts` (create) | Tenant sets or clears their own credential. |
| `app/api/internal/credential/route.ts` (create) | Service-token-only decrypt-for-one-tenant endpoint. |
| `worker/src/tenant-credentials.ts` (create) | Worker-side client for the internal endpoint. |
| `worker/src/harness-runner.ts` (modify) | `requireHarness` takes a resolved credential, never `env`. |
| `lib/session.ts` (create) | `DemoSession \| SubscriberSession`, and `database()` typed to reject demo. |

---

### Task 1: Shared token format

**Files:**
- Create: `packages/agent-contracts/src/identity.ts`
- Create: `packages/agent-contracts/src/identity.test.ts`
- Modify: `packages/agent-contracts/src/index.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/agent-contracts/src/identity.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlDecode,
  base64UrlEncode,
  runnerClaimsSchema,
  splitToken,
} from "./identity";

test("base64url round-trips bytes without padding", () => {
  const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
  const encoded = base64UrlEncode(bytes);

  assert.ok(!encoded.includes("="), "must not be padded");
  assert.ok(!encoded.includes("+") && !encoded.includes("/"), "url safe");
  assert.deepEqual(base64UrlDecode(encoded), bytes);
});

test("claims reject anything the worker must not trust", () => {
  const valid = {
    exp: 1_800_000_000,
    plan: "subscriber",
    sub: "user-1",
    tenant: "acme",
  };
  assert.equal(runnerClaimsSchema.parse(valid).tenant, "acme");

  for (const bad of [
    { ...valid, plan: "admin" },
    { ...valid, tenant: "" },
    { ...valid, exp: -1 },
    { ...valid, extra: "smuggled" },
  ]) {
    assert.throws(
      () => runnerClaimsSchema.parse(bad),
      `expected ${JSON.stringify(bad)} to be rejected`
    );
  }
});

test("a token without exactly two segments is refused", () => {
  assert.equal(splitToken("only-one-segment"), null);
  assert.equal(splitToken("a.b.c"), null);
  assert.equal(splitToken(""), null);

  const parts = splitToken("payload.signature");
  assert.deepEqual(parts, { payload: "payload", signature: "signature" });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @opencoven/agent-contracts exec tsx --test src/identity.test.ts`
Expected: FAIL — `Cannot find module './identity'`

- [ ] **Step 3: Write the implementation**

```ts
// packages/agent-contracts/src/identity.ts
import { z } from "zod";

/**
 * Deliberately not a JWT. A JWT declares its own algorithm, which is the root
 * of the `alg: none` and HS256-for-RS256 substitution attacks. This format has
 * one hardcoded algorithm (Ed25519) and no algorithm field, so that class of
 * attack cannot be expressed. Both ends are ours; JWT interop buys nothing.
 */
export const TOKEN_ALGORITHM = "Ed25519";

/** Fifteen minutes. Expiry is the revocation mechanism; there is no list. */
export const TOKEN_LIFETIME_SECONDS = 900;

export const runnerClaimsSchema = z
  .object({
    exp: z.number().int().positive(),
    plan: z.enum(["demo", "subscriber"]),
    sub: z.string().min(1).max(128),
    tenant: z.string().min(1).max(64),
  })
  .strict();

export type RunnerClaims = z.infer<typeof runnerClaimsSchema>;

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** Null rather than throwing, so callers cannot forget to handle bad input. */
export function splitToken(
  token: string
): { payload: string; signature: string } | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  if (!payload || !signature) {
    return null;
  }
  return { payload, signature };
}
```

- [ ] **Step 4: Export it**

Add to `packages/agent-contracts/src/index.ts`:

```ts
export {
  base64UrlDecode,
  base64UrlEncode,
  type RunnerClaims,
  runnerClaimsSchema,
  splitToken,
  TOKEN_ALGORITHM,
  TOKEN_LIFETIME_SECONDS,
} from "./identity";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @opencoven/agent-contracts exec tsx --test src/identity.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 6: Commit**

```bash
git add packages/agent-contracts/src/identity.ts packages/agent-contracts/src/identity.test.ts packages/agent-contracts/src/index.ts
git commit -S -m "feat(contracts): add the shared runner identity token format"
```

---

### Task 2: Worker-side verification

**Files:**
- Create: `worker/src/identity.ts`
- Create: `worker/src/identity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// worker/src/identity.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  base64UrlEncode,
  type RunnerClaims,
  TOKEN_LIFETIME_SECONDS,
} from "@opencoven/agent-contracts";
import { verifyRunnerToken } from "./identity";

async function keyPair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function mint(
  privateKey: CryptoKey,
  claims: RunnerClaims
): Promise<string> {
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(payload)
  );
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function claims(overrides: Partial<RunnerClaims> = {}): RunnerClaims {
  return {
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
    plan: "subscriber",
    sub: "user-1",
    tenant: "acme",
    ...overrides,
  };
}

test("a token signed by the matching key verifies", async () => {
  const pair = await keyPair();
  const token = await mint(pair.privateKey, claims());

  const result = await verifyRunnerToken(token, pair.publicKey);

  assert.equal(result?.tenant, "acme");
  assert.equal(result?.plan, "subscriber");
});

test("a token signed by a different key is refused", async () => {
  const signer = await keyPair();
  const other = await keyPair();
  const token = await mint(signer.privateKey, claims({ tenant: "victim" }));

  assert.equal(await verifyRunnerToken(token, other.publicKey), null);
});

test("tampering with the payload invalidates the signature", async () => {
  const pair = await keyPair();
  const token = await mint(pair.privateKey, claims({ tenant: "acme" }));
  const forged = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims({ tenant: "victim" })))
  );

  const tampered = `${forged}.${token.split(".")[1]}`;

  assert.equal(await verifyRunnerToken(tampered, pair.publicKey), null);
});

test("an expired token is refused even though the signature is good", async () => {
  const pair = await keyPair();
  const token = await mint(
    pair.privateKey,
    claims({ exp: Math.floor(Date.now() / 1000) - 1 })
  );

  assert.equal(await verifyRunnerToken(token, pair.publicKey), null);
});

test("a malformed token is refused without throwing", async () => {
  const pair = await keyPair();

  for (const bad of ["", "no-dot", "a.b.c", "!!!.???"]) {
    assert.equal(
      await verifyRunnerToken(bad, pair.publicKey),
      null,
      `expected ${JSON.stringify(bad)} to be refused`
    );
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/identity.test.ts`
Expected: FAIL — `Cannot find module './identity'`

- [ ] **Step 3: Write the implementation**

```ts
// worker/src/identity.ts
import {
  base64UrlDecode,
  type RunnerClaims,
  runnerClaimsSchema,
  splitToken,
  TOKEN_ALGORITHM,
} from "@opencoven/agent-contracts";

/**
 * Verifies an identity token. The worker holds only a public key, so it can
 * check a claim and cannot manufacture one — a worker compromise does not
 * become impersonation.
 *
 * Returns null for every failure rather than throwing, so no caller can
 * accidentally treat "verification errored" as "verification passed".
 */
export async function verifyRunnerToken(
  token: string,
  publicKey: CryptoKey
): Promise<RunnerClaims | null> {
  const parts = splitToken(token);
  if (!parts) {
    return null;
  }

  let signatureValid = false;
  try {
    // Signature is checked over the raw payload segment, before the payload is
    // decoded or trusted in any way.
    signatureValid = await crypto.subtle.verify(
      { name: TOKEN_ALGORITHM },
      publicKey,
      base64UrlDecode(parts.signature),
      new TextEncoder().encode(parts.payload)
    );
  } catch {
    return null;
  }
  if (!signatureValid) {
    return null;
  }

  let parsed: RunnerClaims;
  try {
    parsed = runnerClaimsSchema.parse(
      JSON.parse(new TextDecoder().decode(base64UrlDecode(parts.payload)))
    );
  } catch {
    return null;
  }

  if (parsed.exp <= Math.floor(Date.now() / 1000)) {
    return null;
  }

  return parsed;
}

/** Imports the deployment's verify key. There is no import for a signing key. */
export async function importVerifyKey(spki: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "spki",
    base64UrlDecode(spki),
    { name: TOKEN_ALGORITHM },
    false,
    ["verify"]
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/identity.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Mutation-test the expiry check**

Temporarily change `if (parsed.exp <= Math.floor(Date.now() / 1000))` to `if (false)`.

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/identity.test.ts`
Expected: FAIL — "an expired token is refused even though the signature is good"

Restore the line. Re-run. Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add worker/src/identity.ts worker/src/identity.test.ts
git commit -S -m "feat(worker): verify runner identity tokens with a public key only"
```

---

### Task 3: Wire the verified tenant into routing

**Files:**
- Modify: `worker/src/routes.ts`
- Modify: `worker/src/routes.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `worker/src/routes.test.ts`:

```ts
test("the caller tenant comes from the verified claim, not the runner token", async () => {
  const runner = createCloudRunner(deps());
  const request = new Request("https://runner.test/api/agents", {
    headers: {
      authorization: `Bearer ${await mintTestToken({ tenant: "acme" })}`,
      "x-runner-token": TEST_RUNNER_TOKEN,
    },
  });

  const response = await runner.fetch(request, testEnv());

  assert.equal(response.status, 200);
  assert.deepEqual(listedTenants(), ["acme"]);
});

test("a request with a valid runner token but no identity is refused", async () => {
  const runner = createCloudRunner(deps());
  const request = new Request("https://runner.test/api/agents", {
    headers: { "x-runner-token": TEST_RUNNER_TOKEN },
  });

  const response = await runner.fetch(request, testEnv());

  assert.equal(response.status, 401);
});

test("a valid identity without the deployment gate is refused", async () => {
  const runner = createCloudRunner(deps());
  const request = new Request("https://runner.test/api/agents", {
    headers: {
      authorization: `Bearer ${await mintTestToken({ tenant: "acme" })}`,
    },
  });

  const response = await runner.fetch(request, testEnv());

  assert.equal(response.status, 401);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/routes.test.ts`
Expected: FAIL — the first test lists `UNOWNED_TENANT`, not `acme`

- [ ] **Step 3: Replace the deployment gate and the hardcoded tenant**

In `worker/src/routes.ts`, replace the `hasValidBearerToken` block and the
`callerTenant` assignment with:

```ts
        // The deployment gate. It proves the caller may reach this worker at
        // all; it never says who they are. Moved off `Authorization` so the
        // standard header can carry identity.
        if (
          !hasValidHeaderToken(
            request,
            "x-runner-token",
            environment.AGENT_CONTROL_TOKEN ?? ""
          )
        ) {
          return json(
            errorEnvelope("unauthorized", "Runner token was rejected.", false),
            { status: 401 },
            cors
          );
        }

        const bearer = request.headers.get("authorization");
        const claims = bearer?.startsWith("Bearer ")
          ? await verifyRunnerToken(
              bearer.slice(7),
              await getVerifyKey(environment)
            )
          : null;

        if (!claims) {
          return json(
            errorEnvelope("unauthorized", "Identity was rejected.", false),
            { status: 401 },
            cors
          );
        }

        const callerTenant = claims.tenant;
```

- [ ] **Step 4: Add the header-token helper**

In `worker/src/http.ts`, beside `hasValidBearerToken`:

```ts
export function hasValidHeaderToken(
  request: Request,
  header: string,
  expectedToken: string
): boolean {
  const supplied = request.headers.get(header);
  if (!supplied || !expectedToken) {
    return false;
  }
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(expectedToken);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @opencoven/cloud-runner test`
Expected: PASS, all route tests

- [ ] **Step 6: Commit**

```bash
git add worker/src/routes.ts worker/src/routes.test.ts worker/src/http.ts
git commit -S -m "feat(worker): derive the caller tenant from a verified identity claim"
```

---

### Task 4: Mint tokens in the app

**Files:**
- Create: `lib/agents/runner-token.ts`
- Create: `lib/agents/runner-token.test.ts`
- Create: `app/api/runner-token/route.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/agents/runner-token.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { splitToken } from "@opencoven/agent-contracts";
import { mintRunnerToken } from "./runner-token";

const PRIVATE_KEY_PKCS8 = process.env.TEST_RUNNER_PRIVATE_KEY ?? "";

test("a minted token has two segments and the requested claims", async () => {
  const token = await mintRunnerToken(
    { plan: "subscriber", sub: "user-1", tenant: "acme" },
    PRIVATE_KEY_PKCS8
  );

  const parts = splitToken(token);
  assert.ok(parts, "token must split into payload and signature");

  const payload = JSON.parse(
    Buffer.from(parts.payload, "base64url").toString("utf8")
  );
  assert.equal(payload.tenant, "acme");
  assert.equal(payload.plan, "subscriber");
  assert.ok(payload.exp > Math.floor(Date.now() / 1000));
});

test("minting refuses a tenant the claims schema would reject", async () => {
  await assert.rejects(() =>
    mintRunnerToken(
      { plan: "subscriber", sub: "user-1", tenant: "" },
      PRIVATE_KEY_PKCS8
    )
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test lib/agents/runner-token.test.ts`
Expected: FAIL — `Cannot find module './runner-token'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/agents/runner-token.ts
import {
  base64UrlDecode,
  base64UrlEncode,
  type RunnerClaims,
  runnerClaimsSchema,
  TOKEN_ALGORITHM,
  TOKEN_LIFETIME_SECONDS,
} from "@opencoven/agent-contracts";

type MintInput = Omit<RunnerClaims, "exp">;

/**
 * Mints an identity token. This is the only place a token can be created, and
 * it lives with the private key. The worker has no equivalent.
 */
export async function mintRunnerToken(
  input: MintInput,
  privateKeyPkcs8: string
): Promise<string> {
  const claims = runnerClaimsSchema.parse({
    ...input,
    exp: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
  });

  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64UrlDecode(privateKeyPkcs8),
    { name: TOKEN_ALGORITHM },
    false,
    ["sign"]
  );

  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(claims))
  );
  const signature = await crypto.subtle.sign(
    { name: TOKEN_ALGORITHM },
    key,
    new TextEncoder().encode(payload)
  );

  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}
```

- [ ] **Step 4: Add the mint endpoint**

```ts
// app/api/runner-token/route.ts
import { auth } from "@/app/(auth)/auth";
import { mintRunnerToken } from "@/lib/agents/runner-token";
import { tenantForUser } from "@/lib/session";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const privateKey = process.env.RUNNER_SIGNING_KEY;
  if (!privateKey) {
    return Response.json({ error: "signing_unavailable" }, { status: 503 });
  }

  const token = await mintRunnerToken(
    {
      plan: session.user.type === "subscriber" ? "subscriber" : "demo",
      sub: session.user.id,
      tenant: tenantForUser(session.user.id),
    },
    privateKey
  );

  return Response.json({ token });
}
```

- [ ] **Step 5: Generate a test key and run the tests**

```bash
node -e '
const { subtle } = require("node:crypto").webcrypto;
subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]).then(async (k) => {
  const pkcs8 = Buffer.from(await subtle.exportKey("pkcs8", k.privateKey)).toString("base64url");
  const spki = Buffer.from(await subtle.exportKey("spki", k.publicKey)).toString("base64url");
  console.log("RUNNER_SIGNING_KEY=" + pkcs8);
  console.log("RUNNER_VERIFY_KEY=" + spki);
});'
```

Put `RUNNER_SIGNING_KEY` in `.env.local`, and export the same value as
`TEST_RUNNER_PRIVATE_KEY` when running the test.

Run: `TEST_RUNNER_PRIVATE_KEY=<pkcs8> pnpm exec tsx --test lib/agents/runner-token.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 6: Commit**

```bash
git add lib/agents/runner-token.ts lib/agents/runner-token.test.ts app/api/runner-token/route.ts
git commit -S -m "feat(app): mint short-lived runner identity tokens"
```

---

### Task 5: Session types that make the database ban a compile error

**Files:**
- Create: `lib/session.ts`
- Create: `lib/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/session.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { isSubscriber, tenantForUser, toSession } from "./session";

test("a demo session carries a synthetic tenant and no user id", () => {
  const session = toSession(null);

  assert.equal(session.kind, "demo");
  assert.ok(session.tenant.startsWith("demo:"));
  assert.equal(isSubscriber(session), false);
});

test("a subscriber session carries the real tenant", () => {
  const session = toSession({ id: "user-1", type: "subscriber" });

  assert.equal(session.kind, "subscriber");
  assert.equal(session.tenant, tenantForUser("user-1"));
  assert.equal(isSubscriber(session), true);
});

test("a signed-in non-subscriber is still a demo session", () => {
  // Being logged in is not the same as having paid. Only the subscriber plan
  // may reach the database.
  const session = toSession({ id: "user-2", type: "demo" });

  assert.equal(session.kind, "demo");
  assert.equal(isSubscriber(session), false);
});

test("every demo session gets a distinct tenant", () => {
  const tenants = new Set(
    Array.from({ length: 50 }, () => toSession(null).tenant)
  );

  assert.equal(tenants.size, 50, "demo tenants must not collide");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test lib/session.test.ts`
Expected: FAIL — `Cannot find module './session'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/session.ts

/**
 * Two session shapes, deliberately not one shape with a boolean.
 *
 * `database()` below accepts only `SubscriberSession`, so a demo code path
 * that tries to persist fails to compile rather than failing code review. The
 * rule stops depending on anyone remembering it. This mirrors
 * `worker/src/tenant.ts`, where an unhandled owner kind is a compile error.
 */
export type DemoSession = {
  kind: "demo";
  tenant: string;
};

export type SubscriberSession = {
  kind: "subscriber";
  tenant: string;
  userId: string;
};

export type Session = DemoSession | SubscriberSession;

export function tenantForUser(userId: string): string {
  return `user:${userId}`;
}

export function toSession(
  user: { id: string; type: string } | null
): Session {
  if (user && user.type === "subscriber") {
    return {
      kind: "subscriber",
      tenant: tenantForUser(user.id),
      userId: user.id,
    };
  }
  return { kind: "demo", tenant: `demo:${crypto.randomUUID()}` };
}

export function isSubscriber(session: Session): session is SubscriberSession {
  return session.kind === "subscriber";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec tsx --test lib/session.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add lib/session.ts lib/session.test.ts
git commit -S -m "feat(app): model demo and subscriber sessions as distinct types"
```

---

### Task 6: Type the database handle so demo cannot obtain one

**Files:**
- Modify: `lib/db/queries.ts`
- Create: `lib/db/access.ts`
- Create: `lib/db/access.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/db/access.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { toSession } from "@/lib/session";
import { databaseFor } from "./access";

test("a subscriber session yields a database handle", () => {
  const session = toSession({ id: "user-1", type: "subscriber" });

  assert.ok(databaseFor(session));
});

test("a demo session is refused at runtime as well as at compile time", () => {
  // The type system is the primary guard. This asserts the runtime backstop
  // for callers that reach here through an `any` or a JSON boundary.
  const demo = toSession(null);

  assert.throws(
    // biome-ignore lint/suspicious/noExplicitAny: deliberately defeating the type guard
    () => databaseFor(demo as any),
    /demo session/i
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test lib/db/access.test.ts`
Expected: FAIL — `Cannot find module './access'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/db/access.ts
import type { SubscriberSession } from "@/lib/session";
import { db } from "./queries";

/**
 * The only way to obtain a database handle.
 *
 * The parameter type is the enforcement: a `DemoSession` does not satisfy
 * `SubscriberSession`, so a demo path that tries to persist does not compile.
 * The runtime check exists only for callers that arrive through `any` or a
 * deserialised boundary, where the type has already been erased.
 */
export function databaseFor(session: SubscriberSession): typeof db {
  if (session.kind !== "subscriber") {
    throw new Error(
      "A demo session must never reach the database. This is a bug in the caller."
    );
  }
  return db;
}
```

- [ ] **Step 4: Export `db` from queries**

`lib/db/queries.ts:37` currently reads `const db = drizzle(client);` — it is
module-private. Add the export keyword:

```ts
export const db = drizzle(client);
```

This is the only place the raw handle is created. Everything else must go
through `databaseFor`, so resist the temptation to import `db` directly in new
code — a direct import bypasses the session type and therefore the ban.

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec tsx --test lib/db/access.test.ts`
Expected: PASS, 2 tests

- [ ] **Step 6: Prove the compile-time guard works**

Create a scratch file `/tmp/demo-write-check.ts`:

```ts
import { databaseFor } from "@/lib/db/access";
import { toSession } from "@/lib/session";

databaseFor(toSession(null));
```

Run: `pnpm exec tsc --noEmit /tmp/demo-write-check.ts`
Expected: FAIL — `Argument of type 'Session' is not assignable to parameter of type 'SubscriberSession'`

Delete the scratch file. This is the guarantee; if it ever compiles, the ban is gone.

- [ ] **Step 7: Commit**

```bash
git add lib/db/access.ts lib/db/access.test.ts lib/db/queries.ts
git commit -S -m "feat(db): make a demo session unable to obtain a database handle"
```

---

### Task 7: The tenant credential table

**Files:**
- Modify: `lib/db/schema.ts`
- Create: `lib/db/migrations/` (generated)

- [ ] **Step 1: Add the table**

In `lib/db/schema.ts`, after the `user` table:

```ts
export const tenantCredential = pgTable("TenantCredential", {
  ciphertext: text("ciphertext").notNull(),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  harnessId: varchar("harnessId", { length: 32 }).notNull(),
  id: uuid("id").primaryKey().notNull().defaultRandom(),
  iv: text("iv").notNull(),
  tenant: varchar("tenant", { length: 64 }).notNull(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
  wrappedKey: text("wrappedKey").notNull(),
});

export type TenantCredential = InferSelectModel<typeof tenantCredential>;
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: a new file under `lib/db/migrations/`

- [ ] **Step 3: Apply it**

Run: `pnpm db:migrate`
Expected: `Migrations completed in <n> ms`

- [ ] **Step 4: Verify the table exists**

Run: `docker exec coven-pg psql -U postgres -d coven -c '\dt'`
Expected: `TenantCredential` appears in the list

- [ ] **Step 5: Commit**

```bash
git add lib/db/schema.ts lib/db/migrations
git commit -S -m "feat(db): add the per-tenant credential table"
```

---

### Task 8: Envelope encryption

**Files:**
- Create: `lib/credentials/envelope.ts`
- Create: `lib/credentials/envelope.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/credentials/envelope.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { decryptCredential, encryptCredential, generateKek } from "./envelope";

test("a credential round-trips through encrypt and decrypt", async () => {
  const kek = await generateKek();

  const sealed = await encryptCredential("ghp_secret_value", kek);
  const opened = await decryptCredential(sealed, kek);

  assert.equal(opened, "ghp_secret_value");
});

test("the plaintext never appears in the stored envelope", async () => {
  const kek = await generateKek();

  const sealed = await encryptCredential("ghp_secret_value", kek);

  const serialized = JSON.stringify(sealed);
  assert.ok(!serialized.includes("ghp_secret_value"));
  assert.ok(!serialized.includes("secret"));
});

test("each credential gets its own data key", async () => {
  const kek = await generateKek();

  const first = await encryptCredential("same-value", kek);
  const second = await encryptCredential("same-value", kek);

  assert.notEqual(first.wrappedKey, second.wrappedKey);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("a wrong KEK cannot open the envelope", async () => {
  const sealed = await encryptCredential("ghp_secret_value", await generateKek());

  await assert.rejects(() => decryptCredential(sealed, await generateKek()));
});

test("tampering with the ciphertext is detected", async () => {
  const kek = await generateKek();
  const sealed = await encryptCredential("ghp_secret_value", kek);

  const flipped = Buffer.from(sealed.ciphertext, "base64url");
  flipped[0] ^= 0xff;

  await assert.rejects(() =>
    decryptCredential(
      { ...sealed, ciphertext: flipped.toString("base64url") },
      kek
    )
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test lib/credentials/envelope.test.ts`
Expected: FAIL — `Cannot find module './envelope'`

- [ ] **Step 3: Write the implementation**

```ts
// lib/credentials/envelope.ts
import { base64UrlDecode, base64UrlEncode } from "@opencoven/agent-contracts";

export type SealedCredential = {
  ciphertext: string;
  iv: string;
  wrappedKey: string;
};

/**
 * Envelope encryption: a fresh data key per credential, wrapped by one key
 * encryption key. Rotating the KEK is then a rewrap of small values rather
 * than re-encrypting every credential, and revoking one tenant is deleting
 * one row.
 *
 * AES-GCM is authenticated, so tampering is detected on decrypt rather than
 * producing garbage plaintext.
 */
export async function generateKek(): Promise<CryptoKey> {
  return await crypto.subtle.generateKey({ length: 256, name: "AES-KW" }, true, [
    "wrapKey",
    "unwrapKey",
  ]);
}

export async function importKek(raw: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    base64UrlDecode(raw),
    { name: "AES-KW" },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

export async function encryptCredential(
  plaintext: string,
  kek: CryptoKey
): Promise<SealedCredential> {
  const dek = await crypto.subtle.generateKey(
    { length: 256, name: "AES-GCM" },
    true,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { iv, name: "AES-GCM" },
    dek,
    new TextEncoder().encode(plaintext)
  );
  const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, "AES-KW");

  return {
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    iv: base64UrlEncode(iv),
    wrappedKey: base64UrlEncode(new Uint8Array(wrapped)),
  };
}

export async function decryptCredential(
  sealed: SealedCredential,
  kek: CryptoKey
): Promise<string> {
  const dek = await crypto.subtle.unwrapKey(
    "raw",
    base64UrlDecode(sealed.wrappedKey),
    kek,
    "AES-KW",
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );

  const plaintext = await crypto.subtle.decrypt(
    { iv: base64UrlDecode(sealed.iv), name: "AES-GCM" },
    dek,
    base64UrlDecode(sealed.ciphertext)
  );

  return new TextDecoder().decode(plaintext);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec tsx --test lib/credentials/envelope.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add lib/credentials/envelope.ts lib/credentials/envelope.test.ts
git commit -S -m "feat(credentials): envelope-encrypt tenant credentials"
```

---

### Task 9: The internal credential endpoint

**Files:**
- Create: `lib/credentials/store.ts`
- Create: `app/api/internal/credential/route.ts`
- Create: `app/api/internal/credential/route.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/api/internal/credential/route.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { authorizeInternalRequest } from "./route";

test("a request without the service token is refused", () => {
  const request = new Request("https://app.test/api/internal/credential", {
    body: JSON.stringify({ harnessId: "copilot", tenant: "acme" }),
    method: "POST",
  });

  assert.equal(authorizeInternalRequest(request, "service-secret"), false);
});

test("a browser session cannot substitute for the service token", () => {
  const request = new Request("https://app.test/api/internal/credential", {
    headers: { cookie: "authjs.session-token=anything" },
    method: "POST",
  });

  assert.equal(authorizeInternalRequest(request, "service-secret"), false);
});

test("the matching service token is accepted", () => {
  const request = new Request("https://app.test/api/internal/credential", {
    headers: { "x-service-token": "service-secret" },
    method: "POST",
  });

  assert.equal(authorizeInternalRequest(request, "service-secret"), true);
});

test("an empty configured token never authorizes", () => {
  const request = new Request("https://app.test/api/internal/credential", {
    headers: { "x-service-token": "" },
    method: "POST",
  });

  assert.equal(authorizeInternalRequest(request, ""), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test "app/api/internal/credential/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Write the store**

```ts
// lib/credentials/store.ts
import { and, eq } from "drizzle-orm";
import { databaseFor } from "@/lib/db/access";
import { tenantCredential } from "@/lib/db/schema";
import type { SubscriberSession } from "@/lib/session";
import {
  decryptCredential,
  encryptCredential,
  importKek,
  type SealedCredential,
} from "./envelope";

function kek(): Promise<CryptoKey> {
  const raw = process.env.CREDENTIAL_KEK;
  if (!raw) {
    throw new Error("CREDENTIAL_KEK is not configured.");
  }
  return importKek(raw);
}

export async function putCredential(
  session: SubscriberSession,
  harnessId: string,
  plaintext: string
): Promise<void> {
  const sealed = await encryptCredential(plaintext, await kek());
  const db = databaseFor(session);

  await db
    .insert(tenantCredential)
    .values({ ...sealed, harnessId, tenant: session.tenant })
    .onConflictDoUpdate({
      set: { ...sealed, updatedAt: new Date() },
      target: [tenantCredential.tenant, tenantCredential.harnessId],
    });
}

/**
 * Reads and decrypts one credential for one tenant. There is no bulk read and
 * no "all credentials" query anywhere in this module, deliberately.
 */
export async function readCredentialForTenant(
  tenant: string,
  harnessId: string,
  db: ReturnType<typeof databaseFor>
): Promise<string | null> {
  const [row] = await db
    .select()
    .from(tenantCredential)
    .where(
      and(
        eq(tenantCredential.tenant, tenant),
        eq(tenantCredential.harnessId, harnessId)
      )
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const sealed: SealedCredential = {
    ciphertext: row.ciphertext,
    iv: row.iv,
    wrappedKey: row.wrappedKey,
  };
  return await decryptCredential(sealed, await kek());
}
```

- [ ] **Step 4: Write the endpoint**

```ts
// app/api/internal/credential/route.ts
import { readCredentialForTenant } from "@/lib/credentials/store";
import { db } from "@/lib/db/queries";

/**
 * Service-token only. There is deliberately no session-authenticated path
 * here: a credential must never be reachable from a browser.
 */
export function authorizeInternalRequest(
  request: Request,
  expected: string
): boolean {
  const supplied = request.headers.get("x-service-token");
  if (!supplied || !expected || supplied.length !== expected.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function POST(request: Request) {
  if (
    !authorizeInternalRequest(request, process.env.RUNNER_SERVICE_TOKEN ?? "")
  ) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await request.json()) as {
    harnessId?: string;
    tenant?: string;
  };
  if (!body.tenant || !body.harnessId) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const credential = await readCredentialForTenant(
    body.tenant,
    body.harnessId,
    db
  );
  if (!credential) {
    return Response.json({ error: "no_credential" }, { status: 404 });
  }

  return Response.json({ credential });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec tsx --test "app/api/internal/credential/route.test.ts"`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add lib/credentials/store.ts app/api/internal/credential
git commit -S -m "feat(credentials): lend one tenant credential per run over a service call"
```

---

### Task 10: The worker fetches the tenant credential

**Files:**
- Create: `worker/src/tenant-credentials.ts`
- Create: `worker/src/tenant-credentials.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// worker/src/tenant-credentials.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { fetchTenantCredential } from "./tenant-credentials";

function respondWith(status: number, body: unknown) {
  return async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify(body), { status });
}

test("a stored credential is returned", async () => {
  const credential = await fetchTenantCredential(
    { harnessId: "copilot", tenant: "acme" },
    {
      endpoint: "https://app.test",
      fetchImpl: respondWith(200, { credential: "ghp_abc" }),
      serviceToken: "svc",
    }
  );

  assert.equal(credential, "ghp_abc");
});

test("a tenant with no credential yields null, not an error", async () => {
  const credential = await fetchTenantCredential(
    { harnessId: "copilot", tenant: "acme" },
    {
      endpoint: "https://app.test",
      fetchImpl: respondWith(404, { error: "no_credential" }),
      serviceToken: "svc",
    }
  );

  assert.equal(credential, null);
});

test("an unreachable app fails closed rather than returning null", async () => {
  await assert.rejects(() =>
    fetchTenantCredential(
      { harnessId: "copilot", tenant: "acme" },
      {
        endpoint: "https://app.test",
        fetchImpl: async () => {
          throw new Error("network down");
        },
        serviceToken: "svc",
      }
    )
  );
});

test("the service token is sent and the tenant is not taken from the caller", async () => {
  let seen: RequestInit | undefined;

  await fetchTenantCredential(
    { harnessId: "copilot", tenant: "acme" },
    {
      endpoint: "https://app.test",
      fetchImpl: async (_url, init) => {
        seen = init;
        return new Response(JSON.stringify({ credential: "x" }), {
          status: 200,
        });
      },
      serviceToken: "svc",
    }
  );

  const headers = new Headers(seen?.headers);
  assert.equal(headers.get("x-service-token"), "svc");
  assert.deepEqual(JSON.parse(String(seen?.body)), {
    harnessId: "copilot",
    tenant: "acme",
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/tenant-credentials.test.ts`
Expected: FAIL — `Cannot find module './tenant-credentials'`

- [ ] **Step 3: Write the implementation**

```ts
// worker/src/tenant-credentials.ts
export type CredentialRequest = {
  harnessId: string;
  tenant: string;
};

export type CredentialTransport = {
  endpoint: string;
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  serviceToken: string;
};

/**
 * Borrows one credential for one tenant, for the duration of one run.
 *
 * The worker holds no key encryption key and stores nothing, so a compromise
 * here yields only credentials for runs actively executing — never the store.
 *
 * A missing credential is `null` (the tenant has not configured one). A
 * transport failure throws, because "we could not ask" must never be confused
 * with "there is none", and must never fall through to another credential.
 */
export async function fetchTenantCredential(
  request: CredentialRequest,
  transport: CredentialTransport
): Promise<string | null> {
  const response = await transport.fetchImpl(
    `${transport.endpoint}/api/internal/credential`,
    {
      body: JSON.stringify({
        harnessId: request.harnessId,
        tenant: request.tenant,
      }),
      headers: {
        "content-type": "application/json",
        "x-service-token": transport.serviceToken,
      },
      method: "POST",
    }
  );

  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Credential lookup failed with status ${response.status}.`
    );
  }

  const body = (await response.json()) as { credential?: unknown };
  return typeof body.credential === "string" ? body.credential : null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/tenant-credentials.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add worker/src/tenant-credentials.ts worker/src/tenant-credentials.test.ts
git commit -S -m "feat(worker): borrow a tenant credential for the duration of a run"
```

---

### Task 11: Invert credential resolution and fail closed

**Files:**
- Modify: `worker/src/harness-runner.ts`
- Modify: `worker/src/harness-runner.test.ts`

This is the task that closes the violation. It must land with Task 13.

- [ ] **Step 1: Write the failing test**

Add to `worker/src/harness-runner.test.ts`:

```ts
test("owner deployment secrets can never satisfy a tenant credential", () => {
  // The single most important test in this change. If it passes because the
  // run succeeded, tenant isolation is gone.
  const ownerEnv = {
    COPILOT_GITHUB_TOKEN: "owner-token",
    GH_TOKEN: "owner-token",
    GITHUB_TOKEN: "owner-token",
  };

  assert.throws(
    () => requireHarness("copilot", { credential: null, env: ownerEnv }),
    (error: unknown) =>
      error instanceof HarnessError && error.code === "harness_unauthenticated"
  );
});

test("a tenant credential is used verbatim", () => {
  const { auth } = requireHarness("copilot", {
    credential: "tenant-token",
    env: {},
  });

  assert.equal(auth.value, "tenant-token");
  assert.equal(auth.name, "COPILOT_GITHUB_TOKEN");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/harness-runner.test.ts`
Expected: FAIL — `requireHarness` still reads `env` and returns the owner token

- [ ] **Step 3: Change the signature**

In `worker/src/harness-runner.ts`, replace the `requireHarness` credential
lookup:

```ts
export type HarnessCredential = {
  /** The tenant's credential, or null when they have configured none. */
  credential: string | null;
  /**
   * Retained only so the shape matches the sandbox env builder. It is never
   * consulted for authentication — see the test that sets every owner secret
   * and still expects a refusal.
   */
  env: Record<string, string | undefined>;
};

export function requireHarness(
  runtime: string,
  supplied: HarnessCredential
): { auth: { name: string; value: string }; spec: HarnessSpec } {
  const spec = harnessSpec(runtime);
  if (!spec) {
    throw new HarnessError(`Unknown harness: ${runtime}`, "unknown_harness");
  }
  if (!spec.supported) {
    throw new HarnessError(
      `${spec.label} is detected but its event translation is not implemented yet. Use one of: ${HARNESS_SPECS.filter(
        (candidate) => candidate.supported
      )
        .map((candidate) => candidate.id)
        .join(", ")}.`,
      "harness_unsupported"
    );
  }

  const value = supplied.credential?.trim();
  if (!value) {
    throw new HarnessError(harnessAuthHint(spec), "harness_unauthenticated");
  }

  // The env var name still comes from the spec, but the value only ever comes
  // from the tenant. `resolveHarnessAuth` is intentionally not called here.
  const name = spec.authEnvVars[0];
  if (!name) {
    throw new HarnessError(harnessAuthHint(spec), "harness_unauthenticated");
  }

  return { auth: { name, value }, spec };
}
```

- [ ] **Step 4: Delete the owner-secret interface**

Remove `HarnessEnv` from `worker/src/harness-runner.ts` and every import of it.
If the type is referenced anywhere else, the build will say so.

Run: `pnpm --filter @opencoven/cloud-runner typecheck`
Expected: errors listing every remaining reference. Fix each by threading the
tenant credential instead.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @opencoven/cloud-runner test`
Expected: PASS

- [ ] **Step 6: Mutation-test the isolation guarantee**

Temporarily restore a fallback in `requireHarness`:

```ts
const value =
  supplied.credential?.trim() ?? supplied.env.COPILOT_GITHUB_TOKEN;
```

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/harness-runner.test.ts`
Expected: FAIL — "owner deployment secrets can never satisfy a tenant credential"

Restore the correct implementation. Re-run. Expected: PASS.

If that mutation does **not** fail the suite, stop. The test is not actually
guarding the property and must be fixed before continuing.

- [ ] **Step 7: Commit**

```bash
git add worker/src/harness-runner.ts worker/src/harness-runner.test.ts
git commit -S -m "feat(worker): resolve harness credentials per tenant, fail closed"
```

---

### Task 12: Redact the credential from run evidence

**Files:**
- Modify: `worker/src/agents.ts`
- Modify: `worker/src/agents.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `worker/src/agents.test.ts`:

```ts
test("a harness that echoes its own credential does not leak it into evidence", () => {
  // The realistic failure. A CLI printing its auth header in a debug line is
  // entirely ordinary, and that output is streamed into stored run evidence.
  const output = "debug: using authorization Bearer ghp_tenant_secret_value";

  const sanitized = sanitizeEvidenceText(output, ["ghp_tenant_secret_value"]);

  assert.ok(!sanitized.includes("ghp_tenant_secret_value"));
  assert.ok(sanitized.includes("debug: using authorization"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @opencoven/cloud-runner exec tsx --test src/agents.test.ts`
Expected: FAIL if `sanitizeEvidenceText` is not yet imported in this file

- [ ] **Step 3: Thread the credential into sanitisation**

In `worker/src/agents.ts`, where run output becomes evidence, pass the
credential as an additional secret. `sanitizeEvidenceText` already accepts
`additionalSecrets`:

```ts
import { sanitizeEvidenceText } from "@opencoven/agent-contracts";

// …where run stdout/stderr is converted to evidence:
const safeStdout = sanitizeEvidenceText(run.stdout, [auth.value]);
const safeStderr = sanitizeEvidenceText(run.stderr, [auth.value]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @opencoven/cloud-runner test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/src/agents.ts worker/src/agents.test.ts
git commit -S -m "feat(worker): redact tenant credentials from run evidence"
```

---

### Task 13: Delete the owner secrets from the deployment

**Files:**
- Modify: `worker/src/worker-secrets.d.ts`
- Modify: `worker/wrangler.jsonc`

This is the point of no return. It must land together with Task 11.

- [ ] **Step 1: Remove the type declarations**

In `worker/src/worker-secrets.d.ts`, delete `COPILOT_GITHUB_TOKEN`,
`GH_TOKEN`, `GITHUB_TOKEN`, `CODEX_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`.

Add in their place:

```ts
  /**
   * Harness credentials are per tenant and are fetched at run time. They are
   * deliberately absent from this deployment: a forbidden fallback survives
   * refactors, an absent one cannot.
   */
  RUNNER_SERVICE_TOKEN?: string;
  RUNNER_VERIFY_KEY?: string;
  APP_ORIGIN?: string;
```

- [ ] **Step 2: Verify nothing still reads them**

Run: `grep -rn "COPILOT_GITHUB_TOKEN\|GH_TOKEN\|GITHUB_TOKEN\|CODEX_API_KEY\|CLAUDE_CODE_OAUTH_TOKEN" worker/src`
Expected: matches only inside `packages/harness` spec data (`authEnvVars`,
which names the variable for the sandbox) and inside tests that assert
refusal. No match may be a credential *read* in worker source.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Delete the live secrets**

```bash
cd worker
npx wrangler secret delete COPILOT_GITHUB_TOKEN
npx wrangler secret delete GH_TOKEN
npx wrangler secret delete GITHUB_TOKEN
npx wrangler secret list
```

Expected: none of the three appear in the listing.

- [ ] **Step 5: Add the new deployment secrets**

```bash
npx wrangler secret put RUNNER_VERIFY_KEY      # the spki value from Task 4
npx wrangler secret put RUNNER_SERVICE_TOKEN   # shared with the app
npx wrangler secret put APP_ORIGIN             # https://<your app origin>
```

- [ ] **Step 6: Commit**

```bash
git add worker/src/worker-secrets.d.ts worker/wrangler.jsonc
git commit -S -m "feat(worker): remove owner harness secrets from the deployment"
```

---

### Task 14: Replace guest auth with a stateless demo session

**Files:**
- Modify: `app/(auth)/auth.ts`
- Delete: `app/(auth)/api/auth/guest/route.ts`
- Modify: `proxy.ts`
- Modify: `lib/ai/entitlements.ts`

- [ ] **Step 1: Write the failing test**

```ts
// lib/ai/entitlements.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { entitlementsByPlan } from "./entitlements";

test("every plan has an entitlement and demo is the most limited", () => {
  assert.ok(entitlementsByPlan.demo);
  assert.ok(entitlementsByPlan.subscriber);
  assert.ok(
    entitlementsByPlan.demo.maxMessagesPerHour <
      entitlementsByPlan.subscriber.maxMessagesPerHour
  );
});

test("demo cannot run a harness", () => {
  assert.equal(entitlementsByPlan.demo.canRunHarness, false);
  assert.equal(entitlementsByPlan.subscriber.canRunHarness, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec tsx --test lib/ai/entitlements.test.ts`
Expected: FAIL — `entitlementsByPlan` is not exported

- [ ] **Step 3: Rewrite entitlements**

```ts
// lib/ai/entitlements.ts
import type { RunnerClaims } from "@opencoven/agent-contracts";

type Entitlements = {
  canRunHarness: boolean;
  maxMessagesPerHour: number;
};

export const entitlementsByPlan: Record<RunnerClaims["plan"], Entitlements> = {
  demo: {
    canRunHarness: false,
    maxMessagesPerHour: 5,
  },
  subscriber: {
    canRunHarness: true,
    maxMessagesPerHour: 200,
  },
};
```

- [ ] **Step 4: Remove the guest provider**

In `app/(auth)/auth.ts`, delete the `Credentials({ id: "guest", … })` provider
and the `createGuestUser` import. Change `UserType`:

```ts
export type UserType = "demo" | "subscriber";
```

Delete `app/(auth)/api/auth/guest/route.ts`.

- [ ] **Step 5: Make the proxy issue a stateless demo cookie**

In `proxy.ts`, replace the redirect to guest auth:

```ts
  if (!token) {
    // A demo visitor gets a signed cookie and no database row. The previous
    // guest provider wrote a User row per anonymous visitor; one redirect loop
    // during local testing produced 81 of them.
    const response = NextResponse.next();
    response.cookies.set("coven-demo", crypto.randomUUID(), {
      httpOnly: true,
      path: "/",
      sameSite: "lax",
      secure: !isDevelopmentEnvironment,
    });
    return response;
  }
```

- [ ] **Step 6: Verify no anonymous visit writes a row**

```bash
docker exec coven-pg psql -U postgres -d coven -tAc 'select count(*) from "User";'
for i in $(seq 1 20); do curl -s -o /dev/null http://localhost:3001/; done
docker exec coven-pg psql -U postgres -d coven -tAc 'select count(*) from "User";'
```

Expected: the two counts are identical.

- [ ] **Step 7: Commit**

```bash
git add app/\(auth\)/auth.ts proxy.ts lib/ai/entitlements.ts lib/ai/entitlements.test.ts
git rm app/\(auth\)/api/auth/guest/route.ts
git commit -S -m "feat(auth): replace guest rows with a stateless demo session"
```

---

### Task 15: End-to-end verification

**Files:**
- Create: `worker/src/isolation.test.ts`

- [ ] **Step 1: Write the cross-cutting test**

```ts
// worker/src/isolation.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { HarnessError, requireHarness } from "./harness-runner";
import { verifyRunnerToken } from "./identity";

test("no combination of owner secrets and a valid identity yields a run", () => {
  const ownerEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: "owner",
    CODEX_API_KEY: "owner",
    COPILOT_GITHUB_TOKEN: "owner",
    GH_TOKEN: "owner",
    GITHUB_TOKEN: "owner",
  };

  assert.throws(
    () => requireHarness("copilot", { credential: null, env: ownerEnv }),
    (error: unknown) =>
      error instanceof HarnessError && error.code === "harness_unauthenticated"
  );
});

test("one tenant's credential is never reachable from another's claim", async () => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;

  const forged = "eyJ0ZW5hbnQiOiJ2aWN0aW0ifQ.c2lnbmF0dXJl";

  assert.equal(await verifyRunnerToken(forged, pair.publicKey), null);
});
```

- [ ] **Step 2: Run the full gate**

```bash
pnpm check
pnpm typecheck
pnpm test:unit
pnpm build
```

Expected: all pass.

- [ ] **Step 3: Confirm the deployment has no owner secrets**

```bash
cd worker && npx wrangler secret list
```

Expected: `RUNNER_VERIFY_KEY`, `RUNNER_SERVICE_TOKEN`, `APP_ORIGIN`,
`AGENT_CONTROL_TOKEN`. No harness credential of any kind.

- [ ] **Step 4: Commit**

```bash
git add worker/src/isolation.test.ts
git commit -S -m "test(worker): pin tenant credential isolation end to end"
```

---

## Self-review against the spec

**Spec coverage**

| Spec requirement | Task |
| --- | --- |
| Ed25519, worker holds verify key only | 1, 2 |
| Claims shape, 15-minute expiry | 1 |
| `callerTenant` from the verified claim | 3 |
| `AGENT_CONTROL_TOKEN` retained as a gate, not identity | 3 |
| Envelope encryption, per-tenant DEK | 8 |
| App is sole custodian; worker borrows per run | 9, 10 |
| Credential never returned to a browser | 9 |
| Credential redacted from run evidence | 12 |
| `requireHarness` never consults `env` | 11 |
| Owner secrets deleted from the deployment | 13 |
| Stateless demo session, no `User` row | 14 |
| Database ban is a compile error | 6 |
| Entitlements become demo/subscriber | 14 |
| Mutation-tested security properties | 2, 11 |

**Deferred by the spec, and therefore absent here:** Stripe and how
`user.type` becomes `"subscriber"` (spec 3), fixture replay for demo mode
(spec 2), and per-harness support for injected credentials — Task 11 assumes an
injectable token and refuses where the harness cannot accept one, which is the
correct behaviour until spec 2 resolves it.

**Ordering constraint:** Tasks 11 and 13 must land together. Between them the
guarantee is a rule; after 13 it is a fact about the deployment.
