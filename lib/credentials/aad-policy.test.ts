import assert from "node:assert/strict";
import test from "node:test";
import { credentialAadContextForWrite } from "./aad-policy";

test("credential AAD writes remain legacy-compatible until explicitly enabled", () => {
  const previous = process.env.CREDENTIAL_AAD_WRITES_ENABLED;
  delete process.env.CREDENTIAL_AAD_WRITES_ENABLED;

  try {
    assert.equal(credentialAadContextForWrite("acme", "copilot"), undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.CREDENTIAL_AAD_WRITES_ENABLED;
    } else {
      process.env.CREDENTIAL_AAD_WRITES_ENABLED = previous;
    }
  }
});

test("credential AAD writes bind tenant and harness after the rollout gate opens", () => {
  const previous = process.env.CREDENTIAL_AAD_WRITES_ENABLED;
  process.env.CREDENTIAL_AAD_WRITES_ENABLED = "true";

  try {
    assert.deepEqual(credentialAadContextForWrite("acme", "copilot"), {
      harnessId: "copilot",
      kind: "credential",
      tenant: "acme",
    });
  } finally {
    if (previous === undefined) {
      delete process.env.CREDENTIAL_AAD_WRITES_ENABLED;
    } else {
      process.env.CREDENTIAL_AAD_WRITES_ENABLED = previous;
    }
  }
});

test("credential AAD write gate rejects ambiguous configuration", () => {
  const previous = process.env.CREDENTIAL_AAD_WRITES_ENABLED;
  process.env.CREDENTIAL_AAD_WRITES_ENABLED = "1";

  try {
    assert.throws(
      () => credentialAadContextForWrite("acme", "copilot"),
      /CREDENTIAL_AAD_WRITES_ENABLED must be "true" or "false"/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.CREDENTIAL_AAD_WRITES_ENABLED;
    } else {
      process.env.CREDENTIAL_AAD_WRITES_ENABLED = previous;
    }
  }
});
