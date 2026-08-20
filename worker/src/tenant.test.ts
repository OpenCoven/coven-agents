import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertTenantId,
  sandboxKey,
  TenantKeyError,
  tenantOf,
  UNOWNED_TENANT,
} from "./tenant";

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

test("two tenants never share a sandbox for the same agent id", () => {
  const agentId = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
  assert.notEqual(sandboxKey("alice", agentId), sandboxKey("bob", agentId));
});

test("the same tenant and agent always resolve to one key", () => {
  const agentId = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
  assert.equal(sandboxKey("alice", agentId), sandboxKey("alice", agentId));
});

test("a tenant id cannot be crafted to forge another tenant's key", () => {
  // `-` is the separator, so allowing it would make `a` + `b-c` collide with
  // `a-b` + `c`. The rejection is what keeps the encoding unambiguous.
  const error = caught(() => sandboxKey("alice-bob", "c"));
  assert.ok(error instanceof TenantKeyError);
  assert.equal(error.code, "invalid_tenant_id");
});

test("an empty or oversized tenant id is refused rather than collapsed", () => {
  assert.ok(caught(() => assertTenantId("")) instanceof TenantKeyError);
  assert.ok(
    caught(() => assertTenantId("a".repeat(65))) instanceof TenantKeyError
  );
  assert.equal(assertTenantId("a".repeat(64)), "a".repeat(64));
});

test("a definition stored before ownership resolves to the unowned tenant", () => {
  assert.equal(tenantOf({}), UNOWNED_TENANT);
  assert.equal(tenantOf({ owner: null }), UNOWNED_TENANT);
  assert.equal(tenantOf({ owner: "alice" }), "alice");
});

test("a missing owner never collapses onto another tenant", () => {
  const agentId = "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90";
  assert.notEqual(
    sandboxKey(tenantOf({ owner: null }), agentId),
    sandboxKey(tenantOf({ owner: "alice" }), agentId)
  );
});

test("create and destroy derive the identical key from one definition", () => {
  // The regression this guards: `decommission` previously rebuilt the key by
  // hand, so a change at the create site could silently destroy a different
  // tenant's container.
  const definition = {
    id: "3f1a0f4e-1f4d-4a2e-9c1b-7d2f5a6b8c90",
    owner: "alice",
  };
  const created = sandboxKey(tenantOf(definition), definition.id);
  const destroyed = sandboxKey(tenantOf(definition), definition.id);
  assert.equal(created, destroyed);
  assert.ok(created.includes("alice"));
});

/**
 * The tests above prove the helper is correct; they cannot prove the worker
 * calls it, because `getSandbox` is a bare module import with no seam to stub.
 * A mutation that reverted `decommission` to a hand-built key left all of them
 * passing. This asserts the property that actually matters — that no agent
 * sandbox key is built anywhere except through `sandboxKey` — against the
 * source itself, which is the only oracle available without a refactor.
 */
test("no sandbox key is hand-built outside the helper", () => {
  const sources = ["agents.ts", "index.ts"];
  for (const name of sources) {
    const source = readFileSync(new URL(name, import.meta.url), "utf8");
    const handBuilt = source.match(/getSandbox\([^)]*`[^`]*\$\{/gs);
    assert.equal(
      handBuilt,
      null,
      `${name} interpolates a sandbox key inline; route it through sandboxKey() instead.`
    );
  }
});
