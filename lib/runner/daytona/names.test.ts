import assert from "node:assert/strict";
import test from "node:test";
import {
  daytonaRunCredentialPath,
  daytonaRunSessionName,
  daytonaSandboxLabels,
  daytonaSandboxName,
  daytonaSessionName,
} from "./names";

const tenant = "private_tenant";
const agentId = "00000000-0000-4000-8000-000000000001";

test("Daytona sandbox names are deterministic, legal, and tenant-private", () => {
  const name = daytonaSandboxName(tenant, agentId);
  assert.equal(name, daytonaSandboxName(tenant, agentId));
  assert.match(name, /^[a-z0-9-]{3,63}$/u);
  assert.equal(name.includes(tenant), false);
  assert.notEqual(name, daytonaSandboxName(`${tenant}x`, agentId));
  assert.match(daytonaSessionName(tenant, agentId), /^[a-z0-9-]{3,63}$/u);
});

test("Daytona process session and credential names are run UUID deterministic", () => {
  const runId = "53af1a29-4e98-43d6-ac5b-3b9dcba5e730";
  assert.equal(daytonaRunSessionName(runId), `coven-run-${runId}`);
  assert.equal(
    daytonaRunCredentialPath(runId),
    `/tmp/coven-run-${runId}.credential`
  );
  assert.throws(() => daytonaRunSessionName("../unsafe"), /UUID run id/u);
});

test("Daytona labels retain only the UUID and a tenant digest", () => {
  const labels = daytonaSandboxLabels(tenant, agentId);
  assert.deepEqual(Object.keys(labels).sort(), [
    "agentId",
    "app",
    "tenantDigest",
  ]);
  assert.equal(labels.agentId, agentId);
  assert.equal(labels.app, "coven-agents");
  assert.match(labels.tenantDigest, /^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(labels).includes(tenant), false);
});
